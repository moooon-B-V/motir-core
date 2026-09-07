// The ESTABLISHED-project planning-workspace HOST's gate (Subtask MOTIR-1729).
//
// ⚠️ The route this was written for is GONE (MOTIR-4732) and this function is
// NOT — `PlanningWorkspaceOverlay` calls it, unchanged, because the gate is a
// pure decision about an actor and a project rather than about a URL. Read
// "`/planning`" below as "the planning workspace", wherever it is mounted.
//
// The workspace is where "Plan with AI" lands. It is an ADDITIONAL surface, NOT
// a relaxation of the onboarding gates: a project
// that never finished onboarding is forwarded to `/onboarding`, which keeps
// owning the first-run fork and the MOTIR-1259 existing-item router (and, past
// MOTIR-1725, the migrate wizard's hand-off). So the two surfaces split cleanly
// on the SAME immutable marker the `/onboarding` redirect reads
// (`project.onboardingRanAt`, Subtask 7.4 / MOTIR-1264):
//
//   marker null → onboarding owns you   ·   marker set → the workspace host does
//
// The decision is a pure function so it is unit-testable without a route, and so
// the page stays a thin Server Component over it (the `toIssueRows` pattern).

/** What the host route should do for the current actor + project. */
export type PlanningHostGate =
  /** No active project to plan into — render the pick-a-project hint. */
  | 'no-project'
  /** The active project is no longer browsable by this actor (6.4.6). */
  | 'no-access'
  /** Never onboarded — `/onboarding` still owns this project's journey. */
  | 'onboarding'
  /** An established project — open the workspace. */
  | 'workspace';

export interface PlanningHostGateInput {
  /** Whether `getActiveProject()` resolved a project. */
  hasActiveProject: boolean;
  /** `projectAccessService.getCapabilities(...).canBrowse`. */
  canBrowse: boolean;
  /** The project's immutable onboarding-ran marker (null = never onboarded). */
  onboardingRanAt: Date | string | null | undefined;
}

/**
 * Resolve the host's gate. Access is checked BEFORE the onboarding marker: an
 * actor who can't browse the project must not be told anything about its
 * planning state, not even by being forwarded into onboarding.
 */
export function resolvePlanningHostGate(input: PlanningHostGateInput): PlanningHostGate {
  if (!input.hasActiveProject) return 'no-project';
  if (!input.canBrowse) return 'no-access';
  if (!input.onboardingRanAt) return 'onboarding';
  return 'workspace';
}
