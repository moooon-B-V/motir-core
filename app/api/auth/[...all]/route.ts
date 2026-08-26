import { NextResponse } from 'next/server';
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
import { withAuthMailOutcome } from '@/lib/auth/authMail';
import { enforceAuthRateLimit } from '@/lib/rateLimit/authGuard';

// Better-Auth's catch-all handler. Every /api/auth/* request (sign-in,
// sign-up, sign-out, OAuth callbacks, the CLI device grant) lands here.
//
// App-level rate limiting (Subtask 8.5.9 / MOTIR-1165) wraps the POST handler:
// anyone on the internet can hit sign-in and password-reset as fast as their
// script can send, and nothing shared between instances stopped them. The guard
// decides which sub-paths are credential-bearing and keys per IP + per
// identifier; see `lib/rateLimit/authGuard.ts` for why only those, and why it
// layers on top of Better-Auth's own limiter rather than replacing it.
//
// GET is NOT wrapped: it carries session reads, OAuth callbacks and the device
// poll — none of them credential-guessing surfaces, all of them things a limiter
// would break rather than protect. Nor does any GET send an authentication
// email, which is why the mail correction below is on POST alone.

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(req: Request): Promise<Response> {
  const limited = await enforceAuthRateLimit(req);
  if (limited) return limited;

  // ⚠️ A SUCCESS BETTER-AUTH REPORTED IS NOT ALWAYS ONE (Bug MOTIR-3583).
  //
  // Two of this app's authentication emails are sent from better-auth HOOKS —
  // `emailAndPassword.sendResetPassword` and the two-factor plugin's `sendOTP`
  // — and better-auth@1.6.11 catches what those hooks throw and answers
  // `{ status: true }` anyway (`runInBackgroundOrAwait` is a bare try/catch; the
  // two-factor plugin attaches its own `.catch` on top). So a queue outage used
  // to reach the reader as "check your email" for a message that was never
  // enqueued, and a retry failed the identical silent way.
  //
  // The hooks record the failure on the in-flight request instead
  // (`lib/auth/authMail.ts`), and this is where it is turned back into an
  // answer. Only a SUCCESSFUL response is corrected: a 4xx better-auth already
  // decided — a rate limit, a bad body, an expired challenge — is the more
  // specific truth and stands.
  const { result, enqueueFailed } = await withAuthMailOutcome(() => handlers.POST(req));
  if (!enqueueFailed || !result.ok) return result;
  return NextResponse.json(
    {
      code: 'AUTH_EMAIL_UNAVAILABLE',
      error: 'The email could not be queued for delivery. Please try again.',
    },
    { status: 503 },
  );
}
