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
  /** Null for untenanted system jobs (e.g. system.ping). */
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
  idempotencyKey: string | null;
}
