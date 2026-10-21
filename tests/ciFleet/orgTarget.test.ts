import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgTargetAuthError, resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';
import { ActionsVariableApiError, actionsVariableClient } from '@/lib/github/actionsVariables';
import { runnerGroupClient } from '@/lib/github/runnerGroups';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import {
  _resetProvisioningInstallationCache,
  provisioningAuth,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// THE ORG TARGET (Story MOTIR-8699 · MOTIR-8702) — the fleet's three org-scoped
// GitHub clients act for a NAMED org through a NAMED installation when a caller
// passes one, and for the provisioning org exactly as before when it does not.
//
// The failure these cases exist to catch is a target forwarded on one call and
// dropped on the next: the inner call would then resolve the PROVISIONING
// installation and act in the wrong org. So every targeted case asserts three
// things about the wire — the org segment, the token minted for the target's
// installation under its role, and that the provisioning installation was never
// resolved at all. `fetch` is the only fake, as in the sibling client suites.

const PROVISIONING_ORG = 'motir-projects';
const PROVISIONING_INSTALLATION = '556677';
const TARGET: GithubOrgTarget = {
  org: 'acme-connected',
  installationId: '880011',
  role: 'user-facing',
};

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
let tokenStatus: number;

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The client's own requests — not the App-auth handshake. */
function clientCalls(): Call[] {
  return calls.filter((c) => !c.url.includes('/access_tokens') && !c.url.endsWith('/installation'));
}

/** Did anything resolve or mint the provisioning installation? */
function provisioningTouched(): boolean {
  return calls.some(
    (c) =>
      c.url.endsWith(`/orgs/${PROVISIONING_ORG}/installation`) ||
      c.url.includes(`/app/installations/${PROVISIONING_INSTALLATION}/access_tokens`),
  );
}

function expectTargeted(): void {
  const own = clientCalls();
  expect(own.length).toBeGreaterThan(0);
  for (const call of own) {
    expect(call.url).toContain(`/orgs/${TARGET.org}/`);
    expect(call.authorization).toBe(`Bearer ghs_${TARGET.role}_${TARGET.installationId}`);
  }
  expect(provisioningTouched()).toBe(false);
}

beforeEach(() => {
  calls = [];
  tokenStatus = 200;
  handler = () => json(200, {});
  const keys = [0, 1].map(
    () =>
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }).privateKey,
  );
  vi.stubEnv('GITHUB_FALLBACK_ORG', PROVISIONING_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', keys[0]!);
  vi.stubEnv('GITHUB_APP_ID', '4343');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', keys[1]!);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        authorization: headers['authorization'] ?? null,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (call.url.endsWith(`/orgs/${PROVISIONING_ORG}/installation`)) {
        return json(200, { id: Number(PROVISIONING_INSTALLATION) });
      }
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(call.url);
      if (mint) {
        if (tokenStatus !== 200) return json(tokenStatus, { message: 'Not Found' });
        // The App the JWT was signed by decides the role; the issuer tells them apart.
        const jwt = call.authorization?.replace('Bearer ', '') ?? '';
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
        const role = payload.iss === '4343' ? 'user-facing' : 'provisioning';
        return json(200, {
          token: `ghs_${role}_${mint[1]}`,
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

describe('resolveOrgAuth', () => {
  it('with no target IS provisioningAuth()', async () => {
    const viaTarget = await resolveOrgAuth();
    const direct = await provisioningAuth();
    expect(viaTarget).toEqual(direct);
    expect(viaTarget).toEqual({
      org: PROVISIONING_ORG,
      installationId: PROVISIONING_INSTALLATION,
      token: `ghs_provisioning_${PROVISIONING_INSTALLATION}`,
    });
  });

  it('with a target mints from the named installation under the named role', async () => {
    await expect(resolveOrgAuth(TARGET)).resolves.toEqual({
      org: TARGET.org,
      installationId: TARGET.installationId,
      token: `ghs_user-facing_${TARGET.installationId}`,
    });
    expect(provisioningTouched()).toBe(false);
  });

  it.each([401, 403, 404])(
    'maps a %i from the token endpoint to OrgTargetAuthError with that status',
    async (status) => {
      tokenStatus = status;
      const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrgTargetAuthError);
      expect(err).toMatchObject({
        code: 'ORG_TARGET_AUTH_FAILED',
        org: TARGET.org,
        installationId: TARGET.installationId,
        role: TARGET.role,
        status,
      });
      expect((err as Error).message).not.toContain('ghs_');
    },
  );

  it('maps an unreachable token endpoint to a null status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgTargetAuthError);
    expect((err as OrgTargetAuthError).status).toBeNull();
  });

  it('maps an unconfigured App to a null status', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgTargetAuthError);
    expect((err as OrgTargetAuthError).status).toBeNull();
  });
});

