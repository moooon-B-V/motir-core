import type { JobRun, JobRunDlq } from '@prisma/client';
import type { JobRunDTO, JobRunDlqDTO, JobRunFailure, JobRunStatus } from '@/lib/dto/jobs';

// Prisma JobRun → JobRunDTO. Dates → ISO strings; the JSON `failure` column is
// narrowed to the JobRunFailure wire shape (the service is the only writer and
// only ever stores that shape, so the cast is safe at the read edge — same
// pattern as workItemRevision's diff cast).
export function toJobRunDTO(run: JobRun): JobRunDTO {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    functionId: run.functionId,
    eventName: run.eventName,
    eventId: run.eventId,
    attempt: run.attempt,
    status: run.status as JobRunStatus,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    durationMs: run.durationMs,
    failure: (run.failure as JobRunFailure | null) ?? null,
    idempotencyKey: run.idempotencyKey,
  };
}

// Prisma JobRunDlq → JobRunDlqDTO (Subtask 1.6.4). `failure` is non-null here
// (a DLQ row only exists for a failed run) and narrowed to JobRunFailure; the
// service is the only writer of both JSON columns. `eventData` stays `unknown`
// at the boundary — it's the original event payload, shaped per job.
export function toJobRunDlqDTO(row: JobRunDlq): JobRunDlqDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    functionId: row.functionId,
    eventName: row.eventName,
    eventData: row.eventData,
    failure: row.failure as unknown as JobRunFailure,
    attempts: row.attempts,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
    replayedAt: row.replayedAt ? row.replayedAt.toISOString() : null,
  };
}
