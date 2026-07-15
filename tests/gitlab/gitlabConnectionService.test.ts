import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { getGitProvider } from '@/lib/git';
import { encryptToken, decryptToken } from '@/lib/gitlab/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.23 · MOTIR-1474 — the GitLab connect + token-store service, against a
// real Postgres (the motir-core convention). GitLab connections are the shared
// GithubInstallation entity under provider='gitlab'; the OAuth token set is stored
// encrypted and refreshed on expiry. Only `fetch` is stubbed (the GitLab host);
// every DB path is real.

const PASSWORD = 'hunter2hunter2';
const KEY = 'a'.repeat(64); // 64 hex chars → a valid 32-byte AES key
const gitlab = getGitProvider('gitlab');

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** Seed a GitLab connection row directly (system context), with the given token
 *  set, so the token-store / provider paths have a real row to act on. */
async function seedConnection(args: {
  workspaceId: string;
  installationId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}) {
  return withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: args.installationId,
        workspaceId: args.workspaceId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: encryptToken(args.accessToken),
        refreshTokenEncrypted: encryptToken(args.refreshToken),
        tokenExpiresAt: args.expiresAt,
      },
      tx,
    ),
  );
}

async function readRow(installationId: string) {
  return withSystemContext((tx) =>
    githubInstallationRepository.findByInstallationId(installationId, tx),
  );
}

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

describe('gitlabConnectionService.completeOAuthCallback', () => {
  it('exchanges the code, stores the encrypted access+refresh token set, and reads back token-free', async () => {
    const { user, workspace } = await makeWorkspace('a@example.com');
    const createdAt = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        return Response.json({
          access_token: 'gl-access-1',
          refresh_token: 'gl-refresh-1',
          expires_in: 7200,
          created_at: createdAt,
        });
      }
      if (u.includes('/api/v4/user')) {
        return Response.json({ id: 555, username: 'octocat' });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const dto = await gitlabConnectionService.completeOAuthCallback({
      code: 'the-code',
      workspaceId: workspace.id,
      userId: user.id,
    });

    expect(dto).toMatchObject({ provider: 'gitlab', accountLogin: 'octocat', accountType: 'User' });
    // The DTO NEVER carries a token in any form.
    expect(dto).not.toHaveProperty('token');
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('accessTokenEncrypted');

    // The stored row holds the ENCRYPTED tokens (not plaintext) that decrypt back.
    const row = await readRow(`gitlab-ws-${workspace.id}`);
    expect(row).not.toBeNull();
    expect(row!.accessTokenEncrypted).toBeTruthy();
    expect(row!.accessTokenEncrypted).not.toContain('gl-access-1');
    expect(decryptToken(row!.accessTokenEncrypted!)).toBe('gl-access-1');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('gl-refresh-1');
    expect(row!.tokenExpiresAt!.getTime()).toBe((createdAt + 7200) * 1000);
  });

  it('re-connecting the same workspace refreshes the SAME row (no duplicate connection)', async () => {
    const { user, workspace } = await makeWorkspace('b@example.com');
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/oauth/token')) {
        return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 7200 });
      }
      return Response.json({ id: 1, username: 'octocat' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await gitlabConnectionService.completeOAuthCallback({
      code: 'c1',
      workspaceId: workspace.id,
      userId: user.id,
    });
    await gitlabConnectionService.completeOAuthCallback({
      code: 'c2',
      workspaceId: workspace.id,
      userId: user.id,
    });

    const count = await withSystemContext((tx) =>
      tx.githubInstallation.count({ where: { workspaceId: workspace.id, provider: 'gitlab' } }),
    );
    expect(count).toBe(1);
  });
});

