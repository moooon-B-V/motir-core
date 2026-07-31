import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsPermissionsError, actionsPermissionsClient } from '@/lib/github/actionsPermissions';

// The Actions-PERMISSIONS host boundary (Story MOTIR-1775 · MOTIR-1907) — the
// module `ciActionsGateService` stubs, so it needs its own coverage of the wire
// contract: the endpoint, the verb, the body, and what each status means.
//
// `fetch` is stubbed (the convention the meter's and provisioning suites use);
// `mintInstallationToken` is mocked because a real mint needs a private key the
// test env has no business carrying.

vi.mock('@/lib/github/appAuth', () => ({
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

const INPUT = {
  installationId: '42',
  owner: 'motir-projects',
  repo: 'acme-web',
  enabled: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('actionsPermissionsClient.setActionsEnabled', () => {
  it('PUTs the desired state to the per-REPOSITORY endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await actionsPermissionsClient.setActionsEnabled(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Per-repo, NOT `PUT /orgs/{org}/actions/permissions`: the org-level call
    // needs an Organization-level "Administration" permission the provisioning
    // App does not carry, and is one shared list across every tenant (ADR §A).
    expect(url).toBe('https://api.github.com/repos/motir-projects/acme-web/actions/permissions');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('sends enabled:true when re-enabling', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await actionsPermissionsClient.setActionsEnabled({ ...INPUT, enabled: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it('treats 404 as success — the repository is gone, so the intent IS satisfied', async () => {
    // Deleted by the user, or transferred out of Motir's org by MOTIR-711's
    // handoff. Either way Motir no longer pays for its Actions and there is
    // nothing left to disable; retrying forever would pin a dead row in every
    // sweep.
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(actionsPermissionsClient.setActionsEnabled(INPUT)).resolves.toBeUndefined();
  });

  it('raises the typed error on a refusal, carrying the status and no raw body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      }),
    );

    const err = await actionsPermissionsClient.setActionsEnabled(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionsPermissionsError);
    expect((err as ActionsPermissionsError).status).toBe(403);
    expect((err as ActionsPermissionsError).message).toContain('403');
    expect((err as ActionsPermissionsError).message).toContain(
      'Resource not accessible by integration',
    );
  });

  it('normalizes a transport failure to the typed error with a null status', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const err = await actionsPermissionsClient.setActionsEnabled(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionsPermissionsError);
    expect((err as ActionsPermissionsError).status).toBeNull();
    expect((err as ActionsPermissionsError).message).toContain('ECONNRESET');
  });
});
