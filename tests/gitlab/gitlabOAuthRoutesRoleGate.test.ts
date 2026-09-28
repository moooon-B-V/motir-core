import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// THE TWO GITLAB OAUTH ROUTES REFUSE A PLAIN MEMBER (bug MOTIR-6765), against a
// real Postgres. The start route answers a member with `?gitlab=forbidden`
// instead of sending them to GitLab, and the callback — reachable by URL
// without the start route — maps the service's refusal to the same status
// rather than a 500. `getSession` is mocked (the test env has no cookies), and so
// is `getWorkspaceContext`, which reads the active-workspace cookie through
// `next/headers`; `fetch` (the GitLab host) is stubbed.

const session: { current: { user: { id: string; name: string } } | null } = { current: null };
const workspaceCtx: { current: { userId: string; workspaceId: string } | null } = {
  current: null,
};

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => workspaceCtx.current,
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { createTestUser } = await import('../fixtures/userFixtures');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationRepository } =
  await import('@/lib/repositories/githubInstallationRepository');
const { encryptToken } = await import('@/lib/gitlab/tokenCrypto');
const { encodeOAuthState } = await import('@/lib/gitlab/oauthState');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { GET: startGET, GITLAB_OAUTH_NONCE_COOKIE } =
  await import('@/app/api/gitlab/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/gitlab/oauth/callback/route');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  workspaceCtx.current = null;
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace already connected to GitLab as its Owner, plus a plain member. */
async function setup() {
  const fx = await makeWorkItemFixture();
  const workspaceId = fx.workspaceId;
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const member = await createTestUser();
  await workspacesService.addMember({ userId: member.id, workspaceId });
  await withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspaceId}`,
        workspaceId,
        organizationId,
        accountLogin: 'owner-gl',
        accountType: 'User',
        accessTokenEncrypted: encryptToken('tok-1'),
        refreshTokenEncrypted: encryptToken('r-1'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    ),
  );
  return { workspaceId, owner: fx.owner, member };
}

function signInAs(user: { id: string }, workspaceId: string) {
  session.current = { user: { id: user.id, name: 'Test' } };
  workspaceCtx.current = { userId: user.id, workspaceId };
}

function statusOf(res: Response): string | null {
  const location = res.headers.get('location');
  return location ? new URL(location).searchParams.get('gitlab') : null;
}

describe('GET /api/gitlab/oauth/start', () => {
  it('redirects a plain member back to the Git settings page with `forbidden`, not to GitLab', async () => {
    const s = await setup();
    signInAs(s.member, s.workspaceId);

    const res = await startGET(new NextRequest('http://localhost/api/gitlab/oauth/start'));

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/organization/git?provider=gitlab');
    expect(location).not.toContain('gitlab.com');
    expect(statusOf(res)).toBe('forbidden');
    // No nonce cookie: no round trip was started.
    expect(res.headers.get('set-cookie') ?? '').not.toContain(GITLAB_OAUTH_NONCE_COOKIE);
  });

  it('still sends the org Owner to GitLab', async () => {
    const s = await setup();
    signInAs(s.owner, s.workspaceId);

    const res = await startGET(new NextRequest('http://localhost/api/gitlab/oauth/start'));

    expect(res.headers.get('location') ?? '').toContain('/oauth/authorize');
    expect(res.headers.get('set-cookie') ?? '').toContain(GITLAB_OAUTH_NONCE_COOKIE);
  });
});

describe('GET /api/gitlab/oauth/callback', () => {
  it('maps a plain member’s refusal to `forbidden`, spends no code, and leaves the connection alone', async () => {
    const s = await setup();
    signInAs(s.member, s.workspaceId);
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    const nonce = 'nonce-1';
    const state = encodeOAuthState({ workspaceId: s.workspaceId, userId: s.member.id, nonce });
    const req = new NextRequest(
      `http://localhost/api/gitlab/oauth/callback?code=member-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${GITLAB_OAUTH_NONCE_COOKIE}=${nonce}` } },
    );

    const res = await callbackGET(req);

    expect(statusOf(res)).toBe('forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: `gitlab-ws-${s.workspaceId}` },
      select: { accountLogin: true },
    });
    expect(row.accountLogin).toBe('owner-gl');
  });
});
