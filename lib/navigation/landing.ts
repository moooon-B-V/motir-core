import { sanitizeNextPath } from './nextDestination';

/**
 * WHERE A SIGNED-IN READER BELONGS — the one place that answers it (MOTIR-3373).
 *
 * `docs/decisions/home-scope.md` §2.3 decides it: **post-auth lands on `/home`,
 * unconditionally.** That sentence has been the product's position since
 * MOTIR-2654, and until this module it was stored as nine string literals in
 * nine files, each free to be independently right, stale, or absent. Six
 * defects under Epic 8 came out of that arrangement, in exactly two shapes:
 *
 *   - **ROTTED** — MOTIR-2921, MOTIR-3171, MOTIR-3173: a destination that was
 *     correct when written and still said `/dashboard` afterwards, each one
 *     under a comment asserting the pre-2654 world as fact.
 *   - **SILENT** — MOTIR-3367, MOTIR-3372: a route that never asked the question
 *     at all, which no sweep for the OLD literal could ever have found.
 *
 * So the rule this module exists to make true is: **the answer is imported, not
 * retyped.** `tests/navigation/landing-owner-guard.test.ts` is what keeps it
 * true — it fails on a `/home` literal anywhere under `app/`, `components/` or
 * `lib/` outside this file, and on a `/dashboard` literal sitting under a
 * comment that calls itself the home or the landing (the tell MOTIR-3173
 * identified after the third repair).
 *
 * It is a PLAIN module on purpose — no `server-only` import — because half its
 * consumers are `'use client'` components. That is not a new idea in this
 * directory: `afterContextSwitch.ts` beside it owns the post-context-switch
 * landing the same way and is imported by four client components and two server
 * pages. It is also the specific mistake this module avoids: the sign-in card
 * used to explain its hardcoded literal by noting that *"the canonical constant
 * lives in a `server-only` module"*, which is a good reason not to import THAT
 * one and no reason at all to retype the value.
 */

/**
 * The signed-in landing — where a reader goes when nothing more specific is
 * asked for. `/home` is project-scoped and renders the shipped create-first door
 * when there is no project (MOTIR-2761), so it is a safe destination for every
 * signed-in actor, including one who has just made an account.
 */
export const AUTHED_LANDING_PATH = '/home';

/**
 * Where the cross-origin idea hand-off goes (MOTIR-1458): the authed discovery
 * chat, which reads the `motir_pending_idea` cookie planted by the draft claim
 * to seed its first turn.
 */
export const ONBOARDING_ENTRY_PATH = '/onboarding';

/**
 * The destination after authenticating — or, for a reader who is already signed
 * in, instead of authenticating at all. One precedence, applied by the sign-in
 * and sign-up cards (as Better-Auth's `callbackURL`) and by the server shells
 * above them (as the redirect a signed-in arrival gets):
 *
 *   1. an explicit `?next=`, when it is a safe same-origin path — the CLI
 *      hand-off (`/device?user_code=…`) and every deep link that bounced through
 *      auth depend on it, and `sanitizeNextPath` is what stops it being an open
 *      redirect;
 *   2. `/onboarding`, when an idea draft is being carried across;
 *   3. `/home`.
 *
 * @param next the raw `?next=` search param — a string, an array (a hand-edited
 *   URL can repeat the key), `null` from `useSearchParams().get`, or absent.
 * @param draftId the `?draft=` id, when the marketing hero handed one over.
 */
export function resolvePostAuthDestination({
  next,
  draftId,
}: {
  next?: string | string[] | null;
  draftId?: string | null;
}): string {
  const explicit = sanitizeNextPath(next ?? undefined);
  if (explicit) return explicit;
  return draftId ? ONBOARDING_ENTRY_PATH : AUTHED_LANDING_PATH;
}
