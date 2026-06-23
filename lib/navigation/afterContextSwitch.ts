/**
 * Where a context switch (active ORG or WORKSPACE) lands the user.
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
 * The fix is to NAVIGATE to a neutral default surface — the work-items list —
 * which abandons the stale deep URL AND remounts client islands so they re-seed
 * from new-org props. When the user is already on that surface, a `router.push`
 * to the same route is a no-op, so the caller falls back to `router.refresh()`.
 * This mirrors the existing post-switch navigation in AcceptInviteButton
 * (`router.push('/dashboard'); router.refresh()`).
 */
export const CONTEXT_SWITCH_LANDING = '/items';

/**
 * Decide how to update the page after switching the active org / workspace.
 *
 * @param currentPath the current `usePathname()` value (no query string)
 * @returns the route to `router.push()` to, or `null` to `router.refresh()` in
 *   place because the user is already on the landing surface.
 */
export function afterContextSwitchTarget(currentPath: string | null): string | null {
  return currentPath === CONTEXT_SWITCH_LANDING ? null : CONTEXT_SWITCH_LANDING;
}
