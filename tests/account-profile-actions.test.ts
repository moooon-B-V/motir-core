import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { __resetRateLimitsForTest } from '@/lib/rateLimit/fixedWindow';
import { truncateAuthTables } from './helpers/db';

// Action-wiring tests for the Account › Profile security controls (Subtask
// 8.8.23). They prove the TRANSPORT layer — `actions.ts` — resolves the
// session, calls the right service method / framework primitive, and maps each
// outcome to the discriminated RESULT the pane (8.8.24) renders copy from.
//
// `getSession` + `auth` are the only mocks (the no-cookie test env). Note the
// service path itself (usersService.changePassword / getPasswordCapability)
// imports `@/lib/auth/passwords` — a DIFFERENT module from the mocked
// `@/lib/auth` — so every DB / hashing call still runs the real path against
// real Postgres.

const sessionState: {
  user: { id: string; email: string } | null;
} = { user: null };

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () =>
    sessionState.user ? { user: sessionState.user, session: { token: 'current-token' } } : null,
  ),
  auth: { api: { requestPasswordReset: vi.fn(async () => ({ status: true })) } },
}));

// `next/headers` throws outside a request scope (the vitest env has none);
// stub it so the set-password-link action can build the redirectTo origin.
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' })),
}));

const { auth } = await import('@/lib/auth');
const requestPasswordReset = vi.mocked(auth.api.requestPasswordReset);

const { changePasswordAction, sendSetPasswordLinkAction } =
  await import('@/app/(authed)/settings/account/profile/actions');

const CURRENT = 'current-password-1';
const NEW = 'a-new-password-2';

function actAs(user: { id: string; email: string }) {
  sessionState.user = user;
}

beforeEach(async () => {
  await truncateAuthTables();
  __resetRateLimitsForTest();
});

afterEach(() => {
  sessionState.user = null;
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('changePasswordAction', () => {
  it('changes the password and returns ok for a credential user', async () => {
    const user = await usersService.createUser({ email: 'cred@example.com', password: CURRENT });
    actAs({ id: user.id, email: user.email });

    const result = await changePasswordAction({ currentPassword: CURRENT, newPassword: NEW });
    expect(result).toEqual({ ok: true, revokedSessions: 0 });
    expect(await usersService.verifyPassword(user.email, NEW)).toBe(true);
  });

  it('maps a wrong current password to WRONG_CURRENT_PASSWORD', async () => {
    const user = await usersService.createUser({ email: 'cred@example.com', password: CURRENT });
    actAs({ id: user.id, email: user.email });

    const result = await changePasswordAction({ currentPassword: 'nope-nope', newPassword: NEW });
    expect(result).toEqual({ ok: false, code: 'WRONG_CURRENT_PASSWORD' });
  });

  it('maps a weak new password to WEAK_PASSWORD with a message', async () => {
    const user = await usersService.createUser({ email: 'cred@example.com', password: CURRENT });
    actAs({ id: user.id, email: user.email });

    const result = await changePasswordAction({ currentPassword: CURRENT, newPassword: 'short' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('WEAK_PASSWORD');
  });

  it('rate-limits after too many attempts', async () => {
    const user = await usersService.createUser({ email: 'cred@example.com', password: CURRENT });
    actAs({ id: user.id, email: user.email });

    // 5 allowed attempts (all wrong-current here), the 6th is rate-limited.
    for (let i = 0; i < 5; i++) {
      const r = await changePasswordAction({ currentPassword: 'wrong', newPassword: NEW });
      expect(r).toEqual({ ok: false, code: 'WRONG_CURRENT_PASSWORD' });
    }
    const limited = await changePasswordAction({ currentPassword: CURRENT, newPassword: NEW });
    expect(limited).toEqual({ ok: false, code: 'RATE_LIMITED' });
  });
});

describe('sendSetPasswordLinkAction', () => {
  it('triggers the shipped reset flow for an OAuth-only user', async () => {
    const user = await usersService.findOrCreateOAuthUser({
      provider: 'google',
      providerAccountId: 'g-1',
      email: 'oauth@example.com',
      name: 'Oauth',
    });
    actAs({ id: user.id, email: user.email });

    const result = await sendSetPasswordLinkAction();
    expect(result).toEqual({ ok: true });
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(requestPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          email: 'oauth@example.com',
          redirectTo: expect.stringMatching(/\/reset-password\/new$/),
        }),
      }),
    );
  });

  it('refuses (ALREADY_HAS_PASSWORD) for a credential user, without sending', async () => {
    const user = await usersService.createUser({ email: 'cred@example.com', password: CURRENT });
    actAs({ id: user.id, email: user.email });

    const result = await sendSetPasswordLinkAction();
    expect(result).toEqual({ ok: false, code: 'ALREADY_HAS_PASSWORD' });
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});
