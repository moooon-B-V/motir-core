import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
const { createUser, verifyPassword } = usersService;
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import {
  captureConsoleEmails,
  captureEmailEvents,
  runEmailSendJob,
  type CapturedEmailEvent,
} from './helpers/jobs';

// Integration tests for Better-Auth's password-reset flow against a real
// Postgres. Token storage / single-use / expiry semantics are owned by
// Better-Auth — we test the contract we care about (Verification row
// shape, single-use, expiry, no-enumeration, rate-limit), not Better-Auth
// internals. The rate-limit suite is in a separate describe block at the
// bottom because it shares Better-Auth's in-memory limiter state across
// cases and needs deterministic ordering.
//
// Story 1.6.3: the reset email is no longer sent inline — sendResetPassword
// now ENQUEUES an `email.send` event (better-auth awaits the hook, so the
// event is published by the time requestPasswordReset resolves). So these
// tests capture the enqueued event (via the inngest.send spy in
// captureEmailEvents) and read the reset token off its idempotencyKey,
// instead of grepping an `[EMAIL]` console line. One test additionally drives
// the `email.send` job in-process to prove the queued event ultimately
// renders + sends with the token.

const BASE_URL = 'http://localhost:3000';

// Best-effort header-only origin spoof for the handler-based requests
// below. The originCheck middleware compares against `baseURL` (set to
// http://localhost:3000 in lib/auth/index.ts), so this Origin satisfies it.
function buildHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    'content-type': 'application/json',
    origin: BASE_URL,
    ...(extra ?? {}),
  };
}

