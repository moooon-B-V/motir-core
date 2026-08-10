import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
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
// would break rather than protect.

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(req: Request): Promise<Response> {
  const limited = await enforceAuthRateLimit(req);
  if (limited) return limited;
  return handlers.POST(req);
}
