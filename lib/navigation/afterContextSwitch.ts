import { AUTHED_LANDING_PATH } from './landing';

/**
 * Where a context switch (active ORG, WORKSPACE or PROJECT) lands the user.
 *
 * Bug MOTIR-1312: the org / workspace switchers used to update in place with a
 * bare `router.refresh()`. That re-runs Server Components only — so it leaves
 * the page body stale in two ways after a switch (which also re-points the
 * active workspace + project via the 8.8.28 cascade):
 *   1. A CLIENT island seeded from server props via `useState(initialProps)`
 *      (e.g. the dashboard grid) never re-seeds on a refresh — the page-state
 *      contract in CLAUDE.md — so it keeps rendering the OLD org's data.
 *   2. A URL scoped to an old-org entity (`/items/[key]`, `/sprints/[id]/report`,
 *      a specific dashboard id, project-settings sub-pages) no longer belongs to
 *      the new active context, so a same-URL refresh shows mismatched / 404 /
 *      stale content instead of a valid surface.
 *
 * The fix is to NAVIGATE, which abandons the stale deep URL AND remounts client
 * islands so they re-seed from new-context props. When the user is already on
 * that surface, a `router.push` to the same route is a no-op, so the caller
 * falls back to `router.refresh()`.
 *
 * ⚠️ WHERE IT NAVIGATES TO IS NOT THIS FILE'S DECISION (MOTIR-5132). It used to
 * be: this module declared `= '/items'` of its own, chosen in June 2026 as "a
 * neutral default surface" and mirroring `AcceptInviteButton`'s
 * `router.push('/dashboard')`. Both of those sentences were written BEFORE the
 * signed-in landing existed, and neither was re-asked when it arrived — so the
 * product ended up answering *where does a reader land* three ways at once:
 * `/workbench` on sign-in, `/items` on a switch, `/dashboard` on an invite.
 *
 * Arriving and re-arriving are the SAME act — both end with *show me what I am
 * doing in this project* — so the destination is now COMPOSED from the one
 * owner, `lib/navigation/landing.ts`. That is also what keeps it defended:
 * `tests/navigation/landing-owner-guard.test.ts` already forbids a second
 * `/workbench` literal, and with only one spelling left the switch destination
 * is covered by that scan for free.
 */
export const CONTEXT_SWITCH_LANDING = AUTHED_LANDING_PATH;

/**
 * Decide how to update the page after switching the active org / workspace /
 * project, or after accepting an invite into a workspace.
 *
 * @param currentPath the current `usePathname()` value (no query string)
 * @returns the route to `router.push()` to, or `null` to `router.refresh()` in
 *   place because the user is already on the landing surface.
 */
export function afterContextSwitchTarget(currentPath: string | null): string | null {
  return currentPath === CONTEXT_SWITCH_LANDING ? null : CONTEXT_SWITCH_LANDING;
}
