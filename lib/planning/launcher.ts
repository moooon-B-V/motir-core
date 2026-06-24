// The "Plan with AI" universal launcher — the reusable entrance that summons the
// AI planning workspace (the canvas + chat surface; design @
// `design/ai-chat/planning-workspace.mock.html`, MOTIR-1193) from anywhere in
// the PM core, so the planner is callable any time — not only during onboarding
// (MOTIR-1299 / Story 7.20).
//
// This module is the launcher's PURE core: it maps the surface the user invoked
// the launcher FROM (the originating context) to the planning MODE the workspace
// should open in, and builds the href that carries that context to the
// workspace. It is deliberately framework-free (no React, no `server-only`) so
// it runs identically in the client launcher, the ⌘K command, and unit tests.
//
// The four modes are STATES of the one workspace surface (design §"The planning
// MODES"); each is owned + seeded by its own subtask — generation (7.4),
// re-plan/augment (7.11), contextual (7.12), roadmap-read (7.19). The launcher's
// job is only to OPEN the workspace in the right mode with the originating
// context; what each mode renders is those subtasks' responsibility.

/**
 * The planning mode the workspace opens in. `'project'` is the COARSE
 * project-scoped entrance used when the launch site does not (cheaply) know
 * whether a plan already exists — the workspace itself seeds generation-vs-
 * augment from the live tree. `'generation'` / `'replan'` are the resolved
 * fine split for callers that DO know (`hasPlan`).
 */
export type PlanningMode = 'project' | 'generation' | 'replan' | 'contextual' | 'roadmap';

/**
 * Where the launcher was invoked from — the originating context the workspace
 * needs to open in the right mode.
 *
 * - `project` — a project-level surface with no specific item. `hasPlan`
 *   resolves the generation-vs-re-plan split; OMIT it (the global header pill's
 *   case) to get the coarse `'project'` mode without a per-render plan lookup.
 * - `work-item` — a specific work item (its detail page / a row action) →
 *   contextual planning scoped to that item (the MOTIR-910 door reuses this).
 * - `roadmap` — the Board↔Roadmap surface (the MOTIR-1011 door reuses this).
 */
export type PlanningLaunchContext =
  | { kind: 'project'; hasPlan?: boolean }
  | { kind: 'work-item'; itemKey: string }
  | { kind: 'roadmap' };

/**
 * The shipped planning-workspace entry path. Today the workspace renders as the
 * full-screen onboarding route (mirrors `ONBOARDING_ENTRY_PATH` in
 * `lib/onboarding/pendingIdea.ts`, which is `server-only` so it can't be
 * imported here). The design's on-top-of-the-app OVERLAY host for an existing
 * project is a follow-up owned by the reusable-shell decision (bug MOTIR-1300);
 * when it lands, only this constant + `planningWorkspaceHref` change — the
 * launcher affordance and the resolver stay put.
 */
export const PLANNING_WORKSPACE_PATH = '/onboarding';

/** Resolve the originating context to the planning mode the workspace opens in. */
export function resolvePlanningMode(context: PlanningLaunchContext): PlanningMode {
  switch (context.kind) {
    case 'work-item':
      return 'contextual';
    case 'roadmap':
      return 'roadmap';
    case 'project':
      if (context.hasPlan === undefined) return 'project';
      return context.hasPlan ? 'replan' : 'generation';
  }
}

/**
 * Build the href that opens the planning workspace in the resolved mode,
 * carrying the originating context as query params so the workspace can seed
 * itself. Unknown params are harmless to the current route; they are the
 * forward-compatible seam the mode subtasks (7.4 / 7.11 / 7.12 / 7.19) read.
 */
export function planningWorkspaceHref(context: PlanningLaunchContext): string {
  const params = new URLSearchParams({
    mode: resolvePlanningMode(context),
    from: context.kind,
  });
  if (context.kind === 'work-item') params.set('item', context.itemKey);
  return `${PLANNING_WORKSPACE_PATH}?${params.toString()}`;
}
