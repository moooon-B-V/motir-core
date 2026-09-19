import type { MergeRefusalCode } from '@/lib/git/types';
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

/**
 * WHAT A PERSON CAN DO ABOUT AN UN-LANDED MERGE (§4 FOURTH AMENDMENT, point 2;
 * MOTIR-5802 · MOTIR-5805). One question decides it: could re-running these SAME
 * commits land them?
 *
 *  · `retryable`  — yes (a flaky check, a cleared queue, a hand removal): ask again.
 *  · `cant_land`  — no, not as they stand (a conflict): asking would offer a button
 *                   guaranteed to fail, so the card goes back to Implemented and
 *                   `motir fix` is the way forward.
 *  · `setting`    — yes, once a person changes a SETTING (branch protection): ask
 *                   again, and name the setting.
 *  · `landed`     — it merged; there is nothing to ask.
 *
 * ⚠️ THE CLASS IS NOT THE DISPOSITION, and both survive. The disposition says what the
 * removal did to the card the moment it arrived; the class says what may be done about
 * it now. `BRANCH_PROTECTIONS` is a `failure` and a `setting`; `MANUAL` is `neutral`
 * and `retryable`.
 */
export type LandingClass = 'retryable' | 'cant_land' | 'setting' | 'landed';

/** Every reason the table above names, with its class. Total by construction. */
const QUEUE_EXIT_CLASSES = {
  CI_FAILURE: 'retryable',
  CI_TIMEOUT: 'retryable',
  INVALID_MERGE_COMMIT: 'retryable',
  GIT_TREE_INVALID: 'retryable',
  MANUAL: 'retryable',
  QUEUE_CLEARED: 'retryable',
  ROLL_BACK: 'retryable',
  UNKNOWN_REMOVAL_REASON: 'retryable',
  MERGE_CONFLICT: 'cant_land',
  BRANCH_PROTECTIONS: 'setting',
  MERGE: 'landed',
  ALREADY_MERGED: 'landed',
} as const satisfies Record<KnownQueueExitReason, LandingClass>;

/**
 * Classify one raw removal reason by what can be DONE about it. TOTAL: an unrecognised
 * string is `retryable`, which is the safe default — a person is asked and can still
 * reach for `motir fix`, where `cant_land` would silently offer them nothing.
 */
export function classOfQueueExit(rawReason: string | null | undefined): LandingClass {
  if (rawReason && Object.hasOwn(QUEUE_EXIT_CLASSES, rawReason)) {
    return QUEUE_EXIT_CLASSES[rawReason as KnownQueueExitReason];
  }
  return 'retryable';
}

/**
 * The HOST's own refusal codes, classed by the same question (§4 FOURTH AMENDMENT,
 * point 2; MOTIR-5833). ONE map answers for both sources, so the card cannot be
 * settled one way by the queue and another way by the press.
 *
 * ⚠️ `subject_changed` IS NOT AN OUTCOME and answers `null`. It means the head moved
 * under the press, so nothing was attempted and no approval was spent — the
 * stale-stamp path (MOTIR-5232), not a failed landing.
 */
const MERGE_REFUSAL_CLASSES: Record<MergeRefusalCode, LandingClass | null> = {
  checks_not_green: 'cant_land',
  conflict: 'cant_land',
  branch_protected: 'setting',
  app_permission_missing: 'setting',
  already_merged: 'landed',
  subject_changed: null,
};

/**
 * Classify one host refusal. TOTAL over `MergeRefusalCode`, and `retryable` for any
 * string outside it — a second host may name a refusal this deployment has never
 * seen, and the safe default is to ask a person rather than to offer them nothing.
 */
export function classOfMergeRefusal(code: string): LandingClass | null {
  if (Object.hasOwn(MERGE_REFUSAL_CLASSES, code)) {
    return MERGE_REFUSAL_CLASSES[code as MergeRefusalCode];
  }
  return 'retryable';
}
