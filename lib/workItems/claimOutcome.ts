import type { WorkItemClaimOutcome } from '@/lib/dto/claim';

// The CLAIM VOCABULARY, in one place (MOTIR-2961, extracted by MOTIR-3049).
//
// It lived inside `workItemsService` while the keyed claim was the only caller.
// The SCOPE claim is the second, and it is required to refuse "using the same
// discriminators as the single-key claim" — a requirement a second copy of these
// four lines satisfies right up until somebody widens one of them. This module
// is the same move `lib/issues/parentRules.ts` records making for the kind-parent
// matrix: the rule gets ONE encoding, and the services validate through it.
//
// Nothing here reads the database or the workflow table. It is the pure decision
// the callers make about a row they have already locked and read.

/** Where a DISPATCHED item lands — the one status every claim path writes. */
export const IN_PROGRESS_STATUS_KEY = 'in_progress';

/**
 * The CLAIMABLE category — the CATEGORY, never the literal `todo` key. It admits
 * `todo` AND `blocked`, and that is load-bearing: `--force` exists precisely to
 * dispatch a card whose dependencies are unmet, and such a card sits at
 * `blocked`. Keying on the key alone would break that flag.
 */
export const CLAIMABLE_STATUS_CATEGORY = 'todo';

/** The category a claimed item lands in — the same literal `claimNextReady`
 *  reports for the same reason: `in_progress` is a PROTECTED default key, so a
 *  project cannot recategorise it out from under dispatch. */
export const IN_PROGRESS_STATUS_CATEGORY = 'in_progress';

/** Every refusal a claim can return, most severe first. See {@link rankClaimRefusal}. */
export type ClaimRefusalOutcome = Exclude<WorkItemClaimOutcome, 'claimed'>;

/**
 * Is this row claimable? The ONE predicate both claim paths ask.
 *
 * An ARCHIVED row is never claimable however inviting its status looks, and a
 * `null` category — a status the project's workflow does not define — is never
 * the to-do category, so it refuses too. Both arms are the safe answer as well
 * as the honest one.
 */
export function isClaimableState(state: {
  statusCategory: string | null;
  archivedAt: Date | null;
}): boolean {
  return state.archivedAt === null && state.statusCategory === CLAIMABLE_STATUS_CATEGORY;
}

/**
 * Classify a claim REFUSAL (MOTIR-2961) — a total function over every status
 * outside the to-do category.
 *
 * Only `in_progress` itself can be `mine` / `taken`: those two words mean
 * somebody is WORKING on the card, and they are told apart by WHO. Everything
 * else — `implemented` (its pull request is already open), `in_review`,
 * `planning`, `done`, `cancelled`, an archived row, any custom status — is
 * `not_claimable`, because `already_claimed` would be the wrong word for a card
 * that is finished.
 *
 * ⚠️ An `in_progress` card with NO assignee is `taken`, not claimable. That is
 * the MOTIR-2958 shape exactly: the runbook path flipped the status and never
 * assigned, so "unassigned" is evidence of nothing. The refusal still names the
 * winner — from the status-change history rather than from the assignee column.
 */
export function refusedClaimOutcome(
  status: string,
  assigneeId: string | null,
  callerId: string,
): ClaimRefusalOutcome {
  if (status !== IN_PROGRESS_STATUS_KEY) return 'not_claimable';
  return assigneeId === callerId ? 'mine' : 'taken';
}

/**
 * How BAD a refusal is, for a caller holding several of them (MOTIR-3049).
 *
 * A single-key claim never needs this — it has exactly one row and therefore one
 * verdict. A SCOPE claim routinely meets a set: a story where a sibling took one
 * card, two are already the caller's own, and one is finished. Ranking makes the
 * scope's verdict a total function of that set instead of an artifact of which
 * cuid happened to sort first, and the ranking is the caller's next MOVE:
 *
 *   `taken` (2)         — somebody else is on a card in here. Hard stop, whatever
 *                         else the set contains.
 *   `not_claimable` (1) — the scope contains finished or under-review work. The
 *                         scope is mis-drawn; that is a plan question.
 *   `mine` (0)          — nothing but the caller's own cards. A resume.
 *
 * Higher wins. A caller that reported `mine` for a scope containing a card a
 * sibling holds would resume straight into a collision, which is the one
 * mis-ranking with a cost.
 */
export function rankClaimRefusal(outcome: ClaimRefusalOutcome): number {
  if (outcome === 'taken') return 2;
  if (outcome === 'not_claimable') return 1;
  return 0;
}
