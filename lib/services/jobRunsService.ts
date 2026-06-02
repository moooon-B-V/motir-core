import { Prisma } from '@prisma/client';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDTO } from '@/lib/mappers/jobMappers';
import { withSystemContext } from '@/lib/workspaces/context';
import type { JobRunDTO, JobRunFailure } from '@/lib/dto/jobs';

// Business logic for the job_run ledger (Story 1.6 · Subtask 1.6.2, extended in
// 1.6.4). Owns the transactions; `defineJob` calls `recordStart` then either
// `recordSuccess` or `recordFailureAndDeadLetter` around the user handler. Each
// method is a one-statement-flow transaction — the writes can't share one
// transaction because the user handler runs (possibly for minutes) between them.
//
// SYSTEM-ADMIN CONTEXT (1.6.4): every write here opens its transaction through
// `withSystemContext`, which binds `app.system_admin = 'true'`. The job runtime
// runs OUTSIDE any HTTP request, so it has no active workspace context; the
// job_run / job_run_dlq RLS policies' system-admin branch is what lets these
// INSERT/UPDATEs land under the non-bypass prodect_app role in production (in
// dev/CI the superuser bypasses RLS regardless, so this is a no-op there). The
// READ path — the 1.6.5 dashboard — uses withWorkspaceContext instead, so a
// tenant sees only its own workspace's rows.

export interface RecordStartInput {
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  eventId: string;
  attempt: number;
  idempotencyKey?: string | null;
}

/** What `recordFailureAndDeadLetter` needs beyond the existing job_run row. */
export interface DeadLetterInput {
  /** The original triggering event's payload, persisted so a replay can re-emit it. */
  eventData: Prisma.InputJsonValue;
  /** Total attempts made before exhaustion (including the first). */
  attempts: number;
}

export const jobRunsService = {
  /** Insert the `running` row at job start; returns the persisted DTO. */
  async recordStart(input: RecordStartInput): Promise<JobRunDTO> {
    const run = await withSystemContext((tx) =>
      jobRunRepository.create(
        {
          // Scalar FK (not a relation connect) — see jobRunRepository.create.
          workspaceId: input.workspaceId,
          functionId: input.functionId,
          eventName: input.eventName,
          eventId: input.eventId,
          attempt: input.attempt,
          status: 'running',
          idempotencyKey: input.idempotencyKey ?? null,
        },
        tx,
      ),
    );
    return toJobRunDTO(run);
  },

  /**
   * Flip a run to `succeeded`. Reads startedAt inside the tx to compute
   * durationMs from DB timestamps (not wall-clock in the wrapper, which would
   * be wrong across Inngest's step replays).
   */
  async recordSuccess(id: string): Promise<JobRunDTO> {
    const run = await withSystemContext(async (tx) => {
      const existing = await jobRunRepository.findById(id, tx);
      if (!existing) {
        throw new Error(`job_run ${id} not found when recording success`);
      }
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - existing.startedAt.getTime();
      return jobRunRepository.update(id, { status: 'succeeded', finishedAt, durationMs }, tx);
    });
    return toJobRunDTO(run);
  },

  /**
   * Terminal failure path (1.6.4): the run has exhausted its retry budget. In
   * ONE transaction, flip the job_run to `failed` AND write the dead-letter
   * row — so the durable failure record + its replayable payload always land
   * together (no window where a run is `failed` but absent from the DLQ, or
   * vice-versa). Earlier (non-final) attempts write nothing: the row stays
   * `running` so the dashboard shows a retrying run as in-flight rather than
   * prematurely failed.
   */
  async recordFailureAndDeadLetter(
    id: string,
    failure: JobRunFailure,
    dlq: DeadLetterInput,
  ): Promise<JobRunDTO> {
    const failureJson = failure as unknown as Prisma.InputJsonObject;
    const run = await withSystemContext(async (tx) => {
      const existing = await jobRunRepository.findById(id, tx);
      if (!existing) {
        throw new Error(`job_run ${id} not found when dead-lettering`);
      }
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - existing.startedAt.getTime();
      const updated = await jobRunRepository.update(
        id,
        { status: 'failed', finishedAt, durationMs, failure: failureJson },
        tx,
      );
      await jobRunDlqRepository.create(
        {
          // The DLQ row inherits the run's tenancy via the scalar FK (a real
          // workspace id, or null for a system / cross-workspace job).
          workspaceId: existing.workspaceId,
          functionId: existing.functionId,
          eventName: existing.eventName,
          eventData: dlq.eventData,
          failure: failureJson,
          attempts: dlq.attempts,
          // firstFailedAt = when the failing run began; lastFailedAt = now (the
          // exhaustion moment). A single-run DLQ entry, so they bracket the run.
          firstFailedAt: existing.startedAt,
          lastFailedAt: finishedAt,
        },
        tx,
      );
      return updated;
    });
    return toJobRunDTO(run);
  },
};
