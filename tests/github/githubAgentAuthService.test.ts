import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { githubAgentAuthService } from '@/lib/services/githubAgentAuthService';
import { githubAgentAuthorizationRepository } from '@/lib/repositories/githubAgentAuthorizationRepository';
import { decryptToken, encryptToken } from '@/lib/github/tokenCrypto';
import {
  GithubAgentAppNotConfiguredError,
  GithubAgentAuthorizationExpiredError,
  GithubAgentNotLinkedError,
  GithubOAuthExchangeError,
} from '@/lib/github/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-683 · MOTIR-6519 — the Motir Agent link, against a real Postgres.
// GitHub is stubbed at the HTTP seam with a global `fetch` mock; nothing reaches
// github.com.

const PASSWORD = 'hunter2hunter2';
const HOUR = 3_600_000;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function mockGithub(opts: {
  tokenResponses?: Array<Record<string, unknown>>;
  user?: { id: number; login: string };
  revokeStatus?: number;
  revokeThrows?: boolean;
}): Call[] {
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

async function makeUser(email = 'dispatcher@example.com') {
  return usersService.createUser({ email, password: PASSWORD, name: 'Dispatcher' });
}

function readRow(userId: string) {
  return withSystemContext((tx) => githubAgentAuthorizationRepository.findByUserId(userId, tx));
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_AGENT_APP_CLIENT_ID', 'Iv1.agentclient');
  vi.stubEnv('GITHUB_AGENT_APP_CLIENT_SECRET', 'agent-secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('buildAuthorizeUrl', () => {
  it('names the Motir Agent client id, the agent callback and the state', () => {
    const url = new URL(githubAgentAuthService.buildAuthorizeUrl('nonce-1'));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv1.agentclient');
    expect(url.searchParams.get('state')).toBe('nonce-1');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/github\/agent\/oauth\/callback$/);
  });

  it('throws GithubAgentAppNotConfiguredError when the App is unwired (AC4)', () => {
    vi.stubEnv('GITHUB_AGENT_APP_CLIENT_SECRET', '');
    expect(() => githubAgentAuthService.buildAuthorizeUrl('s')).toThrow(
      GithubAgentAppNotConfiguredError,
    );
  });
});

describe('completeOAuthCallback (AC1)', () => {
  it('stores BOTH tokens encrypted — never plaintext — with their expiries', async () => {
    const user = await makeUser();
    const calls = mockGithub({ tokenResponses: [issued(1)], user: { id: 555, login: 'alice' } });

    const dto = await githubAgentAuthService.completeOAuthCallback({
      code: 'c0de',
      userId: user.id,
    });
    expect(dto).toMatchObject({ state: 'linked', githubLogin: 'alice' });

    const exchange = calls.find((c) => c.url.includes('/login/oauth/access_token'))!;
    expect(exchange.body).toMatchObject({
      client_id: 'Iv1.agentclient',
      client_secret: 'agent-secret',
      grant_type: 'authorization_code',
      code: 'c0de',
    });

    const row = await readRow(user.id);
    expect(row).not.toBeNull();
    expect(row!.githubUserId).toBe('555');
    expect(row!.accessTokenEncrypted).not.toContain('ghu_access_1');
    expect(row!.refreshTokenEncrypted).not.toContain('ghr_refresh_1');
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('ghu_access_1');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('ghr_refresh_1');
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * HOUR);
    expect(row!.refreshTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 100 * 24 * HOUR);
  });

  it('throws GithubOAuthExchangeError and stores nothing when GitHub refuses the code', async () => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [{ error: 'bad_verification_code' }] });
    await expect(
      githubAgentAuthService.completeOAuthCallback({ code: 'bad', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthExchangeError);
    expect(await readRow(user.id)).toBeNull();
  });
});

