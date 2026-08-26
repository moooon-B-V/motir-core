import { describe, it, expect, vi, beforeEach } from 'vitest';

// The account two-factor routes (Story MOTIR-1213 · Subtask MOTIR-1218) — the
// TRANSPORT half: the session gate, the typed-error → status mapping, and the
// property that matters most on these two, which is WHOSE 2FA state a request
// can reach.
//
// The service is mocked to isolate the transport, per CLAUDE.md's thin-route
// contract; its behaviour is asserted against real Postgres in
// tests/twoFactorService.test.ts.

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

const getStatus = vi.fn();
const regenerateBackupCodes = vi.fn();
vi.mock('@/lib/services/twoFactorService', () => ({
  twoFactorService: {
    getStatus: (...args: unknown[]) => getStatus(...(args as [])),
    regenerateBackupCodes: (...args: unknown[]) => regenerateBackupCodes(...(args as [])),
  },
}));

const { GET } = await import('@/app/api/account/two-factor/status/route');
const { POST } = await import('@/app/api/account/two-factor/backup-codes/route');
const { getSession } = await import('@/lib/auth');
const { TwoFactorNotEnabledError } = await import('@/lib/twoFactor/errors');
const { UserNotFoundError } = await import('@/lib/users/errors');

const SESSION = { user: { id: 'user_ada', email: 'ada@example.com' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as never);
});

describe('GET /api/account/two-factor/status', () => {
  it('401s with no session', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('reads the SESSION’s user and nothing else — there is no id to pass in', async () => {
    // The property this route lives or dies on. A `?userId=` would turn a
    // personal read into an enumeration of everyone's 2FA posture, so the id
    // comes from the session and the handler takes no arguments at all.
    getStatus.mockResolvedValue({ enabled: true, methods: ['totp'] });

    await GET();
    expect(getStatus).toHaveBeenCalledWith('user_ada');
    expect(GET.length).toBe(0);
  });

  it('returns the DTO as the body', async () => {
    const dto = {
      enabled: true,
      methods: ['totp', 'email'],
      primaryMethod: 'totp',
      backupCodesRemaining: 7,
      backupCodesTotal: 10,
    };
    getStatus.mockResolvedValue(dto);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto);
  });

  it('401s — not 404 — when the session names a deleted account', async () => {
    // A live cookie for a user that is gone. The right answer is "sign in
    // again", not "no such thing".
    getStatus.mockRejectedValue(new UserNotFoundError('user_ada'));

    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'USER_NOT_FOUND' });
  });

  it('lets an unexpected error THROW — a 500 is not a code to invent', async () => {
    getStatus.mockRejectedValue(new Error('boom'));

    await expect(GET()).rejects.toThrow('boom');
  });
});

describe('POST /api/account/two-factor/backup-codes', () => {
  it('401s with no session, and mints nothing', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);

    const res = await POST();
    expect(res.status).toBe(401);
    // The important half: an unauthenticated call must not invalidate anyone's
    // existing codes as a side effect of being refused.
    expect(regenerateBackupCodes).not.toHaveBeenCalled();
  });

  it('returns the freshly minted set — the ONLY time the plaintext exists', async () => {
    regenerateBackupCodes.mockResolvedValue({ codes: ['aaaaa-11111'], remaining: 1 });

    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ codes: ['aaaaa-11111'], remaining: 1 });
    expect(regenerateBackupCodes).toHaveBeenCalledWith('user_ada');
  });

  it('409s when the account has no enrolment to regenerate for', async () => {
    // Not 404: the route exists and the user exists. It is the account's STATE
    // that refuses, which is what a conflict says.
    regenerateBackupCodes.mockRejectedValue(new TwoFactorNotEnabledError());

    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'TWO_FACTOR_NOT_ENABLED' });
  });

  it('is POST-only — a mutation must not be reachable by a prefetch', async () => {
    // Regenerating INVALIDATES every previously issued code, so a GET arm would
    // let a link preview or a history replay destroy a user's recovery set.
    const mod = await import('@/app/api/account/two-factor/backup-codes/route');
    expect(Object.keys(mod)).toEqual(['POST']);
  });
});
