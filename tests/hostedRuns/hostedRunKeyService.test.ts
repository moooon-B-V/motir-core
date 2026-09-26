import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { HostedRunKeyNotMintedError } from '@/lib/hostedRuns/errors';
import { HOSTED_RUN_TIMEOUT_MS } from '@/lib/hostedRuns/limits';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';

// THE HOSTED RUN'S GATEWAY WIRING (MOTIR-689) — mint and revoke the per-run key
// against motir-gateway's `POST/DELETE /api/motir/run-keys` contract
// (`controller/motir_run_key.go`). The gateway is an external service across the
// open-core boundary, so `fetch` is the seam stubbed here — exactly as every
// motir-ai client test stubs it.

const GATEWAY = 'https://gateway.test';
const SECRET = 'mint-secret-value';
const STARTED = new Date('2026-09-26T12:00:00.000Z');
const NOW = new Date('2026-09-26T12:01:00.000Z');
const RUN = { id: 'run_abc', organizationId: 'org_1', startedAt: STARTED };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function minted(overrides: Record<string, unknown> = {}): Response {
  return json(
    {
      key: 'sk-run-key-1',
      runRef: RUN.id,
      coreOrganizationId: RUN.organizationId,
      expiresAt: Math.floor((STARTED.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000),
      lane: 'agent',
      ...overrides,
    },
    201,
  );
}

beforeEach(() => {
  vi.stubEnv('MOTIR_GATEWAY_URL', `${GATEWAY}/`);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', SECRET);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  fakeOrchestrator.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('mintRunKey', () => {
  it('mints for the run: its id as runRef, its org, [model] bare, expiry at the run timeout', async () => {
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);

    const config = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/run-keys`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const deadlineSeconds = Math.floor((STARTED.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000);
    expect(body).toEqual({
      runRef: 'run_abc',
      coreOrganizationId: 'org_1',
      expiresAt: deadlineSeconds,
      models: ['claude-opus-5-5'],
    });
    // The allow-list carries the id EXACTLY as given — never the OpenCode prefix.
    expect(JSON.stringify(body['models'])).not.toContain('anthropic/');

    expect(config).toEqual({
      runRef: 'run_abc',
      model: 'claude-opus-5-5',
      expiresAt: new Date(STARTED.getTime() + HOSTED_RUN_TIMEOUT_MS),
      containerEnv: { MOTIR_GATEWAY_URL: GATEWAY, MOTIR_RUN_KEY: 'sk-run-key-1' },
    });
  });

  it('hands the container the key and the gateway origin, and NOTHING else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => minted()),
    );
    const config = await hostedRunKeyService.mintRunKey(RUN, 'claude-sonnet-4-6', NOW);
    // The container's ONLY LLM configuration: the two variables the egress
    // contract's OpenCode config substitutes. No provider key, and the mint
    // secret is never in it.
    expect(Object.keys(config.containerEnv).sort()).toEqual(['MOTIR_GATEWAY_URL', 'MOTIR_RUN_KEY']);
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it.each([
    [
      'a 4xx refusal',
      () => json({ error: { code: 'run_key_unauthorized', message: 'wrong secret' } }, 401),
      'refused',
      'run_key_unauthorized',
    ],
    [
      'the gateway being unconfigured (its own 503)',
      () =>
        json(
          { error: { code: 'run_keys_not_configured', message: 'no mint secret on the gateway' } },
          503,
        ),
      'refused',
      'run_keys_not_configured',
    ],
    [
      'a 5xx failure',
      () => json({ error: { code: 'run_key_not_minted', message: 'db down' } }, 500),
      'unavailable',
      null,
    ],
    ['a 201 carrying no key', () => json({ runRef: 'run_abc' }, 201), 'unavailable', null],
    [
      'a 201 whose body is not JSON',
      () => new Response('ok', { status: 201 }),
      'unavailable',
      null,
    ],
  ] as const)(
    'on %s: a typed HostedRunKeyNotMintedError, and no container is booted',
    async (_label, respond, reason, gatewayCode) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => respond()),
      );
      const err = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRunKeyNotMintedError);
      expect((err as HostedRunKeyNotMintedError).reason).toBe(reason);
      expect((err as HostedRunKeyNotMintedError).gatewayCode).toBe(gatewayCode);
      // The mint is the pre-boot step: its failure leaves the fleet untouched.
      expect(fakeOrchestrator.provisioned).toHaveLength(0);
      expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    },
  );

  it('on an unreachable gateway: unavailable, no container booted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRunKeyNotMintedError);
    expect((err as HostedRunKeyNotMintedError).reason).toBe('unavailable');
    expect(err.message).toContain('fetch failed');
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('on a gateway that never answers: unavailable after the deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      );
      const pending = hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW).catch((e) => e);
      await vi.advanceTimersByTimeAsync(20_000);
      const err = await pending;
      expect((err as HostedRunKeyNotMintedError).reason).toBe('unavailable');
      expect(err.message).toContain('did not respond');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['MOTIR_GATEWAY_URL', ''],
    ['MOTIR_RUN_KEY_MINT_SECRET', ''],
  ])('refuses as not_configured when %s is unset, and sends nothing', async (name, value) => {
    vi.stubEnv(name, value);
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);
    const err = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW).catch((e) => e);
    expect((err as HostedRunKeyNotMintedError).reason).toBe('not_configured');
    expect(err.message).toContain(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a gateway URL that already carries /v1 (the container would call /v1/v1)', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', `${GATEWAY}/v1`);
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);
    const err = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW).catch((e) => e);
    expect((err as HostedRunKeyNotMintedError).reason).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses, without asking, a run already past its timeout — and an empty model', async () => {
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);
    const late = new Date(STARTED.getTime() + HOSTED_RUN_TIMEOUT_MS);
    const pastTimeout = await hostedRunKeyService
      .mintRunKey(RUN, 'claude-opus-5-5', late)
      .catch((e) => e);
    expect((pastTimeout as HostedRunKeyNotMintedError).reason).toBe('invalid_request');
    const noModel = await hostedRunKeyService.mintRunKey(RUN, '', NOW).catch((e) => e);
    expect((noModel as HostedRunKeyNotMintedError).reason).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the requested expiry when the gateway answers without one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ key: 'sk-run-key-2' }, 201)),
    );
    const config = await hostedRunKeyService.mintRunKey(RUN, 'claude-opus-5-5', NOW);
    expect(config.containerEnv.MOTIR_RUN_KEY).toBe('sk-run-key-2');
    expect(config.expiresAt).toEqual(new Date(STARTED.getTime() + HOSTED_RUN_TIMEOUT_MS));
  });
});

describe('revokeRunKey', () => {
  it('asks the gateway to revoke every key bound to the run', async () => {
    const fetchMock = vi.fn(async () => json({ runRef: 'run_abc', revoked: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await hostedRunKeyService.revokeRunKey('run_abc')).toEqual({
      ok: true,
      runRef: 'run_abc',
      revoked: 1,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/run-keys/run_abc`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`);
  });

  it('treats a second revoke (revoked: 0) and an empty 200 as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ runRef: 'run_abc', revoked: 0 })),
    );
    expect(await hostedRunKeyService.revokeRunKey('run_abc')).toMatchObject({
      ok: true,
      revoked: 0,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    expect(await hostedRunKeyService.revokeRunKey('run_abc')).toMatchObject({
      ok: true,
      revoked: 0,
    });
  });

  it.each([
    [
      'a refusal',
      () => json({ error: { code: 'run_key_unauthorized', message: 'wrong secret' } }, 401),
      'refused',
    ],
    [
      'a 5xx',
      () => new Response('boom', { status: 502, statusText: 'Bad Gateway' }),
      'unavailable',
    ],
    [
      'a transport failure',
      () => {
        throw new TypeError('fetch failed');
      },
      'unavailable',
    ],
  ] as const)('returns %s as a typed result — it never throws', async (_label, respond, reason) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond()),
    );
    const result = await hostedRunKeyService.revokeRunKey('run_abc');
    expect(result).toMatchObject({ ok: false, runRef: 'run_abc', reason });
  });

  it('returns not_configured, without sending, when the mint secret is unset', async () => {
    vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', '');
    const fetchMock = vi.fn(async () => json({ revoked: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await hostedRunKeyService.revokeRunKey('run_abc')).toMatchObject({
      ok: false,
      reason: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
