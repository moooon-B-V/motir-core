import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { AuthEmailUnavailableError } from '@/lib/auth/authMail';
import { TWO_FACTOR_OTP_PERIOD_MINUTES } from '@/lib/auth/twoFactorConfig';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  captureConsoleEmails,
  captureEmailEvents,
  runEmailSendJob,
  spyOnJobDispatch,
} from './helpers/jobs';

// Story MOTIR-1213 · Subtask MOTIR-1218 — the email-OTP dispatch seam.
//
// The card's acceptance criterion is "the send happens post-commit; an injected
// send failure leaves the challenge row intact and returns success for the core
// mutation". The shipped shape delivers that by ENQUEUEING rather than sending:
// Better-Auth's plugin has already persisted the hashed challenge through its
// own adapter by the time `sendOTP` fires, and `dispatchOtpEmail` publishes an
// `email.send` event and returns. The provider is reached later, inside the
// durable job, where a failure is a RETRY rather than a request error.
//
// So the two halves are tested where they actually live: the enqueue here, and
// the delivery by driving the real job in-process.

let emailEvents: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  emailEvents = captureEmailEvents();
});

afterEach(() => {
  emailEvents.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ARGS = {
  userId: 'user_1',
  email: 'ada@example.com',
  name: 'Ada',
  otp: '314159',
};

describe('dispatchOtpEmail', () => {
  it('ENQUEUES the code rather than sending it — nothing reaches a provider', async () => {
    const console = captureConsoleEmails();
    try {
      await twoFactorService.dispatchOtpEmail(ARGS);

      expect(emailEvents.events).toHaveLength(1);
      // The dev-console provider is what a real send would print through. It
      // must be silent here: the send has not happened yet, and that is the
      // entire property — the request the user is waiting on never blocks on a
      // provider.
      expect(console.lines).toEqual([]);
    } finally {
      console.restore();
    }
  });

  it('carries the whole envelope the job needs', async () => {
    await twoFactorService.dispatchOtpEmail(ARGS);

    const [event] = emailEvents.events;
    expect(event!.data.to).toBe('ada@example.com');
    expect(event!.data.template).toBe('two-factor-otp');
    // Identity-scoped: the challenge runs before a session exists, so there is
    // no workspace to attribute the mail to.
    expect(event!.data.workspaceId).toBeNull();
    expect(event!.data.data).toMatchObject({
      recipientName: 'Ada',
      code: '314159',
      // The expiry the email STATES is the plugin's configured period, read
      // from the same constant, so the copy cannot drift from the enforcement.
      expiresInMinutes: TWO_FACTOR_OTP_PERIOD_MINUTES,
    });
  });

  it('keys idempotency on the ISSUANCE, so a resend is a second mail', async () => {
    await twoFactorService.dispatchOtpEmail(ARGS);
    // The same code re-fired (a double-submitted button) — one delivery.
    await twoFactorService.dispatchOtpEmail(ARGS);
    // A genuinely new code (the user pressed "resend") — a second delivery.
    await twoFactorService.dispatchOtpEmail({ ...ARGS, otp: '271828' });

    const keys = emailEvents.events.map((e) => e.data.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('falls back to a greeting when the account has no name', async () => {
    await twoFactorService.dispatchOtpEmail({ ...ARGS, name: '' });

    expect(emailEvents.events[0]!.data.data).toMatchObject({ recipientName: 'there' });
  });

  it('REJECTS an enqueue failure — INVERTED from the pinned swallow (MOTIR-3583)', async () => {
    // ⚠️ THIS CASE USED TO ASSERT THE OPPOSITE, and it is inverted rather than
    // deleted because the swallow was a real, deliberate contract and the record
    // of why it did not fit HERE is the point.
    //
    // What it pinned: `dispatchToLanes` caught a transport failure on both lanes
    // and logged it, because every other caller emits after a committed mutation
    // and a throw there would turn a saved change into a 500 with a reverting
    // optimistic UI (PROD-443). Correct for those callers, and still their
    // contract — `tests/authEmailStrictEnqueue.test.ts` holds a work-item
    // transition to it.
    //
    // Why it did not fit: there is no committed mutation for the user to keep on
    // this path, so the swallow preserved nothing. The challenge screen said
    // "check your email", no code arrived, and the retry failed the same silent
    // way. `dispatchOtpEmail` takes the strict door now (`lib/auth/authMail.ts`),
    // and the log line stays — it was never the problem, it was just the only
    // signal that existed. It moves, though: the strict lane in `dispatchToLanes`
    // rethrows instead of logging, so `sendAuthEmail` is what writes it now.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    spyOnJobDispatch().mockRejectedValueOnce(new Error('queue unreachable'));

    await expect(twoFactorService.dispatchOtpEmail(ARGS)).rejects.toBeInstanceOf(
      AuthEmailUnavailableError,
    );
    expect(logged.mock.calls.flat().join(' ')).toContain('email.send');
  });
});

describe('the durable delivery half', () => {
  it('the email.send job renders the 2FA template and the code reaches the provider', async () => {
    await twoFactorService.dispatchOtpEmail(ARGS);
    const [event] = emailEvents.events;

    const console = captureConsoleEmails();
    try {
      await runEmailSendJob(event!.data);
      // The dev-console provider prints the plain-text body; the code must be
      // readable in it verbatim (the greppable contract MOTIR-1219 preserves).
      expect(console.lines.join('\n')).toContain('314159');
    } finally {
      console.restore();
    }
  });

  it('a PROVIDER failure is the JOB’s problem — it never reaches the enqueuing caller', async () => {
    // This is the criterion's real content. `dispatchOtpEmail` has already
    // returned successfully; the provider blowing up afterwards is a failed job
    // run that Inngest retries. Nothing rolls back, and the challenge row the
    // plugin wrote is untouched because nothing in this path writes to it.
    await twoFactorService.dispatchOtpEmail(ARGS);
    const [event] = emailEvents.events;

    const emailModule = await import('@/lib/email');
    vi.spyOn(emailModule, 'sendEmail').mockRejectedValue(new Error('provider down'));

    // The test engine reports a failed run as an `error` on the returned state
    // rather than by rejecting — a failed run is data, which is precisely what
    // makes it retryable rather than a request error.
    const outcome = (await runEmailSendJob(event!.data)) as { error?: { message?: string } };
    expect(outcome.error?.message).toContain('provider down');

    // The caller's own call still succeeded — it is not retried, not reversed,
    // and returned before the provider was ever consulted.
    expect(emailEvents.events).toHaveLength(1);
  });
});
