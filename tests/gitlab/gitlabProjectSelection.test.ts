import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import { GitlabConnectionNotFoundError, GitlabProjectNotFoundError } from '@/lib/gitlab/errors';
import { truncateAuthTables } from '../helpers/db';

// Story 7.23 · MOTIR-1478 — the GitLab settings surface's PROJECT SELECTION service
// paths, against a real Postgres (the motir-core convention). A connected project
// is a `github_repo` row under the GitLab connection (provider='gitlab'); the
// picker's candidate list comes live through the GitProvider seam. Only `fetch`
// (the GitLab host) is stubbed — every DB path is real.

const PASSWORD = 'hunter2hunter2';
const KEY = 'a'.repeat(64); // 64 hex chars → a valid 32-byte AES key

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** Seed a GitLab connection row (system context) with a still-valid token, so the
 *  provider's token mint is a no-op read (no refresh fetch). Returns the row. */
async function seedConnection(workspaceId: string) {
  return withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspaceId}`,
        workspaceId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: encryptToken('good-token'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    ),
  );
}

/** Stub GitLab's `GET /api/v4/projects` with two memberships. */
function stubProjects() {
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    expect(String(url)).toContain('/api/v4/projects');
    return Response.json([
      {
        id: 12,
        path: 'motir-core',
        path_with_namespace: 'moooon/motir-core',
        default_branch: 'main',
      },
      { id: 34, path: 'app', path_with_namespace: 'moooon/group/app', default_branch: 'trunk' },
    ]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('gitlabConnectionService — project selection', () => {
  it('connectProject persists the AUTHORITATIVE project row (provider=gitlab), then reads it back', async () => {
    const { user, workspace } = await makeWorkspace('connect@example.com');
    await seedConnection(workspace.id);
    stubProjects();
    const ctx = { userId: user.id, workspaceId: workspace.id };

    // Connect by id only — owner/name/branch come from GitLab, not the caller.
    await gitlabConnectionService.connectProject(ctx, '12');

    const read = await gitlabConnectionService.getConnectionForWorkspace(ctx);
    expect(read?.repos).toEqual([
      expect.objectContaining({
        repoId: '12',
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
      }),
    ]);
    // The persisted row carries the gitlab discriminator.
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listByInstallation(read!.id, tx),
    );
    expect(rows[0]?.provider).toBe('gitlab');

    // Idempotent — connecting the same project again is a no-op upsert.
    await gitlabConnectionService.connectProject(ctx, '12');
    const again = await gitlabConnectionService.getConnectionForWorkspace(ctx);
    expect(again?.repos).toHaveLength(1);
  });

  it('connectProject rejects a project the user is NOT a member of', async () => {
    const { user, workspace } = await makeWorkspace('nomember@example.com');
    await seedConnection(workspace.id);
    stubProjects();
    await expect(
      gitlabConnectionService.connectProject({ userId: user.id, workspaceId: workspace.id }, '999'),
    ).rejects.toBeInstanceOf(GitlabProjectNotFoundError);
  });

  it('connectProject throws when the workspace has no GitLab connection', async () => {
    const { user, workspace } = await makeWorkspace('unconnected@example.com');
    await expect(
      gitlabConnectionService.connectProject({ userId: user.id, workspaceId: workspace.id }, '12'),
    ).rejects.toBeInstanceOf(GitlabConnectionNotFoundError);
  });

  it('listSelectableProjects flags which projects are already connected', async () => {
    const { user, workspace } = await makeWorkspace('list@example.com');
    await seedConnection(workspace.id);
    stubProjects();
    const ctx = { userId: user.id, workspaceId: workspace.id };
    await gitlabConnectionService.connectProject(ctx, '12');

    const projects = await gitlabConnectionService.listSelectableProjects(ctx);
    expect(projects).toEqual([
      expect.objectContaining({
        repoId: '12',
        owner: 'moooon',
        name: 'motir-core',
        connected: true,
      }),
      expect.objectContaining({
        repoId: '34',
        owner: 'moooon/group',
        name: 'app',
        connected: false,
      }),
    ]);
  });

  it('listSelectableProjects throws when the workspace has no GitLab connection', async () => {
    const { user, workspace } = await makeWorkspace('list-unconnected@example.com');
    await expect(
      gitlabConnectionService.listSelectableProjects({
        userId: user.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(GitlabConnectionNotFoundError);
  });

  it('disconnectProject removes the selection and is idempotent', async () => {
    const { user, workspace } = await makeWorkspace('disconnect@example.com');
    await seedConnection(workspace.id);
    stubProjects();
    const ctx = { userId: user.id, workspaceId: workspace.id };
    await gitlabConnectionService.connectProject(ctx, '12');
    expect((await gitlabConnectionService.getConnectionForWorkspace(ctx))?.repos).toHaveLength(1);

    await gitlabConnectionService.disconnectProject(ctx, '12');
    expect((await gitlabConnectionService.getConnectionForWorkspace(ctx))?.repos).toEqual([]);
    // Idempotent — a second disconnect is a no-op.
    await expect(gitlabConnectionService.disconnectProject(ctx, '12')).resolves.toBeUndefined();
  });
});

describe('githubRepoRepository.deleteByInstallationAndRepoId', () => {
  it('removes one row by (installation, repo) and returns 0 when already gone', async () => {
    const { workspace } = await makeWorkspace('repo@example.com');
    const conn = await seedConnection(workspace.id);
    await withSystemContext((tx) =>
      githubRepoRepository.upsert(
        {
          installationId: conn.id,
          repoId: '77',
          owner: 'o',
          name: 'n',
          defaultBranch: 'main',
          provider: 'gitlab',
        },
        tx,
      ),
    );

    const removed = await withSystemContext((tx) =>
      githubRepoRepository.deleteByInstallationAndRepoId(conn.id, '77', tx),
    );
    expect(removed).toBe(1);
    const again = await withSystemContext((tx) =>
      githubRepoRepository.deleteByInstallationAndRepoId(conn.id, '77', tx),
    );
    expect(again).toBe(0);
  });
});
