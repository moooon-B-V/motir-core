import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// Story 7.10 · MOTIR-891 — the installation grant service, against a real
// Postgres (the motir-core convention). Installation rows are workspace-scoped;
// the write path runs under system context (the webhook), the reads under
// workspace context.

const PASSWORD = 'hunter2hunter2';

const REPO_A: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
};
const REPO_B: NormalizedRepo = {
  providerRepoId: '222',
  owner: 'moooon',
  name: 'motir-ai',
  defaultBranch: 'main',
};

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** Run `fn` as the non-bypass `prodect_app` role with both GUCs bound — the role
 *  switch is what makes the workspace RLS policy actually bite. */
async function asAppRole<T>(
  ctx: { userId: string; workspaceId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('githubInstallationService.persistInstallation + getWorkspaceInstallation', () => {
  it('persists an installation + its selected repos and reads them back token-free', async () => {
    const { user, workspace } = await makeWorkspace('a@example.com');

    const written = await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A, REPO_B],
    });
    expect(written).toMatchObject({
      provider: 'github',
      installationId: 'inst-1',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    expect(written.repos).toHaveLength(2);
    // No token in the DTO in any form.
    expect(written).not.toHaveProperty('token');
    expect(written).not.toHaveProperty('accessToken');

    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.installationId).toBe('inst-1');
    expect(read?.repos.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
  });

  it('reconciles the selected-repo set on re-persist (drops a de-selected repo)', async () => {
    const { user, workspace } = await makeWorkspace('b@example.com');

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-2',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A, REPO_B],
    });
    // Re-install with only REPO_A selected.
    const second = await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-2',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [REPO_A],
    });
    expect(second.repos.map((r) => r.repoId)).toEqual(['111']);

    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.repos).toHaveLength(1);
    expect(read?.repos[0]?.name).toBe('motir-core');
  });

  it('returns null when the workspace has no installation (the two grants are independent)', async () => {
    // A workspace/member with NO installation reads null — no identity is
    // required, and no crash. (The identity grant is a separate table this
    // service never touches.)
    const { user, workspace } = await makeWorkspace('c@example.com');
    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read).toBeNull();
  });
});

describe('githubInstallationService.mintAccessTokenForWorkspace', () => {
  it('mints a token THROUGH the provider seam for the workspace installation', async () => {
    const { publicKey: _pub, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    void _pub;
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    const fetchMock = vi.fn(
      async (_url: string): Promise<Response> =>
        new Response(
          JSON.stringify({
            token: 'ghs_scoped',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { user, workspace } = await makeWorkspace('d@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-9', accountLogin: 'moooon', accountType: 'User' },
      repos: [REPO_A],
    });

    const tok = await githubInstallationService.mintAccessTokenForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(tok?.token).toBe('ghs_scoped');
    // Dispatched to the installation-scoped GitHub endpoint via the seam.
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe('https://api.github.com/app/installations/inst-9/access_tokens');
  });

  it('returns null when the workspace has no installation', async () => {
    const { user, workspace } = await makeWorkspace('e@example.com');
    const tok = await githubInstallationService.mintAccessTokenForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(tok).toBeNull();
  });
});

describe('githubInstallationService.bindInstallationForWorkspace', () => {
  function stubGithubFetch(): void {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    const json = (o: unknown): Response =>
      new Response(JSON.stringify(o), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_bind',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: [
            { id: 111, name: 'motir-core', owner: { login: 'moooon' }, default_branch: 'main' },
            { id: 222, name: 'motir-ai', owner: { login: 'moooon' }, default_branch: 'main' },
          ],
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: { login: 'moooon', type: 'Organization' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('binds a fresh install: fetches account + repos through the seam and persists them', async () => {
    stubGithubFetch();
    const { user, workspace } = await makeWorkspace('bind@example.com');

    const dto = await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: workspace.id,
      installationId: 'inst-bind',
    });

    expect(dto).toMatchObject({
      installationId: 'inst-bind',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    expect(dto.repos.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    // The token never crosses the DTO boundary.
    expect(JSON.stringify(dto)).not.toContain('ghs_bind');

    // Now bound → the webhook-style reconcile / the settings read find it.
    const read = await githubInstallationService.getWorkspaceInstallation({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read?.installationId).toBe('inst-bind');
    expect(read?.repos).toHaveLength(2);
  });
});

describe('github_installation RLS', () => {
  it("hides another workspace's installation under the app role", async () => {
    const a = await makeWorkspace('rls-a@example.com');
    const b = await makeWorkspace('rls-b@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: a.workspace.id,
      installation: { installationId: 'inst-a', accountLogin: 'a', accountType: 'Organization' },
      repos: [REPO_A],
    });

    // Bound to B's workspace GUC, A's row is invisible; bound to A's, it's visible.
    const underB = await asAppRole({ userId: b.user.id, workspaceId: b.workspace.id }, (tx) =>
      githubInstallationRepository.findByWorkspaceId(a.workspace.id, tx),
    );
    expect(underB).toBeNull();

    const underA = await asAppRole({ userId: a.user.id, workspaceId: a.workspace.id }, (tx) =>
      githubInstallationRepository.findByWorkspaceId(a.workspace.id, tx),
    );
    expect(underA).not.toBeNull();
  });

  it('a system-context read sees the row (the webhook-writer escape)', async () => {
    const { workspace } = await makeWorkspace('sys@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-sys', accountLogin: 's', accountType: 'User' },
      repos: [],
    });
    const row = await withSystemContext((tx) =>
      githubInstallationRepository.findByInstallationId('inst-sys', tx),
    );
    expect(row?.workspaceId).toBe(workspace.id);
  });
});
