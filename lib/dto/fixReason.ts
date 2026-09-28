// WHY a card is stuck until something is repaired (Story MOTIR-6588 · MOTIR-6600) —
// `WorkItem.fixReason` and `WorkItem.fixDetail` as they cross the wire.
//
// The Workbench's To fix row draws a reason line and a repair command from these two
// fields alone, so everything the line NAMES is carried here rather than re-read at
// render time: the tab pages and counts like the other tabs, and a row that had to
// open its pull requests to say why it is listed would be a read per row.

/**
 * The reason, one of four, in PRIORITY order — when several hold, the first is the one
 * to repair first and the one stored (`FIX_REASON_PRIORITY`).
 *
 * - `queue_failed` — the merge queue threw a member out for a reason a code change
 *   could answer, and that exit still stands at its head.
 * - `conflicted` — the host reports a member conflicted with its base at its head.
 * - `ci_failed` — a member's own checks are red at its latest commit.
 * - `changes_requested` — a reviewer sent the card back and nothing has changed since:
 *   a `changes_requested` approve-to-merge decision at the members' CURRENT heads, or a
 *   story's acceptance video sent back with Re-run (`fixDetail.gate` says which).
 */
export type WorkItemFixReasonDto =
  | 'queue_failed'
  | 'conflicted'
  | 'ci_failed'
  | 'changes_requested';

/** Which command repairs the card — `motir fix <KEY>` or `motir run <KEY>`. */
export type FixRepairCommandDto = 'fix' | 'run';

/**
 * What the row names for its reason. Every field is present on every detail; the ones
 * a reason does not use are `null`, so a reader never has to ask whether a key exists.
 */
export interface FixDetailDto {
  /**
   * The repair command. Decided by what `motir fix` would CLAIM, not by the reason:
   * the three pull-request reasons and an acceptance Re-run are `fix`, an
   * approve-to-merge Request changes is `run` — its re-run's prompt carries the note.
   */
  repair: FixRepairCommandDto;
  /**
   * `ci_failed`: the first failing check at the member's latest commit, by name.
   * `queue_failed`: the check the queue's attempt named, or null when it named none.
   */
  check: string | null;
  /** `queue_failed`: GitHub's own reason (`CI_FAILURE`, `MERGE_CONFLICT`, …). */
  queueReason: string | null;
  /** `conflicted`: the base branch the member conflicts with; null on a row mirrored
   *  before base branches were recorded. */
  base: string | null;
  /** `changes_requested`: who sent it back, as recorded at the decision. */
  reviewerName: string | null;
  /** `changes_requested`: the first non-empty line of the reviewer's note, trimmed and
   *  cut to `FIX_NOTE_PREVIEW_MAX` characters; null when the note is empty. */
  notePreview: string | null;
  /** `changes_requested`: which gate the refusal was on — the approve-to-merge question
   *  or a story's acceptance video. Null on the pull-request reasons. */
  gate: 'pull_request_approval' | 'acceptance_result' | null;
  /** How many of the card's OPEN pull requests the reason affects. */
  affected: number;
  /** How many open pull requests deliver the card — the row says "N of M" when > 1. */
  total: number;
}
