import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { isTypeableKind } from '@/lib/issues/executorDefaults';

/** Which face a planning affordance wears, or `null` for "draw nothing at all". */
export type PlanEntranceFace = 'plan' | 'replan' | null;

// THE Plan / Re-plan RULE (Yue, 2026-08-04) — stated once, applied everywhere.
//
// Every surface that offers per-item planning asks THIS function what to draw:
// the detail page header and the quick-view peek (`WorkItemPlanEntrance`,
// MOTIR-910) and the /items row ⋯ menu (`WorkItemActionsMenu`'s Expand /
// Re-plan, MOTIR-903). One rule, one implementation, three call sites that only
// pass state.
//
//   1. A `done` card offers NO Plan and NO Re-plan — parent or child, every
//      kind, no exception.
//   2. A LEAF (task / bug / subtask) shows Re-plan when it HAS a description,
//      and Plan when it does not. A leaf can never have children, so its face
//      cannot come from `hasChildren` — the description is the signal that there
//      is already something to re-plan.
//   3. An epic or story WITHOUT children is always Plan; WITH children it is
//      Re-plan. Rule 3 wins for containers: a described but childless epic is
//      still Plan, because for a container it is the CHILDREN that constitute
//      the plan, not the prose.
//
// Container vs leaf is `isTypeableKind` — the split the schema already draws
// (epic / story are containers; task / bug / subtask are executable leaves).
//
// Two gates precede all three rules, and both predate this function:
//
//   · The actor may plan it. Planning PROPOSES plan changes, so the door rides
//     the project's `canEdit` capability — a browse-only viewer gets no door
//     rather than one that fails on the first turn.
//   · The item is NOT archived (MOTIR-2050). Archiving is a pure soft-delete
//     that deliberately leaves `status` alone, so a status-only gate still fires
//     on archived work. It is not work to plan.
//
// WHY RULE 1 IS NOT MERELY A PREFERENCE: the engine already refuses the work.
// `validatePlanProposals` step 4 throws `PlanTargetImmutableError` (409) for any
// `modify`/`remove` whose target sits in a `category = 'done'` status —
// DONE-WORK IMMUTABILITY — and `diffStateForItem` returns `'locked'` for a
// terminal item before it looks at any proposal ("the engine proposes around
// finished work, never over it"). A door onto a done card leads to a workspace
// that renders the very item you anchored on as locked.
//
// Rule 1 reads the CATEGORY, never the `'done'` status KEY: projects define
// their own statuses, the default workflow already carries a SECOND
// done-category status (`cancelled`), and more can exist. That is the same
// vocabulary the server uses — `workflowsService.getTerminalStatusKeys` resolves
// `category = 'done'`, not a hardcoded key.
//
// A `null` category (the workflow could not classify the status) is NOT treated
// as terminal: the fail-safe direction is to keep the door on work we cannot
// prove is finished, not to hide it on work that is plainly live.
//
// This module is the third and last iteration of a shape that cost three bugs:
// MOTIR-2050 retro-fitted the `archived` gate onto inlined booleans, MOTIR-2084
// the terminal gate onto the same two lines, and MOTIR-2097 found a third
// surface neither had touched. The rule lives HERE now.
export function planEntranceFace(args: {
  /** May this actor open planning on the item (`canEdit`)? */
  canPlan: boolean;
  /** Is the item archived (`archivedAt != null`)? */
  archived: boolean;
  /** The item's status category (`null` when the workflow can't classify it). */
  statusCategory: StatusCategoryDto | null | undefined;
  /** The item's kind — decides whether rule 2 or rule 3 applies. */
  kind: WorkItemKindDto;
  /** Does the item have children? The container face (rule 3). */
  hasChildren: boolean;
  /**
   * Does the item have a non-empty description? The LEAF face (rule 2). An
   * empty string counts as none — that is what an emptied editor writes.
   */
  hasDescription: boolean;
}): PlanEntranceFace {
  if (!args.canPlan) return null;
  if (args.archived) return null;
  if (args.statusCategory === 'done') return null; // rule 1

  return isTypeableKind(args.kind)
    ? args.hasDescription // rule 2 — a leaf's face comes from its description
      ? 'replan'
      : 'plan'
    : args.hasChildren // rule 3 — a container's face comes from its children
      ? 'replan'
      : 'plan';
}

/** Is a planning affordance offered on this item at all? The boolean half of
 *  {@link planEntranceFace}, for hosts that gate visibility separately from the
 *  face they draw. */
export function showsPlanEntrance(args: Parameters<typeof planEntranceFace>[0]): boolean {
  return planEntranceFace(args) !== null;
}
