import type { JobRun } from '@prisma/client';
import type { JobRunDTO, JobRunFailure, JobRunStatus } from '@/lib/dto/jobs';

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
