import {
  PLANNING_RETURN_PARAM,
  planningHostPathFor,
  withPlanningOverlay,
} from '@/lib/planning/launcher';
import { readHandoffReturn } from '@/lib/planning/onboardingHandoff';

// THE ROUND TRIP CLOSES (Story MOTIR-4753 · MOTIR-4770).
//
// ⚠️ WHY THIS EXISTS AT ALL: the plan overlay and onboarding are in DIFFERENT
// ROUTE GROUPS. `PlanningWorkspaceOverlay` is mounted in
// `app/(authed)/layout.tsx` and nowhere else; `app/(onboarding)/layout.tsx` is a
// SIBLING group that returns `children` bare and mounts none. So the hand-off did
// not swap a modal — it unmounted the overlay and left `(authed)` entirely, and
// there is no page underneath to come back to.
//
// ⚠️ AND THE ONE THING THAT COULD HAVE BROUGHT THEM BACK WAS DELETED, with its
// reasoning written down (MOTIR-4732):
//
//     `planningLaunchBackHref(launch)` — where Close RETURNED to … The workspace
//     is an OVERLAY now: it opens ON the page you are already on and closes by
//     removing four query parameters from that page's own address. So there is
//     no destination to build and no return route to resolve.
//
// That reasoning is CORRECT FOR CLOSE and does not cover this. Close never leaves
// the page; this left the route group. A mechanism deleted with a correct
// justification is much harder to notice missing than one that was never there.
//
// ── WHAT ONBOARDING DID BEFORE ──────────────────────────────────────────────
// Ended by going somewhere else entirely: every completion path redirected to
// `/roadmap`. So a user who pressed *Plan with AI*, was told what was read, was
// moved to onboarding and finished it landed on the roadmap — not in the window
// they opened. The journey had no end.

/** The two ways a user leaves onboarding, and they are not the same. */
export type OnboardingExit =
  /** They finished. Take them back to the window they opened. */
  | 'completed'
  /**
   * They walked away. Take them back to the PAGE, with no workspace re-opening
   * around them.
   *
   * ⚠️ THIS IS THE OPPOSITE FAILURE TO STRANDING THEM, and it is the easier one
   * to write by accident: the return path already knows where to go, so the
   * temptation is to take it unconditionally.
   */
  | 'abandoned';

/**
 * Where a user leaving onboarding should land — or `null` when they did not come
 * from the plan window at all.
 *
 * `null` is the honest answer for somebody who reached onboarding by any other
 * door (the entrance, a bookmark, a fresh sign-up): they have no window to
 * return to, and every caller keeps whatever destination it had.
 */
export function onboardingReturnHref(params: URLSearchParams, exit: OnboardingExit): string | null {
  const context = readHandoffReturn(params);
  if (!context) return null;
  const host = planningHostPathFor(context);
  if (exit === 'abandoned') return host;
  // ⚠️ THE MARKER SAYS *WE JUST CAME BACK*, and it exists for exactly one
  // decision: the overlay must NOT ask for a routing verdict again (MOTIR-4769)
  // about a project it routed thirty seconds ago that has just done what it was
  // sent to do. It is stripped by Close with the overlay's own parameters, so it
  // cannot linger and quietly change what the next open does.
  //
  // ⚠️ APPENDED AFTER `withPlanningOverlay`, NOT BEFORE. That function strips
  // every parameter the overlay OWNS — the marker included — before writing the
  // four back, which is exactly what makes Close able to clear it. Handing it in
  // as part of the input href would therefore hand it straight to the shredder.
  const opened = withPlanningOverlay(host, context);
  return `${opened}${opened.includes('?') ? '&' : '?'}${PLANNING_RETURN_PARAM}=1`;
}
