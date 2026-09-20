import { isFolderRef, isTempRef } from '@/lib/plans/refs';

/**
 * WHAT A PLAN IS ABOUT — the committed work items an append PARKS at `planning`
 * (MOTIR-5645; `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D1).
 *
 * PURE, and its own module, for the same reason `rescopeReset.ts` is: the
 * definition is a DECISION, it has to be identical wherever it is read, and a
 * pure function is the only shape a unit test can pin without a database.
 *
 * ⚠️ TWO KINDS OF TARGET, and the second is the one worth stating:
 *
 *   1. the `workItemId` of every `modify` and every `remove` — the plan is
 *      rewriting that card, which is the obvious case;
 *   2. the COMMITTED `parentRef` of every `add` — because a plan laying children
 *      under a card is a plan ABOUT that card. Somebody re-reading the parent
 *      while its child set is being rewritten is reading a shape that is about
 *      to change.
 *
 * ⚠️ AND WHAT IS NOT A TARGET, each for a reason rather than by omission:
 *
 *   - a `planItem:` parentRef — it names another `add` in this same plan, which
 *     has no row and therefore no status to park;
 *   - a `folder:` parentRef — a folder is a PLACEMENT, and carries no status,
 *     blocks nothing and rolls nothing up;
 *   - a `modify`'s `patch.parentRef` — a re-parent changes where the card SITS.
 *     The card being moved is already a target through its own `workItemId`; the
 *     card it moves UNDER is not being rewritten, so parking it would hold a
 *     stranger's card for a day;
 *   - `blockedByRefs` — an edge names a prerequisite, not a card this plan is
 *     about.
 *
 * A `done` or `cancelled` target never reaches a park at all: `validateProposals`
 * refuses a terminal target with `PlanTargetImmutableError` before this is read
 * (AMENDMENT 16 D2).
 */
export function committedPlanTargets(
  proposals: ReadonlyArray<{
    op: string;
    workItemId?: string | null;
    parentRef?: string | null;
  }>,
): string[] {
  const ids = new Set<string>();
  for (const p of proposals) {
    if (p.op !== 'add') {
      if (p.workItemId) ids.add(p.workItemId);
      continue;
    }
    const parent = p.parentRef;
    if (parent && !isTempRef(parent) && !isFolderRef(parent)) ids.add(parent);
  }
  // Sorted, so the caller's lock order is deterministic from this alone — the
  // fixed work-item-id-ascending order every path in `planTargetLockService`
  // takes. Two appends touching the same pair of cards then queue rather than
  // deadlocking.
  return [...ids].sort();
}
