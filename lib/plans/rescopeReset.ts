// WHEN an approved `modify` walks its target back to To Do (Bug MOTIR-5359).
//
// A re-plan that RE-SCOPES a card someone has already started — rewrites what it
// is, or where it ships — makes that card's in-progress status a claim about work
// that no longer matches its body: `implemented` asserts code for the OLD
// description is on the remote. Left alone, readiness, the board, the parent
// rollup and `motir run`'s selection all read the stale claim and the re-scoped
// work is never picked up again. So the approve resets it — the requester's
// decision, 2026-09-13.
//
// ⚠️ A RE-SCOPE IS NARROW, BY DECISION. `title`, `descriptionMd` and the target
// repository change WHAT the work is or WHERE it lands. `type`, `estimateMinutes`
// and `storyPoints` are EXCLUDED (re-classification and re-sizing, not a change
// to the work), and so are edges, priority, the explanation and the parent: none
// of them makes a started card's progress untrue.
//
// Pure, so both consumers — `plansService.applyModify` (which writes the reset)
// and `planReviewService.buildChanges` (which shows it to the approver first) —
// ask one question and cannot disagree.

import type { PlanItemPatch } from '@/lib/dto/plans';

/** The patch keys whose change re-scopes the target's work. */
export const RESCOPE_PATCH_KEYS = [
  'title',
  'descriptionMd',
  'targetRepo',
  'targetRepos',
  'targetRepositories',
  'targetRepositoryRef',
  'targetRepoRole',
] as const satisfies readonly (keyof PlanItemPatch)[];

/** The target fields the comparison reads. */
export interface RescopeTarget {
  title: string;
  descriptionMd: string | null;
}

/**
 * Does this patch re-scope the target? Title and description count only when
 * they actually DIFFER from the target's; a repository key counts whenever it is
 * present, because a re-pin is a statement about where the work lands.
 */
export function patchRescopes(
  patch: Pick<PlanItemPatch, (typeof RESCOPE_PATCH_KEYS)[number]>,
  target: RescopeTarget,
): boolean {
  if (patch.title !== undefined && patch.title !== target.title) return true;
  if (patch.descriptionMd !== undefined && patch.descriptionMd !== target.descriptionMd) {
    return true;
  }
  return (
    patch.targetRepo !== undefined ||
    patch.targetRepos !== undefined ||
    patch.targetRepositories !== undefined ||
    patch.targetRepositoryRef !== undefined ||
    patch.targetRepoRole !== undefined
  );
}

/** A reset status is owed when the target is in the IN-PROGRESS category. */
export function resetOwed(statusCategory: string | null | undefined): boolean {
  return statusCategory === 'in_progress';
}
