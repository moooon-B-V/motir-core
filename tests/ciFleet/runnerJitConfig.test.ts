import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunnerJitApiError,
  RunnerRegistrationRateLimitedError,
  runnerJitConfigClient,
} from '@/lib/github/runnerJitConfig';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';

// The JIT-CONFIG boundary (Story MOTIR-1916 · MOTIR-1921) — the wire, at the
// level the service above it cannot reach. Sibling of
// `runnerGroupClient.test.ts`, and the same harness: no database, `fetch` is the
// only fake.
//
// The assertions that matter here are the ones the card names as acceptance
// criteria: WHAT the mint request carries (the project's group, the single
// label) and WHICH refusals are retryable. A 403 that means "you are going too
// fast" and a 403 that means "your App lacks the permission" demand opposite
// responses, and getting that wrong turns a burst into an outage or a
// misconfiguration into an infinite retry.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let handler: (call: Call) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The requests that are the client's own, not the App-auth handshake. */
function runnerCalls(): Call[] {
  return calls.filter((c) => c.url.includes('/actions/runners'));
}

/** GitHub's own success shape: the runner row comes back ALREADY REGISTERED,
 *  which is the §7.4 finding the whole de-registration path exists for. */
function mintSuccess(runnerId = 9001): Response {
  return json(201, {
    runner: { id: runnerId, name: 'motir-intent-1', os: 'linux', status: 'offline', busy: false },
    encoded_jit_config: 'eyJhZ2VudCI6ICJtb3RpciJ9',
  });
}

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return handler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('mint — a JIT config, scoped at MINT time', () => {
  it('names the project runner group and EXACTLY the one fleet label', async () => {
    // The card's acceptance criterion, asserted on the request the client makes:
    // "minted with a JIT config naming the project's `runner_group_id` and the
    // single fleet label". Both are §7.3/§7.4 in one call — the group scoping is
    // applied by the orchestrator at mint rather than trusted to the container.
    handler = () => mintSuccess();

    const config = await runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });

    expect(config).toEqual({
      runnerId: 9001,
      runnerName: 'motir-intent-1',
      encodedJitConfig: 'eyJhZ2VudCI6ICJtb3RpciJ9',
    });

    const mint = runnerCalls()[0]!;
    expect(mint.method).toBe('POST');
    expect(mint.url).toBe(
      `https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/generate-jitconfig`,
    );
    expect(mint.body).toEqual({
      name: 'motir-intent-1',
      runner_group_id: 5042,
      labels: [MOTIR_RUNNER_LABEL],
      work_folder: '_work',
    });
    // NOT the `Default` group (id 1, `visibility: all`) — §7.3's forbidden
    // fallback, which would silently restore cross-tenant pickup.
    expect(mint.body?.['runner_group_id']).not.toBe(1);
  });

  it('NO registration token is minted anywhere on this path', async () => {
    // The card's acceptance criterion stated as an absence: §7.4 replaced the
    // registration token, and an absence is only enforceable by asserting it.
    handler = () => mintSuccess();
    await runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });
    expect(calls.some((c) => c.url.includes('registration-token'))).toBe(false);
  });

  it('carries the provisioning App installation token', async () => {
    handler = () => mintSuccess();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await runnerJitConfigClient.mint({
      name: 'r',
      runnerGroupId: 7,
      labels: [MOTIR_RUNNER_LABEL],
    });
    const mintCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([url]) => String(url).includes('generate-jitconfig'),
    );
    const headers = mintCall?.[1].headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ghs_provisioning');
  });

  it('refuses a 201 whose shape it cannot read, rather than returning half a config', async () => {
    // WORSE than a refusal: GitHub has registered a runner we cannot name, so we
    // could not de-register it either. Failing loudly is what makes that
    // reachable by the reconciliation instead of invisible.
    handler = () => json(201, { runner: { name: 'x' } });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toBeInstanceOf(RunnerJitApiError);
  });

  it('refuses a 201 with no encoded config', async () => {
    handler = () => json(201, { runner: { id: 5 }, encoded_jit_config: '' });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toBeInstanceOf(RunnerJitApiError);
  });

  it('falls back to the requested name when GitHub echoes none', async () => {
    handler = () => json(201, { runner: { id: 12 }, encoded_jit_config: 'abc' });
    const config = await runnerJitConfigClient.mint({
      name: 'motir-fallback',
      runnerGroupId: 7,
      labels: [MOTIR_RUNNER_LABEL],
    });
    expect(config.runnerName).toBe('motir-fallback');
  });

  it('surfaces a plain refusal as the typed API error with its status', async () => {
    handler = () => json(422, { message: 'Runner group not found' });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 999, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toMatchObject({ code: 'RUNNER_JIT_API_FAILED', status: 422 });
  });

  it('normalizes a transport failure to the typed error with a null status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
          return json(200, { id: Number(INSTALLATION_ID) });
        }
        if (String(url).includes('/access_tokens')) {
          return json(200, {
            token: 'ghs_provisioning',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        throw new Error('ECONNRESET');
      }),
    );
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toMatchObject({ code: 'RUNNER_JIT_API_FAILED', status: null });
  });
});

describe('the registration ceiling is a TYPED, RETRYABLE refusal — not an opaque 4xx', () => {
  it('a 403 with `retry-after` is the rate limit, and says how long', async () => {
    // The card: "surface it as a typed, retryable refusal rather than an opaque
    // 4xx". GitHub reports a secondary limit as 403 or 429 with a `retry-after`.
    handler = () =>
      json(
        403,
        { message: 'You have exceeded a secondary rate limit' },
        {
          'retry-after': '30',
        },
      );
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerRegistrationRateLimitedError);
    expect(err).toMatchObject({ retryable: true, status: 403, retryAfterSeconds: 30 });
  });

  it('a 429 with an exhausted remaining budget is the rate limit too', async () => {
    handler = () => json(429, { message: 'Too many requests' }, { 'x-ratelimit-remaining': '0' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerRegistrationRateLimitedError);
    expect(err).toMatchObject({ retryAfterSeconds: null });
  });

  it('a PLAIN 403 is NOT retryable — a missing permission must fail loudly', async () => {
    // The distinction that matters: treating a permissions failure as retryable
    // would make a misconfigured App retry forever instead of failing on the
    // first job, and the fleet would look slow rather than unwired.
    handler = () => json(403, { message: 'Resource not accessible by integration' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJitApiError);
    expect(err).not.toBeInstanceOf(RunnerRegistrationRateLimitedError);
  });

  it('ignores a non-numeric `retry-after` rather than reporting NaN seconds', async () => {
    handler = () => json(403, { message: 'nope' }, { 'retry-after': 'soon' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJitApiError);
  });
});

describe('deleteRunner — the dangling-JIT cleanup', () => {
  it('de-registers by id', async () => {
    handler = () => new Response(null, { status: 204 });
    await runnerJitConfigClient.deleteRunner(9001);
    const call = runnerCalls()[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe(`https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/9001`);
  });

  it('treats a 404 as the desired end state — the HAPPY path', async () => {
    // An ephemeral runner de-registers ITSELF when its one job finishes, so 404
    // is what a successful run looks like from here. Throwing on it would make
    // every good run log an error.
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerJitConfigClient.deleteRunner(9001)).resolves.toBeUndefined();
  });

  it('surfaces a real refusal', async () => {
    handler = () => json(500, { message: 'Server Error' });
    await expect(runnerJitConfigClient.deleteRunner(9001)).rejects.toMatchObject({
      code: 'RUNNER_JIT_API_FAILED',
      status: 500,
    });
  });
});
