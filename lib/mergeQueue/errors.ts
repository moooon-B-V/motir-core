// QUEUE AGAIN's own refusals (Story MOTIR-5461 · MOTIR-5634) — the ones that are not
// about an approval gate. `auto` mode has no gate to reuse, so its press is refused in
// these words; the manual press reuses the gate's vocabulary
// (`lib/approvalGates/errors.ts`), including `MERGE_ALREADY_REQUEUED`.

export type QueueAgainRefusalReason =
  /** The project is not in the mode this entry point serves. */
  | 'wrong_mode'
  /** The card does not deliver this pull request. */
  | 'not_delivered'
  /** The pull request has no merge-queue exit that still stands. */
  | 'no_exit'
  /** A push moved the head since it left the queue — the green verdict re-arms it. */
  | 'head_moved'
  /** It is closed or merged. */
  | 'not_open';

export class QueueAgainRefusedError extends Error {
  readonly code = 'QUEUE_AGAIN_REFUSED' as const;
  constructor(
    readonly reason: QueueAgainRefusalReason,
    readonly pullRequestId: string,
  ) {
    super(`Queue again was refused for pull request ${pullRequestId}: ${reason}.`);
    this.name = 'QueueAgainRefusedError';
  }
}
