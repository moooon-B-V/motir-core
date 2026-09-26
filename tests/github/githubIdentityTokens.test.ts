import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { decryptToken, encryptToken } from '@/lib/github/tokenCrypto';
import {
  GithubIdentityExpiredError,
  GithubIdentityNotLinkedError,
  GithubOAuthExchangeError,
} from '@/lib/github/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-683 · MOTIR-6519 — the Motir Integration identity with EXPIRING
// user tokens: stored with a refresh token, refreshed under a row lock, revoked
// on disconnect. Real Postgres; GitHub is stubbed at the HTTP seam with a global
// `fetch` mock, so nothing reaches github.com.

const PASSWORD = 'hunter2hunter2';
const HOUR = 3_600_000;
const CLIENT_ID = 'Iv1.integration';
const CLIENT_SECRET = 'integration-secret';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function mockGithub(
  opts: {
    tokenResponses?: Array<Record<string, unknown>>;
    user?: { id: number; login: string };
    revokeStatus?: number;
    revokeThrows?: boolean;
  } = {},
): Call[] {
  const calls: Call[] = [];
  const queue = [...(opts.tokenResponses ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.includes('/login/oauth/access_token')) {
        const next = queue.shift() ?? { error: 'no_more_tokens' };
        return new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify(opts.user ?? { id: 7, login: 'octo' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/applications/') && url.endsWith('/token')) {
        if (opts.revokeThrows) throw new Error('network down');
        return new Response(null, { status: opts.revokeStatus ?? 204 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
  return calls;
}

const issued = (n: number) => ({
  access_token: `ghu_access_${n}`,
  expires_in: 28_800,
  refresh_token: `ghr_refresh_${n}`,
  refresh_token_expires_in: 15_897_600,
});

async function makeUser(email = 'member@example.com') {
  return usersService.createUser({ email, password: PASSWORD, name: 'Member' });
}

function readRow(userId: string) {
  return withSystemContext((tx) => githubIdentityRepository.findByUserId(userId, tx));
}

/** Seed an identity whose access token dies in `accessExpiresInMs` (null = a
 *  non-expiring token) and whose refresh token dies in `refreshExpiresInMs`
 *  (null = no refresh token at all). */
async function linked(
  accessExpiresInMs: number | null,
  refreshExpiresInMs: number | null = 90 * 24 * HOUR,
) {
  const user = await makeUser();
  await withSystemContext((tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId: user.id,
        githubUserId: '9',
        githubLogin: 'bob',
        avatarUrl: null,
        accessTokenEncrypted: encryptToken('ghu_stored'),
        accessTokenExpiresAt:
          accessExpiresInMs === null ? null : new Date(Date.now() + accessExpiresInMs),
        refreshTokenEncrypted: refreshExpiresInMs === null ? null : encryptToken('ghr_stored'),
        refreshTokenExpiresAt:
          refreshExpiresInMs === null ? null : new Date(Date.now() + refreshExpiresInMs),
      },
      tx,
    ),
  );
  return user;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_APP_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GITHUB_APP_CLIENT_SECRET', CLIENT_SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('completeOAuthCallback with an expiring token (AC1)', () => {
  it('stores the access token, the refresh token and both expiries — tokens encrypted', async () => {
    const user = await makeUser();
    const calls = mockGithub({ tokenResponses: [issued(1)], user: { id: 555, login: 'alice' } });

    await githubIdentityService.completeOAuthCallback({ code: 'c0de', userId: user.id });

    const exchange = calls.find((c) => c.url.includes('/login/oauth/access_token'))!;
    expect(exchange.body).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: 'c0de',
    });
    const row = await readRow(user.id);
    expect(row!.githubUserId).toBe('555');
    expect(row!.accessTokenEncrypted).not.toContain('ghu_access_1');
    expect(row!.refreshTokenEncrypted).not.toContain('ghr_refresh_1');
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('ghu_access_1');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('ghr_refresh_1');
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * HOUR);
    expect(row!.refreshTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 100 * 24 * HOUR);
  });

  it('stores a non-expiring token exactly as before — and a re-link clears a stale pair', async () => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [issued(1)] });
    await githubIdentityService.completeOAuthCallback({ code: 'a', userId: user.id });

    mockGithub({ tokenResponses: [{ access_token: 'gho_forever' }] });
    await githubIdentityService.completeOAuthCallback({ code: 'b', userId: user.id });

    const row = await readRow(user.id);
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('gho_forever');
    expect(row!.accessTokenExpiresAt).toBeNull();
    expect(row!.refreshTokenEncrypted).toBeNull();
    expect(row!.refreshTokenExpiresAt).toBeNull();
  });
});