// The reset token IS the enqueued event's idempotency key (lib/auth/index.ts).
function tokenFromEvent(event: CapturedEmailEvent): string {
  const token = event.data.idempotencyKey;
  if (!token) throw new Error('No idempotencyKey on the captured email.send event');
  return token;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('forget-password (auth.api.requestPasswordReset)', () => {
  let captured: ReturnType<typeof captureEmailEvents>;

  beforeEach(() => {
    captured = captureEmailEvents();
  });

  afterEach(() => {
    captured.restore();
  });

  it('creates a Verification row and enqueues the reset email with the token', async () => {
    const user = await createUser({
      email: 'reset-1@example.com',
      password: 'hunter2hunter2',
      name: 'Reset One',
    });

    await auth.api.requestPasswordReset({
      body: {
        email: 'reset-1@example.com',
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });

    // Exactly one email.send event was enqueued, cross-workspace (null), with
    // the password-reset template addressed to the requesting user.
    expect(captured.events).toHaveLength(1);
    const event = captured.events[0]!;
    expect(event.data.template).toBe('password-reset');
    expect(event.data.to).toBe('reset-1@example.com');
    expect(event.data.workspaceId).toBeNull();

    const token = tokenFromEvent(event);
    expect(token.length).toBeGreaterThan(0);
    // The token threads into the reset URL the template will render.
    if (event.data.template === 'password-reset') {
      expect(event.data.data.resetUrl).toContain(token);
    }

    // Verification row is keyed by `reset-password:<token>`, with the
    // value being the user id — see better-auth/dist/api/routes/password.mjs.
    const row = await db.verification.findFirst({
      where: { identifier: `reset-password:${token}` },
    });
    expect(row).not.toBeNull();
    expect(row!.value).toBe(user.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // End-to-end: draining the queued event through the email.send job renders
    // + dispatches the reset email, with the token unredacted in the body.
    const emails = captureConsoleEmails();
    try {
      await runEmailSendJob(event.data);
      expect(emails.lines).toHaveLength(1);
      expect(emails.lines[0]).toContain('To: reset-1@example.com');
      expect(emails.lines[0]).toContain(token);
    } finally {
      emails.restore();
    }
  });

  it('returns success silently and enqueues nothing for an unknown address (no enumeration)', async () => {
    const result = await auth.api.requestPasswordReset({
      body: {
        email: 'ghost@example.com',
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });

    expect(result.status).toBe(true);
    expect(captured.events).toHaveLength(0);

    const rowCount = await db.verification.count();
    expect(rowCount).toBe(0);
  });
});

describe('reset-password (auth.api.resetPassword)', () => {
  let captured: ReturnType<typeof captureEmailEvents>;

  beforeEach(() => {
    captured = captureEmailEvents();
  });

  afterEach(() => {
    captured.restore();
  });

  it('rotates the credential password hash and consumes the token (single-use)', async () => {
    await createUser({
      email: 'reset-2@example.com',
      password: 'oldpassword12',
      name: 'Reset Two',
    });

    await auth.api.requestPasswordReset({
      body: {
        email: 'reset-2@example.com',
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });
    const token = tokenFromEvent(captured.events[0]!);

    await auth.api.resetPassword({
      body: { token, newPassword: 'newpassword12' },
    });

    // The new password works; the old one does not — exercised against
    // the same argon2 verify path the login flow uses.
    expect(await verifyPassword('reset-2@example.com', 'newpassword12')).toBe(true);
    expect(await verifyPassword('reset-2@example.com', 'oldpassword12')).toBe(false);

    // Single-use: Better-Auth deletes the Verification row after a
    // successful reset (deleteVerificationByIdentifier in password.mjs).
    const rowAfter = await db.verification.findFirst({
      where: { identifier: `reset-password:${token}` },
    });
    expect(rowAfter).toBeNull();

    // A second reset attempt with the same token must fail — the row is
    // gone, so the handler hits the INVALID_TOKEN branch.
    await expect(
      auth.api.resetPassword({
        body: { token, newPassword: 'anotherpassword12' },
      }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });
  });

  it('rejects an expired token', async () => {
    await createUser({
      email: 'reset-3@example.com',
      password: 'oldpassword12',
      name: 'Reset Three',
    });

    await auth.api.requestPasswordReset({
      body: {
        email: 'reset-3@example.com',
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });
    const token = tokenFromEvent(captured.events[0]!);

    // Backdate the row's expiry — simulates the user clicking the link
    // after the 1-hour window. We touch the DB directly rather than wait
    // an hour; the handler in better-auth's password.mjs checks
    // `verification.expiresAt < new Date()` so any past timestamp suffices.
    await db.verification.update({
      where: {
        id: (
          await db.verification.findFirstOrThrow({
            where: { identifier: `reset-password:${token}` },
          })
        ).id,
      },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(
      auth.api.resetPassword({
        body: { token, newPassword: 'newpassword12' },
      }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });

    // The old password should still verify — the reset never landed.
    expect(await verifyPassword('reset-3@example.com', 'oldpassword12')).toBe(true);
  });
});

describe('rate limit on /request-password-reset', () => {
  // This block goes through auth.handler() with real synthetic Requests so
  // the rate-limiter middleware actually runs. The limiter keys by client
  // IP; getIp() falls back to 127.0.0.1 in test/dev when no
  // x-forwarded-for header is present, which is fine for this case —
  // every request in the loop shares the same key, so the 4th one trips
  // the configured 3/hour limit.
  //
  // Better-Auth's in-memory rate-limit storage is process-wide, so other
  // test files in this suite that touch /request-password-reset would
  // share state with this one. They don't (auth.api.* direct calls bypass
  // the limiter entirely, as the limiter requires a Request). If that
  // changes, this test should pin a unique x-forwarded-for IP per case.
  //
  // captureEmailEvents is installed so the inngest.send the hook fires per
  // allowed request resolves in-process (no dev server) — and we assert the
  // 3 allowed requests each enqueued one event while the rate-limited 4th
  // enqueued nothing.
  let captured: ReturnType<typeof captureEmailEvents>;

  beforeEach(() => {
    captured = captureEmailEvents();
  });

  afterEach(() => {
    captured.restore();
  });

  async function postForgetPassword(email: string): Promise<Response> {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/request-password-reset`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          email,
          redirectTo: `${BASE_URL}/reset-password`,
        }),
      }),
    );
  }

  it('allows 3 requests in the window and rejects the 4th', async () => {
    await createUser({
      email: 'rl@example.com',
      password: 'hunter2hunter2',
      name: 'RL',
    });

    const r1 = await postForgetPassword('rl@example.com');
    const r2 = await postForgetPassword('rl@example.com');
    const r3 = await postForgetPassword('rl@example.com');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const r4 = await postForgetPassword('rl@example.com');
    expect(r4.status).toBe(429);

    // Only the 3 allowed requests enqueued a send; the 429 enqueued nothing.
    expect(captured.events).toHaveLength(3);
  });
});
