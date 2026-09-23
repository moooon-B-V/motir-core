// ── A proposed DIFFICULTY's bar, at EVERY proposal write door ─────────────────
// (Story MOTIR-6095 · MOTIR-6133; `docs/decisions/agent-authored-plans.md`
// AMENDMENT 19.)
//
// A plan proposal can carry a leaf's difficulty, and approve writes it straight
// onto the work item — `materialize` builds the Prisma create data itself and
// `applyModify` builds the update, so NEITHER passes through `workItemsService`
// and its `DifficultyNotAllowedOnKindError` never runs on the plan path. This
// module is the plan path's own bar, and the ONE implementation of it: the
// append (`validateProposal` + the `modify` target read), the deepen
// (`editAddProposal`) and the correction (`correctProposal`) all call
// {@link validateProposedDifficulty}, and the approve-time grammar check
// (`validateProposals.ts`, `difficulty_on_container`) asks
// {@link isDifficultyRefusedOnKind}. So "may this proposal carry a difficulty"
// has exactly one answer on the plan path, and it cannot drift between doors.
//
// Leaf-only is decided by KIND through `TYPEABLE_KINDS`, the predicate 6016's
// service door and `type` / `executor` use — never by childlessness — and it is
// judged on the proposal's EFFECTIVE kind (merged, not patched), because a
// deepen or a correction can change `kind` after the append.
//
// PURE: no DB, no Prisma client, no `tx`. Every refusal is an
// `InvalidProposalError` (`INVALID_PROPOSAL` → 422 `PROPOSALS_INVALID`), the
// family every other proposal-content refusal uses (the `todos` precedent,
// AMENDMENT 14) — deliberately NOT the work-item family's
// `DIFFICULTY_NOT_ALLOWED_ON_KIND`, which describes a row that does not exist yet.

import type { WorkItemDifficultyDto, WorkItemKindDto } from '@/lib/dto/workItems';
import { InvalidProposalError } from '@/lib/plans/errors';
import { WORK_ITEM_DIFFICULTIES, isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { TYPEABLE_KINDS } from '@/lib/issues/executorDefaults';

/**
 * True when a PRESENT (non-null) difficulty sits on a kind that may not carry
 * one — a container. `undefined` / `null` are never refused: clearing a
 * difficulty is always legal, whatever the kind.
 */
export function isDifficultyRefusedOnKind(difficulty: unknown, kind: string): boolean {
  if (difficulty === undefined || difficulty === null) return false;
  return !TYPEABLE_KINDS.has(kind as WorkItemKindDto);
}

/**
 * Validate a proposed difficulty for a proposal of `kind`.
 *
 * @param difficulty the value as it arrived (or as the sparse merge left it)
 * @param kind       the proposal's EFFECTIVE kind — an `add`'s merged
 *                   `proposedFields.kind ?? DEFAULT_PROPOSED_KIND`, or a
 *                   `modify`'s TARGET kind. `null` when the kind is not yet
 *                   knowable at this point (a `modify` before its target is
 *                   read): only MEMBERSHIP is judged then, and the caller owes
 *                   the kind check once it has read the target.
 * @param label      how the proposal is named in a refusal (`proposalLabel(...)`)
 */
export function validateProposedDifficulty(
  difficulty: unknown,
  kind: string | null,
  label: string,
): asserts difficulty is WorkItemDifficultyDto | null | undefined {
  if (difficulty === undefined || difficulty === null) return;

  if (!isWorkItemDifficulty(difficulty)) {
    throw new InvalidProposalError(
      `${label}: \`difficulty\` "${String(difficulty)}" is not a difficulty. Legal values: ${WORK_ITEM_DIFFICULTIES.join(', ')}, or null to clear it.`,
    );
  }

  if (kind !== null && isDifficultyRefusedOnKind(difficulty, kind)) {
    throw new InvalidProposalError(
      `${label}: a \`${kind}\` is a container and cannot carry a \`difficulty\` ("${difficulty}"). Difficulty belongs on the leaves that do the work — set it on them, or send \`difficulty: null\`.`,
    );
  }
}
