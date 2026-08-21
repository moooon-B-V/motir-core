import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The motir-core root (Subtask 7.22.1 / MOTIR-1457 — the 8.3 entry rework;
// two-branch contract added by MOTIR-3367).
//
// THE ROOT ANSWERS TWO VISITOR STATES, and which one you are is the whole
// contract:
//
//   - a request carrying a valid SESSION  → `/home`
//   - a request with none                 → `/sign-in`
//
// `/home` is the signed-in landing, decided in `docs/decisions/home-scope.md`
// §2.3 (*"post-auth still lands on `/home`, unconditionally"*) and safe for a
// brand-new actor too: it has been project-scoped with the shipped create-first
// door since MOTIR-2761, so a reader with no project meets `ProjectsEmptyState`
// rather than an empty My-work list.
//
// ⚠️ This line USED to be a bare `redirect('/sign-in')` with no session read at
// all, under a comment saying the root *"now lands the visitor on the login
// surface"* — true of the visitor 7.22.1 was written for, and false for the one
// who is already signed in, who got the login form for the account they were
// already in (MOTIR-3367). Both guards shipped with that card encode the
// signed-out visitor and passed the whole time, which is why nothing caught it:
// `tests/onboarding/entry-rework.test.tsx` asserted the redirect was
// "unconditional", and `tests/e2e/onboarding-entry.spec.ts` clears cookies
// before navigating. Both now assert BOTH branches. A route's contract is a
// function of session state; the root is the route asked most often.
//
// The session read costs no round trip: `getSession` is `cache()`-memoised per
// render pass (`lib/auth/index.ts`, MOTIR-2453) and `app/layout.tsx` already
// calls it on this same render, so the second caller reads the same promise.
//
// The marketing landing + hero prompt relocated OUT of motir-core to the
// standalone motir-marketing site (Story 8.3 / MOTIR-1152), so the root of the
// PM app is no longer a marketing page. The "Plan with AI" affordance on the
// sign-in surface is the door into onboarding (`/onboarding`), and an idea typed
// on motir.co is preserved into onboarding via the cross-origin pre-auth draft
// receiver (MOTIR-1458, reusing the 1022 seam).
//
// The self-host "Connect Motir AI" gate that used to render here (behind
// `isAiPlanningConfigured()`) moved to the onboarding entrance
// (`app/(onboarding)/layout.tsx`): a self-hosted deployment with no Motir Cloud
// connection sees the deferred Connect gate when it reaches `/onboarding`, not at
// the root. Nothing here imports `motir-ai` (the open-core invariant).
export default async function RootPage() {
  const session = await getSession();
  redirect(session ? AUTHED_LANDING_PATH : '/sign-in');
}
