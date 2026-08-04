import type { StatusCategoryDto } from '@/lib/dto/workflows';

// Should a work-item surface render the per-item Plan / Re-plan entrance
// (`WorkItemPlanEntrance`, MOTIR-910)? The ONE predicate every host shares — the
// detail page header and the quick-view peek today, whatever comes next
// tomorrow. It is the planning-door twin of `showsReadiness`
// (`lib/issues/readinessVisibility.ts`), and it exists for the same reason: the
// boolean was inlined at each call site, so each new state had to be remembered
// twice and was remembered zero times (MOTIR-2050 added the `archived` gate,
// MOTIR-2084 the terminal one — the same two lines, two days running).
//
// Three gates, all answering "is this an item the planning engine will actually
// let me plan?":
//
//   1. The actor may plan it. Planning PROPOSES plan changes, so the door rides
//      the project's `canEdit` capability — a browse-only viewer gets no door
//      rather than one that fails on the first turn.
//   2. The item is NOT archived (MOTIR-2050). Archiving is a pure soft-delete
//      that deliberately leaves `status` alone, so a status-only gate still
//      fires on archived work. It is not work to plan.
//   3. The item is NOT in a TERMINAL status (MOTIR-2084) — and this is the gate
//      the shipped system already enforces everywhere BUT here:
//        · `validatePlanProposals` step 4 throws `PlanTargetImmutableError`
//          (409) for any `modify`/`remove` whose target sits in a
//          `category = 'done'` status — DONE-WORK IMMUTABILITY. Re-planning an
//          item IS proposing modify/remove against it, so the Re-plan face's
//          whole purpose is rejected at approve.
//        · `diffStateForItem` returns `'locked'` for a terminal item before it
//          looks at any proposal — "the engine proposes around finished work,
//          never over it". The door was handing the user into a workspace that
//          renders the very item they anchored on as locked.
//
// Gate 3 reads the CATEGORY, never the `'done'` status KEY: projects define
// their own statuses, the default workflow already carries a SECOND
// done-category status (`cancelled`), and more can exist. That is the same
// vocabulary the server uses — `workflowsService.getTerminalStatusKeys` resolves
// `category = 'done'`, not a hardcoded key.
//
// A `null` category (the workflow could not classify the status) is NOT treated
// as terminal: the fail-safe direction here is to keep the door on work we
// cannot prove is finished, not to hide it on work that is plainly live.
export function showsPlanEntrance(args: {
  /** May this actor open the planning workspace on the item (`canEdit`)? */
  canPlan: boolean;
  /** Is the item archived (`archivedAt != null`)? */
  archived: boolean;
  /** The item's status category (`null` when the workflow can't classify it). */
  statusCategory: StatusCategoryDto | null | undefined;
}): boolean {
  return args.canPlan && !args.archived && args.statusCategory !== 'done';
}
