// ── A proposed OBSOLESCENCE mark's bar, at the proposal write doors ───────────
// (Story MOTIR-6577 · MOTIR-6629 · MOTIR-6663.)
//
// A `modify` patch can carry the target's obsolescence mark and its note, and
// approve writes them straight onto the work item — `applyModify` builds the
// update itself, so the direct door's `assertObsolescence` (and its
// `InvalidObsolescenceError`) never runs on the plan path. This is the plan
// path's own bar, so a value approve could not write is refused while the author
// still has the plan to fix — never silently dropped, never a raw enum error
// mid-approve. Two checks:
//
//   * MEMBERSHIP (`validateProposedObsolescence`, MOTIR-6629) — pure, over the
//     same `WORK_ITEM_OBSOLESCENCES` the direct door reads, run by the append
//     (`validateProposal`) and the correction (`correctProposal`). The note is a
//     string or `null`; the work-item door sets no length limit on it, so neither
//     does this one.
//   * THE FINISHED-TARGET RULE (`assertMarkTargetIsFinished`, MOTIR-6663) — the
//     plan path now carries the SAME rule as the direct doors (MOTIR-6575): either
//     mark may be set only on a card whose workflow-status CATEGORY is `done`. An
//     unfinished card nobody will build is REMOVED, not marked. It asks the ONE
//     shared predicate, `canCarryObsolescence` in `lib/issues/obsolescence.ts`,
//     and needs the target's live status category, so its callers read the row:
//     the append (`assertMarkTargetsFinishedAtAppend`), the correction, and the
//     approve gate (`validatePlanProposals`), which re-reads it because a target
//     finished at the append can be reopened (after its mark is cleared) before
//     anyone presses Approve.
//
// PURE. Every refusal is an `InvalidProposalError` (422, `INVALID_PROPOSAL`) —
// the plan path's typed error, as `difficulty` uses — naming the field.

import { InvalidProposalError } from '@/lib/plans/errors';
import {
  canCarryObsolescence,
  isWorkItemObsolescence,
  WORK_ITEM_OBSOLESCENCES,
} from '@/lib/issues/obsolescence';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

/**
 * Validate the mark keys of a `modify` patch. Absent keys pass (a sparse patch
 * that leaves the mark alone); an explicit `null` passes (it clears).
 *
 * @param patch the patch as it arrived (or the correction's replacement)
 * @param label how the proposal is named in a refusal (`proposalLabel(...)`)
 */
export function validateProposedObsolescence(
  patch: { obsolescence?: unknown; obsolescenceNoteMd?: unknown } | null | undefined,
  label: string,
): void {
  if (!patch) return;
  const { obsolescence, obsolescenceNoteMd } = patch;
  if (
    obsolescence !== undefined &&
    obsolescence !== null &&
    !isWorkItemObsolescence(obsolescence)
  ) {
    throw new InvalidProposalError(
      `${label}: \`obsolescence\` "${String(obsolescence)}" is not an obsolescence mark. ` +
        `Legal values: ${WORK_ITEM_OBSOLESCENCES.join(', ')}, or null to clear it.`,
    );
  }
  if (
    obsolescenceNoteMd !== undefined &&
    obsolescenceNoteMd !== null &&
    typeof obsolescenceNoteMd !== 'string'
  ) {
    throw new InvalidProposalError(
      `${label}: \`obsolescenceNoteMd\` must be a Markdown string, or null to clear it.`,
    );
  }
}

/** The live target a mark lands on, as the finished-target rule reads it. */
export interface MarkTarget {
  /** The `<PREFIX>-<n>` key the refusal names. */
  key: string;
  /** The target's status KEY — named in the refusal, never judged. */
  status: string;
  /**
   * The CATEGORY of that status in the target's OWN project's workflow — the
   * only thing judged. `null` when the workflow defines no such status, which is
   * not finished.
   */
  statusCategory: StatusCategoryDto | null;
}

/**
 * Refuse a patch that SETS a mark (`outdated` / `deprecated`) on a target that is
 * not finished (MOTIR-6663). A patch that leaves the mark alone passes, and so
 * does `obsolescence: null` — clearing a mark is legal on any card.
 *
 * @param patch the patch as it arrived (or the correction's replacement, or the
 *   persisted patch at approve)
 * @param target the target's live key, status and status category
 * @param label how the proposal is named in a refusal (`proposalLabel(...)`)
 * @param planItemId the persisted proposal's id, when the plan is already
 *   written (the approve gate) — carried on the error for `validate_plan`
 */
export function assertMarkTargetIsFinished(
  patch: { obsolescence?: unknown } | null | undefined,
  target: MarkTarget,
  label: string,
  planItemId: string | null = null,
): void {
  if (!patchSetsObsolescence(patch)) return;
  if (canCarryObsolescence(target.statusCategory)) return;
  throw new InvalidProposalError(
    `${label}: a plan may mark only a finished work item; ${target.key} is at ${target.status}. ` +
      "A work item nobody will finish is removed — send `{ op: 'remove', workItemId, reason }` instead.",
    planItemId,
  );
}

/** True when `patch` SETS a mark — the only patches the finished-target rule judges. */
export function patchSetsObsolescence(
  patch: { obsolescence?: unknown } | null | undefined,
): boolean {
  return patch?.obsolescence !== undefined && patch?.obsolescence !== null;
}
