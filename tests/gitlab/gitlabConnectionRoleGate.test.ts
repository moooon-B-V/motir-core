import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WHO MAY MANAGE THE WORKSPACE'S GITLAB CONNECTION (bug MOTIR-6320), against a
// real Postgres. The three writes — `disconnect`, `connectProject`,
// `disconnectProject` — and the picker read that only feeds Connect checked
// nothing but RLS membership, so a plain member could delete the workspace's
// GitLab credential, register a webhook and start indexing, or schedule a
// project's code graph for removal. They now assert the org role the GitHub
// arm's disconnect asserts: Owner or Admin (`manageOrgSettings`).
//
// Only `fetch` (the GitLab host) and the post-commit seat-sync enqueue are
// stubbed; every DB path is real. The refusal is asserted with its CONSEQUENCES —
// the connection and project rows still there, no offboarding row, no call to
// GitLab — because a refusal thrown after the effect would pass a bare
// `rejects` check.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { createTestUser } = await import('../fixtures/userFixtures');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { gitlabConnectionService } = await import('@/lib/services/gitlabConnectionService');
const { githubInstallationRepository } =
  await import('@/lib/repositories/githubInstallationRepository');
const { githubRepoRepository } = await import('@/lib/repositories/githubRepoRepository');
const { encryptToken } = await import('@/lib/gitlab/tokenCrypto');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { OrgForbiddenError } = await import('@/lib/organizations/errors');

const KEY = 'a'.repeat(64);

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', KEY);
  vi.stubEnv('GITLAB_WEBHOOK_SECRET', 'webhook-secret');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * One workspace with a GitLab connection and one connected project, plus four
 * actors: the org Owner (who created it), an org Admin who is a workspace member,
 * a workspace MANAGER who is a plain org member, and a plain member.
 */
async function setup() {
  // A workspace WITH a project: a repo's code-graph offboarding fans out one row
  // per project, so without one "nothing was scheduled" would be vacuous.
  const fx = await makeWorkItemFixture();
  const owner = fx.owner;
  const workspace = { id: fx.workspaceId };
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { organizationId: true },
  });

  const orgAdmin = await createTestUser();
  await workspacesService.addMember({ userId: orgAdmin.id, workspaceId: workspace.id });
  await organizationsService.changeMemberRole({
    organizationId,
    userId: orgAdmin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const wsManager = await createTestUser();
  await workspacesService.addMember({
    userId: wsManager.id,
    workspaceId: workspace.id,
    workspaceRole: 'manager',
  });
  const member = await createTestUser();
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

  const conn = await withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
        organizationId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: encryptToken('good-token'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    ),
  );
  await withSystemContext((tx) =>
    githubRepoRepository.upsert(
      {
        installationId: conn.id,
        workspaceId: workspace.id,
        organizationId,
        repoId: '12',
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
        provider: 'gitlab',
      },
      tx,
    ),
  );

  const ctxOf = (userId: string) => ({ userId, workspaceId: workspace.id });
  return { workspace, conn, owner, orgAdmin, wsManager, member, ctxOf };
}

/** GitLab's project list (two memberships) and its hooks API, answered in-process. */
function stubGitlab() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/hooks')) {
      if ((init?.method ?? 'GET') === 'GET') return Response.json([]);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ id: 99, url: 'x' }, { status: 201 });
    }
    return Response.json([
      {
        id: 12,
        path: 'motir-core',
        path_with_namespace: 'moooon/motir-core',
        default_branch: 'main',
      },
      { id: 34, path: 'app', path_with_namespace: 'moooon/app', default_branch: 'main' },
    ]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The state a refused call must leave exactly as it found it. */
async function snapshot(workspaceId: string, connId: string) {
  const [connections, repos, offboarding] = await Promise.all([
    adminDb.githubInstallation.count({ where: { workspaceId, provider: 'gitlab' } }),
    adminDb.githubRepo.findMany({ where: { installationId: connId }, select: { repoId: true } }),
    adminDb.codeGraphOffboarding.count(),
  ]);
  return { connections, repoIds: repos.map((r) => r.repoId).sort(), offboarding };
}

describe('a plain workspace member is REFUSED, and nothing happens (MOTIR-6320)', () => {
  it('disconnect — the credential survives', async () => {
    const s = await setup();
    const fetchMock = stubGitlab();
    const before = await snapshot(s.workspace.id, s.conn.id);

    await expect(gitlabConnectionService.disconnect(s.ctxOf(s.member.id))).rejects.toBeInstanceOf(
      OrgForbiddenError,
    );

    expect(await snapshot(s.workspace.id, s.conn.id)).toEqual(before);
    expect(before.connections).toBe(1);
    // No webhook was taken off any project either.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connectProject — no webhook registered, no row written', async () => {
    const s = await setup();
    const fetchMock = stubGitlab();
    const before = await snapshot(s.workspace.id, s.conn.id);

    await expect(
      gitlabConnectionService.connectProject(s.ctxOf(s.member.id), '34'),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    expect(await snapshot(s.workspace.id, s.conn.id)).toEqual(before);
    expect(before.repoIds).toEqual(['12']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disconnectProject — the project stays connected and nothing is scheduled for removal', async () => {
    const s = await setup();
    const fetchMock = stubGitlab();
    const before = await snapshot(s.workspace.id, s.conn.id);

    await expect(
      gitlabConnectionService.disconnectProject(s.ctxOf(s.member.id), '12'),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    expect(await snapshot(s.workspace.id, s.conn.id)).toEqual(before);
    expect(before.offboarding).toBe(0);
    expect(before.repoIds).toEqual(['12']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listSelectableProjects — the picker read that only feeds Connect', async () => {
    const s = await setup();
    const fetchMock = stubGitlab();

    await expect(
      gitlabConnectionService.listSelectableProjects(s.ctxOf(s.member.id)),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ a workspace MANAGER who is a plain ORG member is refused too — the connection is the org’s', async () => {
    // The GitHub arm's disconnect and the Git page both ask the ORG role
    // (`isOrgAdminForWorkspace`), and a Manager is not shown this page at all
    // (MOTIR-6312). A workspace role that the page refuses must not reach the
    // write through the action instead.
    const s = await setup();
    stubGitlab();
    await expect(
      gitlabConnectionService.disconnect(s.ctxOf(s.wsManager.id)),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect((await snapshot(s.workspace.id, s.conn.id)).connections).toBe(1);
  });
});

describe('the org Owner and an org Admin still perform all three', () => {
  it.each([
    ['the Owner', 'owner'],
    ['an Admin', 'orgAdmin'],
  ] as const)('%s', async (_label, who) => {
    const s = await setup();
    stubGitlab();
    const ctx = s.ctxOf(s[who].id);

    const projects = await gitlabConnectionService.listSelectableProjects(ctx);
    expect(projects.map((p) => p.repoId).sort()).toEqual(['12', '34']);

    await gitlabConnectionService.connectProject(ctx, '34');
    expect((await snapshot(s.workspace.id, s.conn.id)).repoIds).toEqual(['12', '34']);

    await gitlabConnectionService.disconnectProject(ctx, '34');
    const afterProject = await snapshot(s.workspace.id, s.conn.id);
    expect(afterProject.repoIds).toEqual(['12']);
    expect(afterProject.offboarding).toBeGreaterThan(0);

    await gitlabConnectionService.disconnect(ctx);
    expect((await snapshot(s.workspace.id, s.conn.id)).connections).toBe(0);
  });
});
