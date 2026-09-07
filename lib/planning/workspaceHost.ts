// The planning-workspace HOST's gate (Subtask MOTIR-1729; narrowed by MOTIR-4765).
//
// ⚠️ The route this was written for is GONE (MOTIR-4732) and this function is
// NOT — `PlanningWorkspaceOverlay` calls it, unchanged in shape, because the
// gate is a pure decision about an ACTOR and a PROJECT rather than about a URL.
//
// ── WHAT THIS FUNCTION STOPPED ANSWERING, AND WHY (MOTIR-4765) ─────────────
// It used to carry a third verdict:
//
//     if (!input.onboardingRanAt) return 'onboarding';
//
// and the header above it read *"marker null → onboarding owns you · marker set
// → the workspace host does"*. That sentence describes a marker the product does
// not have. `onboardingRanAt` is stamped in exactly ONE place —
// `plansService.approvePlan` → `projectRepository.markOnboardingRan` — set-once
// on the first plan APPROVED. So `null` does not mean *"has never planned with
// AI"*; it means **"has never had a plan approved"**, and every project in that
// state was refused the plan window whatever it actually held: a connected,
// indexed repository, an imported backlog of two hundred items, both.
//
// On MOTIR-4725's overlay the same verdict got worse rather than better. It
// stopped being a redirect a user meets on the way in and became a NAVIGATION
// OUT of the window they had just opened — `router.push(ONBOARDING_ENTRY_PATH)`
// firing from an effect, seconds after *Plan with AI*.
//
// **Onboarding is a DESTINATION the session ROUTES to, not a wall in front of
// the window** (story MOTIR-4753). Whether a project can be planned from what it
// has is a judgement no predicate can make — the situations are uncountable, and
// a repository can be a scaffold, or hold a login page and nothing else — so it
// belongs to the planner (MOTIR-4767), which decides `continue` /
// `onboard_new_project` / `onboard_existing_project` and hands the answer to the
// surface that acts on it (MOTIR-4769). None of that can happen behind a gate
// that ejects the user before a session starts.
//
// ⚠️ SO THE MARKER IS NOT AN INPUT HERE ANY MORE. It was removed from
// `PlanningHostGateInput` rather than left unread, because a parameter nothing
// consumes is exactly the dead branch this card exists to delete: the next
// reader would take its presence as evidence that the gate still weighs it. The
// field itself is untouched and still meaningful — it is how a session knows it
// is a project's FIRST plan, and `projectStateService` still reports it. What
// retires is its use as a ROUTING verdict.
//
// The decision is a pure function so it is unit-testable without a route, and so
// every caller stays a thin adapter over it (the `toIssueRows` pattern).

/** What the host should do for the current actor + project. */
export type PlanningHostGate =
  /** No active project to plan into — render the pick-a-project hint. */
  | 'no-project'
  /** The active project is no longer browsable by this actor (6.4.6). */
  | 'no-access'
  /** Open the workspace. The ONLY affirmative verdict (MOTIR-4765). */
  | 'workspace';

export interface PlanningHostGateInput {
  /** Whether `getActiveProject()` resolved a project. */
  hasActiveProject: boolean;
  /** `projectAccessService.getCapabilities(...).canBrowse`. */
  canBrowse: boolean;
}

/**
 * Resolve the host's gate.
 *
 * Access is still checked BEFORE anything else: an actor who cannot browse the
 * project must not be told anything about its planning state. That ordering is
 * the half of this function MOTIR-4765 does not touch.
 */
export function resolvePlanningHostGate(input: PlanningHostGateInput): PlanningHostGate {
  if (!input.hasActiveProject) return 'no-project';
  if (!input.canBrowse) return 'no-access';
  return 'workspace';
}