describe('gitlabConnectionService.getAccessToken', () => {
  it('returns the stored token WITHOUT a refresh while it is still valid', async () => {
    const { workspace } = await makeWorkspace('c@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'still-good',
      refreshToken: 'refresh-x',
      expiresAt: new Date(Date.now() + 3_600_000), // 1h ahead
    });
    // If getAccessToken hit the network on the valid path, this throws.
    const fetchMock = vi.fn(async () => {
      throw new Error('no network expected on the valid-token path');
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await gitlabConnectionService.getAccessToken(installationId);
    expect(token.token).toBe('still-good');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token, returns the new one, and persists the ROTATED set', async () => {
    const { workspace } = await makeWorkspace('d@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'stale-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    const createdAt = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        // The refresh must present the OLD refresh token.
        expect(String((init as RequestInit).body)).toContain('old-refresh');
        return Response.json({
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 7200,
          created_at: createdAt,
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await gitlabConnectionService.getAccessToken(installationId);
    expect(token.token).toBe('fresh-access');

    const row = await readRow(installationId);
    expect(decryptToken(row!.accessTokenEncrypted!)).toBe('fresh-access');
    // The refresh token was ROTATED and persisted (GitLab single-use refresh).
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('rotated-refresh');
    expect(row!.tokenExpiresAt!.getTime()).toBe((createdAt + 7200) * 1000);
  });

  it('throws when the connection does not exist', async () => {
    await expect(gitlabConnectionService.getAccessToken('gitlab-ws-missing')).rejects.toThrow(
      /connection not found/i,
    );
  });

  it('throws GitlabTokenRefreshError when the refresh endpoint returns 401 (token revoked)', async () => {
    const { workspace } = await makeWorkspace('revoked@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'revoked-access',
      refreshToken: 'revoked-refresh',
      expiresAt: new Date(Date.now() - 1000),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('{"error":"invalid_grant"}', { status: 401 });
      }),
    );

    await expect(gitlabConnectionService.getAccessToken(installationId)).rejects.toThrow(
      /token refresh failed/i,
    );
  });

  it('throws GitlabTokenRefreshError when the refresh request throws (network error)', async () => {
    const { workspace } = await makeWorkspace('network@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'old-access',
      refreshToken: 'net-refresh',
      expiresAt: new Date(Date.now() - 1000),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(gitlabConnectionService.getAccessToken(installationId)).rejects.toThrow(
      /token refresh failed/i,
    );
  });

  it('throws on corrupted encrypted access token (decrypt failure)', async () => {
    const { workspace } = await makeWorkspace('corrupt@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    // Seed a row whose accessTokenEncrypted is NOT a valid ciphertext writ by
    // encryptToken — raw garbage that decryptToken will reject.
    await withSystemContext((tx) =>
      githubInstallationRepository.upsertGitlabConnection(
        {
          installationId,
          workspaceId: workspace.id,
          accountLogin: 'octocat',
          accountType: 'User',
          accessTokenEncrypted: 'not-a-valid-token',
          refreshTokenEncrypted: encryptToken('still-good-refresh'),
          tokenExpiresAt: new Date(Date.now() - 1000), // expired → forces decrypt
        },
        tx,
      ),
    );

    await expect(gitlabConnectionService.getAccessToken(installationId)).rejects.toThrow();
  });
});

describe('gitlab provider fetch methods (through the seam, real connection)', () => {
  it('fetchInstallationRepos normalizes GitLab projects with the stored token', async () => {
    const { workspace } = await makeWorkspace('e@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'good-token',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      expect((init as RequestInit | undefined)?.headers).toMatchObject({
        authorization: 'Bearer good-token',
      });
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

    const repos = await gitlab.fetchInstallationRepos(installationId);
    expect(repos).toEqual([
      { providerRepoId: '12', owner: 'moooon', name: 'motir-core', defaultBranch: 'main' },
      { providerRepoId: '34', owner: 'moooon/group', name: 'app', defaultBranch: 'trunk' },
    ]);
  });

  it('fetchRepoTarball mints the token, GETs the URL-encoded archive path, and returns the bytes', async () => {
    const { workspace } = await makeWorkspace('f@example.com');
    const installationId = `gitlab-ws-${workspace.id}`;
    await seedConnection({
      workspaceId: workspace.id,
      installationId,
      accessToken: 'tar-token',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x42]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      expect(u).toContain('/api/v4/projects/moooon%2Fmotir-core/repository/archive');
      expect(u).toContain('sha=main');
      expect((init as RequestInit | undefined)?.headers).toMatchObject({
        authorization: 'Bearer tar-token',
      });
      return new Response(bytes, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const buf = await gitlab.fetchRepoTarball(installationId, 'moooon', 'motir-core', 'main');
    expect(new Uint8Array(buf)).toEqual(bytes);
  });
});

describe('gitlabConnectionService.getConnectionForWorkspace + disconnect', () => {
  it('returns null when no connection exists for the workspace', async () => {
    const { user, workspace } = await makeWorkspace('h@example.com');
    // No seed — the workspace has never connected GitLab.
    const result = await gitlabConnectionService.getConnectionForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(result).toBeNull();
  });

  it('reads the connection, then removes it (idempotent)', async () => {
    const { user, workspace } = await makeWorkspace('g@example.com');
    await seedConnection({
      workspaceId: workspace.id,
      installationId: `gitlab-ws-${workspace.id}`,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const read = await gitlabConnectionService.getConnectionForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(read).toMatchObject({ provider: 'gitlab', accountLogin: 'octocat' });

    await gitlabConnectionService.disconnect({ userId: user.id, workspaceId: workspace.id });
    const after = await gitlabConnectionService.getConnectionForWorkspace({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(after).toBeNull();
    // Idempotent — a second disconnect is a no-op.
    await expect(
      gitlabConnectionService.disconnect({ userId: user.id, workspaceId: workspace.id }),
    ).resolves.toBeUndefined();
  });
});