describe('getUserToken (AC2)', () => {
  async function linked(
    accessExpiresInMs: number,
    refreshExpiresInMs: number | null = 90 * 24 * HOUR,
  ) {
    const user = await makeUser();
    await withSystemContext((tx) =>
      githubAgentAuthorizationRepository.upsertForUser(
        {
          userId: user.id,
          githubUserId: '9',
          githubLogin: 'bob',
          accessTokenEncrypted: encryptToken('ghu_stored'),
          accessTokenExpiresAt: new Date(Date.now() + accessExpiresInMs),
          refreshTokenEncrypted: refreshExpiresInMs === null ? null : encryptToken('ghr_stored'),
          refreshTokenExpiresAt:
            refreshExpiresInMs === null ? null : new Date(Date.now() + refreshExpiresInMs),
        },
        tx,
      ),
    );
    return user;
  }

  it('returns the stored token while it is valid, and calls GitHub for nothing', async () => {
    const user = await linked(4 * HOUR);
    const calls = mockGithub({});
    const t = await githubAgentAuthService.getUserToken(user.id);
    expect(t).toEqual({ accessToken: 'ghu_stored', githubLogin: 'bob', githubUserId: '9' });
    expect(calls).toHaveLength(0);
  });

  it('refreshes a token inside the margin and persists the ROTATED pair', async () => {
    const user = await linked(2 * 60_000);
    const calls = mockGithub({ tokenResponses: [issued(2)] });
    const t = await githubAgentAuthService.getUserToken(user.id);
    expect(t.accessToken).toBe('ghu_access_2');
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_stored',
    });
    const row = await readRow(user.id);
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('ghu_access_2');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('ghr_refresh_2');
  });

  it('serialises concurrent refreshes: ONE call to GitHub, both callers get the new token', async () => {
    const user = await linked(-60_000);
    const calls = mockGithub({ tokenResponses: [issued(3), issued(4)] });
    const [a, b] = await Promise.all([
      githubAgentAuthService.getUserToken(user.id),
      githubAgentAuthService.getUserToken(user.id),
    ]);
    expect(a.accessToken).toBe('ghu_access_3');
    expect(b.accessToken).toBe('ghu_access_3');
    expect(calls.filter((c) => c.url.includes('/login/oauth/access_token'))).toHaveLength(1);
  });

  it('throws GithubAgentNotLinkedError for a member who never linked', async () => {
    const user = await makeUser();
    mockGithub({});
    await expect(githubAgentAuthService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubAgentNotLinkedError,
    );
  });

  it('throws GithubAgentAuthorizationExpiredError when the refresh token has expired', async () => {
    const user = await linked(-60_000, -60_000);
    mockGithub({});
    await expect(githubAgentAuthService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubAgentAuthorizationExpiredError,
    );
  });

  it('marks the link expired when GitHub refuses the refresh, and the status reads expired', async () => {
    const user = await linked(-60_000);
    mockGithub({ tokenResponses: [{ error: 'bad_refresh_token' }] });
    await expect(githubAgentAuthService.getUserToken(user.id)).rejects.toBeInstanceOf(
      GithubAgentAuthorizationExpiredError,
    );
    expect(await githubAgentAuthService.getLinkStatus(user.id)).toEqual({
      state: 'expired',
      githubLogin: 'bob',
    });
  });
});

describe('getLinkStatus', () => {
  it('reads not_configured, not_linked and linked', async () => {
    const user = await makeUser();
    expect(await githubAgentAuthService.getLinkStatus(user.id)).toEqual({ state: 'not_linked' });
    mockGithub({ tokenResponses: [issued(5)], user: { id: 1, login: 'carol' } });
    await githubAgentAuthService.completeOAuthCallback({ code: 'x', userId: user.id });
    expect(await githubAgentAuthService.getLinkStatus(user.id)).toMatchObject({
      state: 'linked',
      githubLogin: 'carol',
    });
    vi.stubEnv('GITHUB_AGENT_APP_CLIENT_ID', '');
    expect(await githubAgentAuthService.getLinkStatus(user.id)).toEqual({
      state: 'not_configured',
    });
  });
});

describe('unlink (AC3)', () => {
  it('revokes the token at GitHub with the App credentials and deletes the row', async () => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [issued(6)] });
    await githubAgentAuthService.completeOAuthCallback({ code: 'x', userId: user.id });
    const calls = mockGithub({});
    expect(await githubAgentAuthService.unlink(user.id)).toEqual({ unlinked: true });
    const revoke = calls.find((c) => c.method === 'DELETE')!;
    expect(revoke.url).toBe('https://api.github.com/applications/Iv1.agentclient/token');
    expect(revoke.body).toEqual({ access_token: 'ghu_access_6' });
    expect(revoke.headers.authorization).toBe(
      `Basic ${Buffer.from('Iv1.agentclient:agent-secret').toString('base64')}`,
    );
    expect(await readRow(user.id)).toBeNull();
  });

  it('still deletes the row when the revoke fails, and is idempotent', async () => {
    const user = await makeUser();
    mockGithub({ tokenResponses: [issued(7)] });
    await githubAgentAuthService.completeOAuthCallback({ code: 'x', userId: user.id });
    mockGithub({ revokeThrows: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await githubAgentAuthService.unlink(user.id)).toEqual({ unlinked: true });
    expect(warn).toHaveBeenCalled();
    expect(await readRow(user.id)).toBeNull();
    expect(await githubAgentAuthService.unlink(user.id)).toEqual({ unlinked: false });
    warn.mockRestore();
  });
});
