import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { decryptToken } from '@/lib/github/tokenCrypto';
import { GithubOAuthExchangeError, GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-1498 — the OAuth user-identity grant service, against a
// real Postgres (the motir-core convention). The GitHub HTTP calls are stubbed
// per-test via a global `fetch` mock — the flow never reaches GitHub.

const PASSWORD = 'hunter2hunter2';

interface GithubUserShape {
  id: number;
  login: string;
  avatar_url?: string | null;
}

/** Install a `fetch` mock that answers the two GitHub endpoints the flow hits. */
function mockGithub(opts: {
  token?: string | null;
  user?: GithubUserShape;
  tokenStatus?: number;
  userStatus?: number;
}): void {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/login/oauth/access_token')) {
      const body =
        opts.token === null
          ? { error: 'bad_verification_code' }
          : { access_token: opts.token ?? 'gho_default_token' };
      return new Response(JSON.stringify(body), {
        status: opts.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.github.com/user')) {
      const user = opts.user ?? { id: 4242, login: 'octocat', avatar_url: 'https://gh/av.png' };
      return new Response(JSON.stringify(user), {
        status: opts.userStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function makeUser(email = 'member@example.com') {
  return usersService.createUser({ email, password: PASSWORD, name: 'Member' });
}

/** Count identity rows bypassing RLS (system context) — the raw `db` singleton
 *  binds no GUC, so RLS would hide every row. */
function countIdentities(): Promise<number> {
  return withSystemContext((tx) => tx.githubIdentity.count());
}

/**
 * Run `fn` inside a transaction that binds the `app.user_id` GUC and drops to
 * the non-bypass `prodect_app` role — the role switch is what makes the RLS
 * policy actually bite (the default test superuser bypasses even FORCE). Mirrors
 * the local helper in tests/project-rls.test.ts.
 */
async function asAppRole<T>(
  ctx: { userId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('githubIdentityService.buildAuthorizeUrl', () => {
  it('builds the GitHub authorize URL carrying client_id, redirect_uri and state', () => {
    const url = new URL(githubIdentityService.buildAuthorizeUrl('the-state-nonce'));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(process.env['GITHUB_APP_CLIENT_ID']);
    expect(url.searchParams.get('state')).toBe('the-state-nonce');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/github/oauth/callback');
  });

  it('throws GithubOAuthNotConfiguredError when the app is unwired', () => {
    vi.stubEnv('GITHUB_APP_CLIENT_SECRET', '');
    expect(() => githubIdentityService.buildAuthorizeUrl('s')).toThrow(
      GithubOAuthNotConfiguredError,
    );
  });
});

describe('githubIdentityService.completeOAuthCallback', () => {
  it('persists an identity bound to the member with the token ENCRYPTED, and returns a token-free DTO', async () => {
    const user = await makeUser();
    mockGithub({
      token: 'gho_real_token',
      user: { id: 999, login: 'alice', avatar_url: 'https://x/a.png' },
    });

    const dto = await githubIdentityService.completeOAuthCallback({ code: 'abc', userId: user.id });

    expect(dto).toMatchObject({
      githubUserId: '999',
      githubLogin: 'alice',
      avatarUrl: 'https://x/a.png',
    });
    // The DTO must not carry the token in any form.
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('accessTokenEncrypted');

    const row = await withSystemContext((tx) => githubIdentityRepository.findByUserId(user.id, tx));
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);
    expect(row!.accessTokenEncrypted).not.toBe('gho_real_token'); // stored encrypted
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('gho_real_token'); // recoverable
  });

  it('upserts on re-auth — one row per member, refreshed in place', async () => {
    const user = await makeUser();

    mockGithub({ token: 'tok1', user: { id: 5, login: 'old-login', avatar_url: 'u1' } });
    const first = await githubIdentityService.completeOAuthCallback({
      code: 'c1',
      userId: user.id,
    });

    mockGithub({ token: 'tok2', user: { id: 5, login: 'new-login', avatar_url: 'u2' } });
    const second = await githubIdentityService.completeOAuthCallback({
      code: 'c2',
      userId: user.id,
    });

    expect(second.id).toBe(first.id); // same row
    expect(second.githubLogin).toBe('new-login');
    expect(second.avatarUrl).toBe('u2');
    expect(await countIdentities()).toBe(1);

    const row = await withSystemContext((tx) => githubIdentityRepository.findByUserId(user.id, tx));
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('tok2'); // token refreshed too
  });

  it('throws GithubOAuthExchangeError when the code exchange returns no token', async () => {
    const user = await makeUser();
    mockGithub({ token: null }); // { error: 'bad_verification_code' }
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'bad', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthExchangeError);
    expect(await countIdentities()).toBe(0);
  });

  it('throws GithubOAuthExchangeError when the GitHub user read fails', async () => {
    const user = await makeUser();
    mockGithub({ token: 'tok', userStatus: 401 });
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthExchangeError);
    expect(await countIdentities()).toBe(0);
  });

  it('throws GithubOAuthNotConfiguredError when the app is unwired', async () => {
    const user = await makeUser();
    vi.stubEnv('GITHUB_APP_CLIENT_ID', '');
    await expect(
      githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id }),
    ).rejects.toBeInstanceOf(GithubOAuthNotConfiguredError);
  });
});

describe('githubIdentityService.getIdentityForUser', () => {
  it('returns null when the member has no identity (a valid state, not an error)', async () => {
    const user = await makeUser();
    expect(await githubIdentityService.getIdentityForUser(user.id)).toBeNull();
  });

  it('returns the token-free DTO once bound, preserving a null avatar', async () => {
    const user = await makeUser();
    mockGithub({ token: 't', user: { id: 7, login: 'zed', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });

    const got = await githubIdentityService.getIdentityForUser(user.id);
    expect(got).toMatchObject({ githubUserId: '7', githubLogin: 'zed', avatarUrl: null });
    expect(got).not.toHaveProperty('accessTokenEncrypted');
  });

  it("is RLS-isolated — the migration policy hides another member's row under the app role", async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    mockGithub({ token: 't', user: { id: 11, login: 'alice-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: alice.id });

    // Same `where user_id = alice` read, run as prodect_app: bound to BOB's GUC
    // the policy hides Alice's row; bound to Alice's GUC her own row is visible.
    const underBob = await asAppRole({ userId: bob.id }, (tx) =>
      githubIdentityRepository.findByUserId(alice.id, tx),
    );
    expect(underBob).toBeNull();

    const underAlice = await asAppRole({ userId: alice.id }, (tx) =>
      githubIdentityRepository.findByUserId(alice.id, tx),
    );
    expect(underAlice).not.toBeNull();
  });
});

describe('githubIdentityService.disconnect', () => {
  it("unbinds the member's identity, leaving no row", async () => {
    const user = await makeUser();
    mockGithub({ token: 't', user: { id: 21, login: 'gone', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: user.id });
    expect(await countIdentities()).toBe(1);

    await githubIdentityService.disconnect(user.id);

    expect(await countIdentities()).toBe(0);
    expect(await githubIdentityService.getIdentityForUser(user.id)).toBeNull();
  });

  it('is idempotent — disconnecting an unbound member is a no-op', async () => {
    const user = await makeUser();
    await expect(githubIdentityService.disconnect(user.id)).resolves.toBeUndefined();
    expect(await countIdentities()).toBe(0);
  });

  it("removes only the acting member's identity, not another member's", async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    mockGithub({ token: 't', user: { id: 1, login: 'alice-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: alice.id });
    mockGithub({ token: 't', user: { id: 2, login: 'bob-gh', avatar_url: null } });
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: bob.id });
    expect(await countIdentities()).toBe(2);

    await githubIdentityService.disconnect(alice.id);

    expect(await countIdentities()).toBe(1);
    expect(await githubIdentityService.getIdentityForUser(alice.id)).toBeNull();
    expect(await githubIdentityService.getIdentityForUser(bob.id)).not.toBeNull();
  });
});
