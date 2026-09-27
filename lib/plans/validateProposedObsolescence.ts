// ── A proposed OBSOLESCENCE mark's bar, at the proposal write doors ───────────
// (Story MOTIR-6577 · MOTIR-6629.)
//
// A `modify` patch can carry the target's obsolescence mark and its note, and
// approve writes them straight onto the work item — `applyModify` builds the
// update itself, so the direct door's `assertObsolescence` (and its
// `InvalidObsolescenceError`) never runs on the plan path. This is the plan
// path's own bar, called by the append (`validateProposal`) and the correction
// (`correctProposal`), so a value approve could not write is refused while the
// author still has the plan to fix — never silently dropped, never a raw enum
// error mid-approve.
//
// MEMBERSHIP ONLY, over the same `WORK_ITEM_OBSOLESCENCES` the direct door reads,
// and deliberately NO kind or status predicate: the mark is kind- and
// status-agnostic (the ONE difference from `validateProposedDifficulty`). The
// note is a string or `null`; the work-item door sets no length limit on it, so
// neither does this one.
//
// PURE. Every refusal is an `InvalidProposalError` (422, `INVALID_PROPOSAL`) —
// the plan path's typed error, as `difficulty` uses — naming the field.

import { InvalidProposalError } from '@/lib/plans/errors';
import { isWorkItemObsolescence, WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';

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
