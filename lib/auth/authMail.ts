import { AsyncLocalStorage } from 'node:async_hooks';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { JobEventData } from '@/lib/jobs/types';

// THE AUTHENTICATION EMAILS — the one class of mail whose enqueue failure the
// user has to hear about (Bug MOTIR-3583).
//
// ── WHY THESE THREE AND NOTHING ELSE ──────────────────────────────────────
// `sendEvent` is best-effort by design and that design is right for every
// caller it was written for: they all emit AFTER a committed `$transaction`, so
// a throw would turn a saved change into a 500 and the optimistic UI would
// revert a change the database kept (PROD-443). An AUTHENTICATION email inverts
// every term. The OTP challenge row and the reset token exist ONLY to be
// answered by a message that is not going to arrive, so the swallow protects
// nothing: the screen says "check your email", the inbox stays empty, and the
// retry button re-runs the identical silent failure. The only evidence anywhere
// is a `console.error` reaching an operator who is not watching.
//
// So the three of them opt IN, one call at a time, and every other emitter's
// contract stays byte-identical. Widening the default instead would re-open
// PROD-443 across every optimistic surface in the product and is the version of
// this fix to refuse.
//
// ── ⚠️ WHY THERE IS A PER-REQUEST FLAG AND NOT JUST A THROW ───────────────
// Two of the three are BETTER-AUTH HOOKS, and better-auth@1.6.11 swallows what
// they throw — verified in `node_modules`, not inferred:
//
//   * `sendResetPassword` is invoked through `ctx.context.runInBackgroundOrAwait`
//     (`dist/context/create-context.mjs`), whose whole body is a `try { await
//     promise } catch (e) { logger.error(...) }`. The endpoint then returns
//     `{ status: true }`.
//   * the two-factor plugin is more explicit still: it attaches
//     `sendOTPResult.catch((e) => ctx.context.logger.error(...))` BEFORE handing
//     the promise over (`dist/plugins/two-factor/otp/index.mjs`), and returns
//     `{ status: true }`.
//
// A strict `sendEvent` alone therefore changes nothing a user can see on those
// two paths — the swallow simply moves one frame outwards. What reaches the
// surface is this: the failure is RECORDED on the in-flight request before it is
// rethrown, and `app/api/auth/[...all]/route.ts` turns a recorded failure into a
// 503 instead of the framework's success. The store is an `AsyncLocalStorage`
// rather than a module variable because Next.js serves concurrent requests in
// one process, and a module variable would attribute one user's outage to
// another user's request.
//
// The third caller, `usersService.requestEmailChange`, is reached through our
// OWN route, so the throw propagates on its own and the flag is simply unused
// there. It still goes through this door so that all three read the same way and
// the strict opt-in has exactly one home.

/** What one request's auth-mail attempt did. Mutated in place by the hooks. */
interface AuthMailOutcome {
  /** True once an auth email on this request failed to reach a queue. */
  enqueueFailed: boolean;
}

const outcomeStore = new AsyncLocalStorage<AuthMailOutcome>();

/**
 * The transport is down and an authentication email could not be QUEUED — so
 * nothing will ever be delivered, and the caller must not claim a send.
 *
 * Distinct from a delivery failure, which happens later inside the durable
 * `email.send` job and is that job's problem to retry. This one is observable at
 * the moment of the request, which is the only moment there is a person to tell.
 */
export class AuthEmailUnavailableError extends Error {
  readonly code = 'AUTH_EMAIL_UNAVAILABLE' as const;
  constructor(override readonly cause: unknown) {
    super('The authentication email could not be queued for delivery.');
    this.name = 'AuthEmailUnavailableError';
  }
}

/**
 * Enqueue an AUTHENTICATION email, strictly.
 *
 * Records the failure on the in-flight request (so a better-auth endpoint that
 * swallows the throw can still be corrected by the route) and then rethrows it
 * as {@link AuthEmailUnavailableError}, for the callers whose throw does reach a
 * surface of ours.
 */
export async function sendAuthEmail(data: JobEventData<'email.send'>): Promise<void> {
  try {
    await sendEvent('email.send', data, { strict: true });
  } catch (err) {
    // ⚠️ LOGGED HERE, because the strict lane in `dispatchToLanes` rethrows
    // INSTEAD of logging — so opting in would otherwise have traded the one
    // operator signal that already existed for the new user-facing one. Both are
    // wanted: the throw tells the person in front of the screen, the line tells
    // whoever is reading logs during the outage.
    console.error(`sendAuthEmail("email.send") could not be queued for ${data.template}:`, err);
    const outcome = outcomeStore.getStore();
    if (outcome) outcome.enqueueFailed = true;
    throw new AuthEmailUnavailableError(err);
  }
}

/**
 * Run `fn` with an auth-mail outcome bound to it, and report whether any
 * authentication email failed to enqueue while it ran.
 *
 * Used by the better-auth catch-all route, which is the only place standing
 * between a swallowed hook failure and a response that claims a send.
 */
export async function withAuthMailOutcome<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; enqueueFailed: boolean }> {
  const outcome: AuthMailOutcome = { enqueueFailed: false };
  const result = await outcomeStore.run(outcome, fn);
  return { result, enqueueFailed: outcome.enqueueFailed };
}