describe('getUserToken (AC2)', () => {
  it('returns a non-expiring token as it is, and calls GitHub for nothing', async () => {
    const user = await linked(null, null);
    const calls = mockGithub();
    expect(await githubIdentityService.getUserToken(user.id)).toEqual({
      accessToken: 'ghu_stored',
      githubLogin: 'bob',
      githubUserId: '9',
    });
    expect(calls).toHaveLength(0);
  });

  it('returns the stored token while it is outside the margin, without calling GitHub', async () => {
    const user = await linked(4 * HOUR);
    const calls = mockGithub();
    expect((await githubIdentityService.getUserToken(user.id)).accessToken).toBe('ghu_stored');
    expect(calls).toHaveLength(0);
  });

  it('refreshes a token inside the margin and persists the ROTATED pair', async () => {
    const user = await linked(2 * 60_000);
    const calls = mockGithub({ tokenResponses: [issued(2)] });
    const t = await githubIdentityService.getUserToken(user.id);
    expect(t.accessToken).toBe('ghu_access_2');
    expect(calls[0]?.body).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'ghr_stored',
    });
    const row = await readRow(user.id);
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('ghu_access_2');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('ghr_refresh_2');
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * HOUR);
  });

  it('serialises concurrent refreshes: ONE call to GitHub, every caller gets the new token', async () => {
    const user = await linked(-60_000);
    const calls = mockGithub({ tokenResponses: [issued(3), issued(4), issued(5)] });
    const results = await Promise.all([
      githubIdentityService.getUserToken(user.id),
      githubIdentityService.getUserToken(user.id),
      githubIdentityService.getUserToken(user.id),
    ]);
    expect(results.map((r) => r.accessToken)).toEqual([
      'ghu_access_3',
      'ghu_access_3',
      'ghu_access_3',
    ]);
    expect(calls.filter((c) => c.url.includes('/login/oauth/access_token'))).toHaveLength(1);
    const row = await readRow(user.id);
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('ghr_refresh_3');
  });

  it('throws GithubIdentityNotLinkedError for a member who never connected', async () => {
    const user = await makeUser();
    mockGithub();
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityNotLinkedError,
    );
  });

  it('throws GithubIdentityExpiredError when the refresh token has expired', async () => {
    const user = await linked(-60_000, -60_000);
    const calls = mockGithub();
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityExpiredError,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws GithubIdentityExpiredError for an expired token with no refresh token', async () => {
    const user = await linked(-60_000, null);
    mockGithub();
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityExpiredError,
    );
  });

  it('marks the pair expired when GitHub refuses the refresh, so it is not spent again', async () => {
    const user = await linked(-60_000);
    const calls = mockGithub({ tokenResponses: [{ error: 'bad_refresh_token' }] });
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityExpiredError,
    );
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubIdentityExpiredError,
    );
    expect(calls.filter((c) => c.url.includes('/login/oauth/access_token'))).toHaveLength(1);
  });

  it('leaves the row untouched when the token endpoint is unreachable (a retry can succeed)', async () => {
    const user = await linked(-60_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(githubIdentityService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubOAuthExchangeError,
    );
    mockGithub({ tokenResponses: [issued(6)] });
    expect((await githubIdentityService.getUserToken(user.id)).accessToken).toBe('ghu_access_6');
  });

  it('getLiveToken answers null for an expired identity — the "connect again" state', async () => {
    const user = await linked(-60_000, -60_000);
    mockGithub();
    expect(await githubIdentityService.getLiveToken(user.id)).toBeNull();
  });
});

describe('disconnect revokes at GitHub (AC3)', () => {
  it('revokes the token with the App credentials and deletes the row', async () => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [issued(7)] });
    await githubIdentityService.completeOAuthCallback({ code: 'x', userId: user.id });

    const calls = mockGithub();
    await githubIdentityService.disconnect(user.id);

    const revoke = calls.find((c) => c.method === 'DELETE')!;
    expect(revoke.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(revoke.body).toEqual({ access_token: 'ghu_access_7' });
    expect(revoke.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(await readRow(user.id)).toBeNull();
  });

  it.each([
    ['throws', { revokeThrows: true }],
    ['answers 500', { revokeStatus: 500 }],
  ])('still deletes the row and logs when the revoke %s', async (_label, revoke) => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [issued(8)] });
    await githubIdentityService.completeOAuthCallback({ code: 'x', userId: user.id });

    mockGithub(revoke);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await githubIdentityService.disconnect(user.id);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the row is deleted'));
    expect(await readRow(user.id)).toBeNull();
  });

  it('calls GitHub for nothing when there is no identity to disconnect', async () => {
    const user = await makeUser();
    const calls = mockGithub();
    await githubIdentityService.disconnect(user.id);
    expect(calls).toHaveLength(0);
  });
});