describe('actionsVariableClient with a target', () => {
  it('getOrgVariable', async () => {
    handler = () =>
      json(200, { name: 'MOTIR_RUNNER', value: 'motir-runner', visibility: 'private' });
    await actionsVariableClient.getOrgVariable('MOTIR_RUNNER', TARGET);
    expectTargeted();
  });

  it('ensureOrgVariable forwards the target to the read AND the create it chooses', async () => {
    handler = (call) => (call.method === 'GET' ? json(404, {}) : json(201, {}));
    await expect(
      actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).resolves.toBe('created');
    expect(clientCalls().map((c) => c.method)).toEqual(['GET', 'POST']);
    expectTargeted();
  });

  it('ensureOrgVariable forwards the target to the patch it chooses', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json(200, { name: 'MOTIR_RUNNER', value: 'ubuntu-latest', visibility: 'all' })
        : json(204, null);
    await expect(
      actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).resolves.toBe('updated');
    expect(clientCalls().map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expectTargeted();
  });

  it("create's 409 falls through to a patch on the SAME target", async () => {
    handler = (call) => (call.method === 'POST' ? json(409, {}) : json(204, null));
    await expect(
      actionsVariableClient.create('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).resolves.toBe('updated');
    expect(clientCalls().map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expectTargeted();
  });

  it('patch', async () => {
    handler = () => json(204, null);
    await actionsVariableClient.patch('MOTIR_RUNNER', 'motir-runner', TARGET);
    expectTargeted();
  });

  it("deleteOrgVariable answers 'deleted' on 204", async () => {
    handler = () => json(204, null);
    await expect(actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', TARGET)).resolves.toBe(
      'deleted',
    );
    const [del] = clientCalls();
    expect(del?.method).toBe('DELETE');
    expect(del?.url).toBe(
      `https://api.github.com/orgs/${TARGET.org}/actions/variables/MOTIR_RUNNER`,
    );
    expectTargeted();
  });

  it("deleteOrgVariable answers 'absent' on 404", async () => {
    handler = () => json(404, { message: 'Not Found' });
    await expect(actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', TARGET)).resolves.toBe(
      'absent',
    );
  });

  it('deleteOrgVariable throws ActionsVariableApiError on a 403', async () => {
    handler = () => json(403, { message: 'Resource not accessible by integration' });
    const err = await actionsVariableClient
      .deleteOrgVariable('MOTIR_RUNNER', TARGET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsVariableApiError);
    expect((err as ActionsVariableApiError).status).toBe(403);
  });

  it('deleteOrgVariable with no target acts on the provisioning org', async () => {
    handler = () => json(204, null);
    await actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER');
    expect(clientCalls()[0]?.url).toContain(`/orgs/${PROVISIONING_ORG}/`);
  });
});

describe('runnerGroupClient with a target', () => {
  const group = {
    id: 77,
    name: 'motir-project-p1',
    visibility: 'selected',
    allows_public_repositories: false,
    restricted_to_workflows: false,
  };

  it('createGroup', async () => {
    handler = () => json(201, group);
    await runnerGroupClient.createGroup({ name: group.name, selectedRepositoryIds: [1] }, TARGET);
    expectTargeted();
    expect(clientCalls()[0]?.body?.['allows_public_repositories']).toBe(false);
  });

  it('getGroup', async () => {
    handler = () => json(200, group);
    await runnerGroupClient.getGroup(77, TARGET);
    expectTargeted();
  });

  it('findGroupByName', async () => {
    handler = () => json(200, { total_count: 1, runner_groups: [group] });
    await runnerGroupClient.findGroupByName(group.name, TARGET);
    expectTargeted();
  });

  it('setGroupRepositories', async () => {
    handler = () => json(204, null);
    await runnerGroupClient.setGroupRepositories(77, [1, 2], TARGET);
    expectTargeted();
  });

  it('deleteGroup', async () => {
    handler = () => json(204, null);
    await runnerGroupClient.deleteGroup(77, TARGET);
    expectTargeted();
  });
});

describe('runnerJitConfigClient with a target', () => {
  it('mint', async () => {
    handler = () =>
      json(201, {
        runner: { id: 9001, name: 'motir-intent-1' },
        encoded_jit_config: 'eyJ9',
      });
    await runnerJitConfigClient.mint(
      { name: 'motir-intent-1', runnerGroupId: 5042, labels: ['motir-runner'] },
      TARGET,
    );
    expectTargeted();
  });

  it('deleteRunner', async () => {
    handler = () => json(204, null);
    await runnerJitConfigClient.deleteRunner(9001, TARGET);
    expectTargeted();
  });

  it('deleteRunnersNamed lists AND deletes through the same target', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json(200, {
            total_count: 2,
            runners: [
              { id: 9001, name: 'motir-intent-1' },
              { id: 9002, name: 'motir-intent-1' },
            ],
          })
        : json(204, null);
    await expect(
      runnerJitConfigClient.deleteRunnersNamed('motir-intent-1', TARGET),
    ).resolves.toEqual([9001, 9002]);
    expect(clientCalls().map((c) => c.method)).toEqual(['GET', 'DELETE', 'DELETE']);
    expectTargeted();
  });
});
