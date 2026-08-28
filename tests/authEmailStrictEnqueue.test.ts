import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { AuthEmailUnavailableError, withAuthMailOutcome } from '@/lib/auth/authMail';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { emailChangeRequestRepository } from '@/lib/repositories/emailChangeRequestRepository';
import { POST as authRoutePost } from '@/app/api/auth/[...all]/route';
import { POST as emailChangeRoutePost } from '@/app/api/account/request-email-change/route';
import { createTestWorkItem, makeWorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from './helpers/db';
import { spyOnJobDispatch } from './helpers/jobs';

// Bug MOTIR-3583 — an AUTHENTICATION email whose enqueue fails is no longer
// silently dropped.
//
// The property under test is a SPLIT, so every case here is one half of a pair:
// the three auth emails REJECT when the queue is unreachable, and every other
// emitter still RESOLVES. A suite that only proved the first half would be green
// on the change this card explicitly refuses — making `sendEvent` strict
// wholesale, which re-opens PROD-443 across every optimistic surface.
//
// Real Postgres and the real better-auth handler throughout; the ONE thing
// substituted is the transport, by rejecting `inngest.send` — which is the
// outage being modelled. (`dispatchToLanes` reaches the Inngest lane because no
// `email.send` subscriber is routed to the Postgres engine in this environment;
// the engine dispatch returns before doing any work when its routed set is
// empty.)

const BASE_URL = 'http://localhost:3000';

/** The transport is down. Every enqueue on this test fails at the Inngest lane. */
function breakTheQueue(): void {
  spyOnJobDispatch().mockRejectedValue(new Error('queue unreachable'));
}

/** The transport is up, and nothing reaches the network. */
function workingQueue(): void {
  spyOnJobDispatch();
}

function authRequest(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify(body),
  });
}

let previousRateLimitFlag: string | undefined;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // The app-level auth guard (MOTIR-1165) reads this at CALL time, so setting it
  // here is enough to keep a 429 from standing in for the 503 under test. It is
  // the same switch `playwright.config.ts` sets, never production.
  previousRateLimitFlag = process.env['E2E_DISABLE_RATE_LIMIT'];
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
  // Silence the transport's own `console.error` — the log line is asserted where
  // it is the subject (`tests/twoFactorOtpDispatch.test.ts`), not here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousRateLimitFlag === undefined) delete process.env['E2E_DISABLE_RATE_LIMIT'];
  else process.env['E2E_DISABLE_RATE_LIMIT'] = previousRateLimitFlag;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const OTP_ARGS = { userId: 'user_1', email: 'ada@example.com', name: 'Ada', otp: '314159' };

