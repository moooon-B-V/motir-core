// WHAT A MERGE-QUEUE REMOVAL MEANS (Story MOTIR-5461 · MOTIR-5632).
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 2 — the reason
// map, closed and total. PURE: no service, no database.
//
// ⚠️ THE SPELLING IS THE WEBHOOK'S, NOT THE GRAPHQL TIMELINE'S. MOTIR-5627 read 110
// real `pull_request` `dequeued` deliveries: `MERGE` 88, `CI_FAILURE` 15, `MANUAL` 4,
// `MERGE_CONFLICT` 3 — UPPER_SNAKE, the published webhook enum. The timeline's
// `failed_checks` / `merged` / `checks_timed_out` never appear in a delivery, so the
// match is EXACT and nothing is case-folded: a lowercase string is an unrecognised
// one, which is the safe direction (it moves no card).

/** What a removal does to the cards the pull request delivers. */
export type QueueExitDisposition = 'failure' | 'neutral' | 'landed';

/**
 * Every value the capture observed plus every value in the published webhook
 * enum (`@octokit/openapi-webhooks`, `webhook-pull-request-dequeued.reason`), each
 * with exactly one disposition. The table is the decision record's, row for row.
 */
export const QUEUE_EXIT_REASONS = {
  // The queue's checks failed on the merge group (seen in a delivery).
  CI_FAILURE: 'failure',
  // The checks did not finish in time (published; GitHub lists a timeout beside
  // failures as a removal cause).
  CI_TIMEOUT: 'failure',
  // It does not combine with what is ahead of it (seen in a delivery).
  MERGE_CONFLICT: 'failure',
  // The queue could not build a merge commit / a tree for it (published).
  INVALID_MERGE_COMMIT: 'failure',
  GIT_TREE_INVALID: 'failure',
  // "Branch protection failure that could not automatically be resolved".
  BRANCH_PROTECTIONS: 'failure',
  // Somebody took it out on purpose (seen in a delivery).
  MANUAL: 'neutral',
  // The queue was reset.
  QUEUE_CLEARED: 'neutral',
  // Removed for a roll-back, not for its own content.
  ROLL_BACK: 'neutral',
  // GitHub itself does not know; a card never moves on an unknown.
  UNKNOWN_REMOVAL_REASON: 'neutral',
  // It merged (seen in a delivery) / it was merged already.
  MERGE: 'landed',
  ALREADY_MERGED: 'landed',
} as const satisfies Record<string, QueueExitDisposition>;

export type KnownQueueExitReason = keyof typeof QUEUE_EXIT_REASONS;

export interface QueueExitClassification {
  disposition: QueueExitDisposition;
  /** False for a string the table does not name — the caller logs it raw, once. */
  recognised: boolean;
}

/**
 * Classify one raw removal reason. TOTAL: an unrecognised string (or none at all)
 * is `neutral` and reported as unrecognised, so a card never moves on a reason
 * nobody has seen and a new spelling stays visible.
 */
export function classifyQueueExit(rawReason: string | null | undefined): QueueExitClassification {
  if (rawReason && Object.hasOwn(QUEUE_EXIT_REASONS, rawReason)) {
    return {
      disposition: QUEUE_EXIT_REASONS[rawReason as KnownQueueExitReason],
      recognised: true,
    };
  }
  return { disposition: 'neutral', recognised: false };
}
