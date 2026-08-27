import { APIError } from 'better-auth/api';
import { userRepository } from '@/lib/repositories/userRepository';

/**
 * The SIGN-IN half of an account suspension (MOTIR-1167).
 *
 * `platformSupportService.setSuspended` does two things: it stamps
 * `user.suspended_at`, and it deletes every `session` row the account holds. The
 * second takes effect immediately on sessions that are already open. This is
 * what closes the other direction — the next attempt to open one.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY IT HANGS OFF `session.create` AND NOT OFF A SIGN-IN ENDPOINT
 * ---------------------------------------------------------------------------
 * Motir has more than one way in, and it gains more over time:
 * email + password, Google, the two-factor challenge, and the RFC 8628 device
 * grant behind `motir login`. Every one of them ends in a `session` row being
 * created, and NONE of them shares an endpoint with the others. A check placed
 * on `signInEmail` would let a suspended account in through Google; a check on
 * both would let it in through the CLI. `databaseHooks.session.create.before` is
 * the ONE seam they all funnel through, so a route added tomorrow inherits the
 * refusal instead of needing to remember it.
 *
 * That is the same argument `lib/platform/auth.ts` makes for reading
 * `platformRole` fresh per request rather than caching it into the session: an
 * access decision belongs where it cannot be routed around.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ IT THROWS RATHER THAN RETURNING `false`
 * ---------------------------------------------------------------------------
 * Better-Auth's `createWithHooks` treats a `false` return as "skip the insert"
 * and resolves the whole call to `null` — so the endpoint would answer with a
 * successful shape carrying no session, and the browser would land on a signed-
 * out app with no explanation. `APIError` is the framework's own refusal
 * channel: it becomes the HTTP response, so the sign-in page renders a message.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ AND IT SAYS SO PLAINLY — this is NOT the `/admin` 404 posture
 * ---------------------------------------------------------------------------
 * The platform gate answers an unknown-route 404 because a distinguishable
 * refusal would confirm that `/admin` exists to somebody who should not know.
 * Nothing of the sort applies here: the person on the other end owns this
 * account, has just proved it with a password or an OAuth grant, and needs to
 * know why they cannot get in — otherwise they file a support ticket about a
 * broken login and an operator burns an hour on it. The reason the operator
 * typed is deliberately NOT included: it is written for other operators, and
 * "Reason: suspected fraud" is not a sentence to hand a customer through a login
 * form. The contact route is.
 */
export const SUSPENDED_ACCOUNT_MESSAGE =
  'This account has been suspended. Contact support if you think this is a mistake.';

/**
 * Refuse a session for a suspended account.
 *
 * Reads `user` fresh — the row is the enforced state and the only thing that
 * can be trusted at this moment; a suspension applied thirty seconds ago must
 * bite on the next attempt, not on the next deploy.
 *
 * A MISSING user is not this function's business: Better-Auth is mid-flight
 * creating a session for a principal it has already resolved, and inventing a
 * refusal for a row that is not there would turn an unrelated fault into a
 * misleading "you are suspended". It returns quietly and lets the insert fail on
 * its own foreign key.
 */
export async function assertAccountNotSuspended(userId: string): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user?.suspendedAt) return;

  throw new APIError('FORBIDDEN', {
    code: 'ACCOUNT_SUSPENDED',
    message: SUSPENDED_ACCOUNT_MESSAGE,
  });
}