describe('the `strict` argument on `sendEvent`', () => {
  it('is OFF by default — the post-commit contract is unchanged', async () => {
    breakTheQueue();

    await expect(
      sendEvent('email.send', {
        workspaceId: null,
        idempotencyKey: 'best-effort-tok',
        to: 'someone@example.com',
        template: 'password-reset',
        data: { recipientName: 'Ada', resetUrl: `${BASE_URL}/x`, locale: 'en' },
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates the transport failure when the caller asks for it', async () => {
    breakTheQueue();

    await expect(
      sendEvent(
        'email.send',
        {
          workspaceId: null,
          idempotencyKey: 'strict-tok',
          to: 'someone@example.com',
          template: 'password-reset',
          data: { recipientName: 'Ada', resetUrl: `${BASE_URL}/x`, locale: 'en' },
        },
        { strict: true },
      ),
    ).rejects.toThrow('queue unreachable');
  });

  it('still throws its own ARGUMENT validation, which was never a transport error', async () => {
    workingQueue();

    await expect(
      // @ts-expect-error — the missing workspaceId is the point; this is the
      // untyped-boundary shape the runtime guard exists for.
      sendEvent('email.send', { to: 'a@example.com', template: 'password-reset', data: {} }),
    ).rejects.toThrow(/requires an explicit workspaceId/);
  });
});

describe('the three AUTHENTICATION emails reject an enqueue failure', () => {
  it('the 2FA email-OTP dispatch', async () => {
    breakTheQueue();

    await expect(twoFactorService.dispatchOtpEmail(OTP_ARGS)).rejects.toBeInstanceOf(
      AuthEmailUnavailableError,
    );
  });

  it("better-auth's `sendResetPassword` hook", async () => {
    breakTheQueue();
    const hook = auth.options.emailAndPassword?.sendResetPassword;
    expect(hook).toBeTypeOf('function');

    await expect(
      hook!({
        user: { id: 'u1', email: 'ada@example.com', name: 'Ada' } as never,
        url: `${BASE_URL}/reset-password/tok`,
        token: 'tok',
      }),
    ).rejects.toBeInstanceOf(AuthEmailUnavailableError);
  });

  it('the email-change request', async () => {
    const user = await usersService.createUser({
      email: 'old@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });
    breakTheQueue();

    await expect(
      usersService.requestEmailChange(user.id, 'new@example.com'),
    ).rejects.toBeInstanceOf(AuthEmailUnavailableError);
  });

  it('and the email-change RETRY succeeds once the queue is back — the pending row does not strand the address', async () => {
    const user = await usersService.createUser({
      email: 'old2@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });
    breakTheQueue();
    await expect(usersService.requestEmailChange(user.id, 'next@example.com')).rejects.toThrow();

    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    workingQueue();

    const { token } = await usersService.requestEmailChange(user.id, 'next@example.com');
    const row = await emailChangeRequestRepository.findByTokenUnsafe(token);
    expect(row?.newEmail).toBe('next@example.com');
  });
});

describe('every OTHER emitter is untouched — the PROD-443 contract', () => {
  it('a work-item transition still resolves with the queue down', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Ship it' });
    // The fixture writes through the REPOSITORY, which skips the service's
    // initial-status lookup and leaves the column default — so pin the workflow's
    // real initial status first, exactly as the derivation suites do.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
    breakTheQueue();

    // The committed transition is what the user keeps; the notification about it
    // is not worth failing the request for. That asymmetry is the whole reason
    // the strict flag is an argument rather than a new default.
    await expect(
      workItemsService.updateStatus(item.id, 'in_progress', fx.ctx),
    ).resolves.toMatchObject({ id: item.id });

    const persisted = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(persisted?.status).toBe('in_progress');
  });
});

describe('the SURFACE is told, not just the log', () => {
  it("the auth route answers 503 when a reset email could not be queued — better-auth's own success is corrected", async () => {
    await usersService.createUser({
      email: 'reset@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });
    breakTheQueue();

    const res = await authRoutePost(
      authRequest('/api/auth/request-password-reset', {
        email: 'reset@example.com',
        redirectTo: `${BASE_URL}/reset-password/new`,
      }),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'AUTH_EMAIL_UNAVAILABLE' });
  });

  it('and 200 when it could — the anti-enumeration screen is unchanged in the ordinary case', async () => {
    await usersService.createUser({
      email: 'reset-ok@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });
    workingQueue();

    const res = await authRoutePost(
      authRequest('/api/auth/request-password-reset', {
        email: 'reset-ok@example.com',
        redirectTo: `${BASE_URL}/reset-password/new`,
      }),
    );

    expect(res.status).toBe(200);
  });

  it('an UNKNOWN address is still 200 with the queue down — nothing about the outage is per-account', async () => {
    breakTheQueue();

    const res = await authRoutePost(
      authRequest('/api/auth/request-password-reset', {
        email: 'nobody@example.com',
        redirectTo: `${BASE_URL}/reset-password/new`,
      }),
    );

    // better-auth never reaches the send hook for an address it cannot find, so
    // no failure is recorded and the confirmation screen stands.
    expect(res.status).toBe(200);
  });

  it('better-auth is NOT configured to run its hooks in the BACKGROUND — the correction depends on it', async () => {
    // ⚠️ A GUARD ON A CONFIG NOBODY HAS SET, because setting it would break the
    // 503 above silently. `runInBackgroundOrAwait` AWAITS the send hook only
    // while `advanced.backgroundTasks.handler` is absent; supply one and the
    // hook is detached, the request returns before it runs, and the failure is
    // recorded on an outcome nobody is reading any more. The response would go
    // back to claiming a send, with every test but this one still green.
    const advanced = auth.options.advanced as { backgroundTasks?: unknown } | undefined;
    expect(advanced?.backgroundTasks).toBeUndefined();
  });

  it('`withAuthMailOutcome` reports a clean run as clean', async () => {
    workingQueue();

    const { enqueueFailed } = await withAuthMailOutcome(() =>
      twoFactorService.dispatchOtpEmail(OTP_ARGS),
    );

    expect(enqueueFailed).toBe(false);
  });
});

describe('the email-change route maps the failure to a retryable status', () => {
  it('503 with the typed code, so the modal can say "try again"', async () => {
    const user = await usersService.createUser({
      email: 'change@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });
    const authModule = await import('@/lib/auth');
    vi.spyOn(authModule, 'getSession').mockResolvedValue({
      user: { id: user.id },
    } as Awaited<ReturnType<typeof authModule.getSession>>);
    breakTheQueue();

    const res = await emailChangeRoutePost(
      new Request(`${BASE_URL}/api/account/request-email-change`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newEmail: 'changed@example.com' }),
      }),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'AUTH_EMAIL_UNAVAILABLE' });
  });
});
