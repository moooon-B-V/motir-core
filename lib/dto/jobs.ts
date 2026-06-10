// DTO for the background-job run ledger (Story 1.6 · Subtask 1.6.2). What the
// operator dashboard (1.6.5) and any future API render — never the raw Prisma
// `JobRun` model. Dates cross the boundary as ISO strings.

export type JobRunStatus = 'running' | 'succeeded' | 'failed';

/** A serialized failure captured when a job run ends in `failed`. */
export interface JobRunFailure {
  message: string;
  stack?: string;
  code?: string;
}

export interface JobRunDTO {
  id: string;
  /** Null for untenanted system jobs (e.g. system.daily-health-check). */
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  eventId: string;
  attempt: number;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  failure: JobRunFailure | null;
  /** The handler's JSON-safe resolved value, recorded on success (5.2.7) — e.g. the attachment-GC's { scanned, deleted, failed } summary. */
  output: unknown;
  idempotencyKey: string | null;
}

/**
 * A dead-lettered job (Story 1.6 · Subtask 1.6.4) — what the 1.6.5 dashboard's
 * DLQ tab renders and the "Replay" button acts on. Carries the original event
 * payload (`eventData`) so a replay can re-emit it. Dates cross as ISO strings.
 */
export interface JobRunDlqDTO {
  id: string;
  /** Null for untenanted system / cross-workspace jobs. */
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  /** The original triggering event's full payload, for replay. */
  eventData: unknown;
  failure: JobRunFailure;
  /** Total attempts made before dead-lettering (including the first). */
  attempts: number;
  /** When the failing run started. */
  firstFailedAt: string;
  /** When the retry budget was exhausted. */
  lastFailedAt: string;
  /** When an operator replayed this entry, or null if not yet replayed. */
  replayedAt: string | null;
}
