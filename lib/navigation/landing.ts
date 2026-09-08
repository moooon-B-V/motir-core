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
 * asked for. `/workbench` is project-scoped, and every signed-in reader is now
 * inside a project (MOTIR-4870), so it is a safe destination for all of them.
 *
 * ⚠️ RENAMED from `/home` by MOTIR-4782, and the old address still LANDS: a
 * permanent 308 in `next.config.ts` carries it here with its query string, so a
 * bookmark and a pasted `?tab=` link both survive. The move is this one line
 * because MOTIR-3373 collapsed nine literals into this constant first.
 *
 * ⚠️ THE CREATE-FIRST DOOR IS GONE — MOTIR-4815, and this docstring used to
 * carry its notice in the future tense. It said the Workbench "renders the
 * shipped create-first door when there is no project (MOTIR-2761)", which was
 * the second clause of the sentence above and is retired with the state it
 * described: a default project is seeded at the WORKSPACE tier, so
 * `getActiveProject()` returns null on no reachable path for a member and there
 * is no project-less reader for the door to serve.
 *
 * ⚠️ AND THE LANDING NOW HAS A REGISTRATION ARM, which the retired notice did
 * not anticipate: it read as though this constant would simply keep serving
 * everyone. `resolvePostAuthDestination` sends a reader who has just CREATED an
 * account to `ONBOARDING_ENTRY_PATH` instead — see its docstring — while every
 * sign-in still lands here.
 */
export const AUTHED_LANDING_PATH = '/workbench';

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
 *   3. `/onboarding`, when the account is being CREATED right now (MOTIR-4871);
 *   4. the signed-in landing.
 *
 * ⚠️ ARM 3 IS THE REGISTRATION ARM, AND IT IS AN ARGUMENT RATHER THAN A SECOND
 * EXPORTED CONSTANT (MOTIR-4871). A brand-new reader is now INSIDE a project
 * from their first request (`projectsService.ensureDefaultProject`), and the
 * useful thing to do with a project nobody has described yet is to describe it
 * — which is what `/onboarding` is for, and what the product already does one
 * step later when "Plan a new project with AI" mints a project and only then
 * opens the entrance. Landing them on the Workbench instead would show a
 * truthful empty surface and answer no question they have.
 *
 * It is a FLAG on this one function and not a `REGISTRATION_LANDING_PATH`
 * beside the others, because a second constant is a second thing a caller can
 * pick wrongly — and picking wrongly is exactly the six-defect history in this
 * module's own docstring. The precedence stays in one place; the caller says
 * only which SITUATION it is in, which is the one fact it holds and this module
 * does not. Sign-IN passes nothing and is unchanged.
 *
 * @param next the raw `?next=` search param — a string, an array (a hand-edited
 *   URL can repeat the key), `null` from `useSearchParams().get`, or absent.
 * @param draftId the `?draft=` id, when the marketing hero handed one over.
 * @param isRegistration whether this resolution is for an account being CREATED
 *   right now, rather than for a sign-in. See the paragraph below.
 */
export function resolvePostAuthDestination({
  next,
  draftId,
  isRegistration,
}: {
  next?: string | string[] | null;
  draftId?: string | null;
  isRegistration?: boolean;
}): string {
  const explicit = sanitizeNextPath(next ?? undefined);
  if (explicit) return explicit;
  return draftId || isRegistration ? ONBOARDING_ENTRY_PATH : AUTHED_LANDING_PATH;
}

/**
 * IS THIS DESTINATION THE ONBOARDING ENTRANCE? (MOTIR-4402)
 *
 * A credential surface that is CARRYING an onboarding intent has to be able to
 * say so, and the only thing it holds is the resolved destination — a string
 * that may be the entrance itself or the entrance with a query or a sub-path on
 * it. Comparing `=== ONBOARDING_ENTRY_PATH` answers the first and misses the
 * other two; comparing `startsWith('/onboarding')` also matches
 * `/onboardingsomething`, which is a different route.
 *
 * It lives HERE rather than in the card that asks, for the reason the module's
 * own docstring gives: a surface that re-types the entrance is the seventh file
 * free to be independently right, stale, or absent.
 */
export function isOnboardingDestination(destination: string): boolean {
  return (
    destination === ONBOARDING_ENTRY_PATH ||
    destination.startsWith(`${ONBOARDING_ENTRY_PATH}?`) ||
    destination.startsWith(`${ONBOARDING_ENTRY_PATH}/`)
  );
}

/**
 * THE ONBOARDING DOOR FOR A READER WITH NO ACCOUNT (MOTIR-4402).
 *
 * `/sign-in`'s "Have a project idea? · Plan with AI" control used to point
 * straight at `ONBOARDING_ENTRY_PATH`. Onboarding is authenticated, so the
 * layout bounced the visitor back to `/sign-in?next=/onboarding` — and the
 * sign-in card rendered that return IDENTICALLY. The only reader who could see
 * the control was the one it round-tripped (`app/(auth)/sign-in/page.tsx` sends
 * a signed-in reader away unless `?draft=` is present), so there was no reader
 * for whom the door visibly worked.
 *
 * The copy says *"Have a project idea?"* — it addresses somebody who does not
 * have an account — so the door goes where that reader has to go first, carrying
 * the intent in the ONE carrier both auth surfaces already honour. Completing
 * sign-up then lands on the entrance through `resolvePostAuthDestination`, which
 * is the same precedence every other deep link bounced through auth relies on.
 *
 * Composed from `ONBOARDING_ENTRY_PATH` rather than written out, so this file
 * stays the one place that spells the entrance.
 */
export const ONBOARDING_SIGNUP_DOOR_PATH = `/sign-up?next=${encodeURIComponent(
  ONBOARDING_ENTRY_PATH,
)}`;
