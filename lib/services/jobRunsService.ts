import { Prisma } from '@prisma/client';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDTO } from '@/lib/mappers/jobMappers';
import { withSystemContext } from '@/lib/workspaces/context';
import type { JobRunDTO, JobRunFailure } from '@/lib/dto/jobs';

// Business logic for the job_run ledger (Story 1.6 · Subtask 1.6.2, extended in
// 1.6.4, failure path reworked in 1.6.6). Owns the transactions. `defineJob`'s
// run handler calls `recordStart` then `recordSuccess`; its `onFailure` handler
// calls `recordTerminalFailure` once the retry budget is spent (the failure path
// moved out of the run handler — see recordTerminalFailure / FINDINGS #39). Each
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

/**
 * Everything the terminal-failure path needs. Unlike the old
 * `recordFailureAndDeadLetter`, this does NOT take a job_run row id: the failure
 * is reported by Inngest's `onFailure` handler, a SEPARATE invocation that has
 * the original event but not the row id. The service correlates back to the
 * `running` row by (functionId, eventId) — see `recordTerminalFailure`.
 */
export interface TerminalFailureInput {
  /** The job id (= functionId on the ledger row). */
  functionId: string;
  /** The triggering event's id — correlates back to the `running` row. */
  eventId: string;
  /** Ledger event name (the synthetic `scheduled.{id}` for cron jobs). */
  eventName: string;
  /** Tenancy of the run (a real workspace, or null for system/cross-workspace). */
  workspaceId: string | null;
  /** The serialized final error. */
  failure: JobRunFailure;
  /** The original event payload, persisted so a replay can re-emit it. */
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
   * Terminal failure path (1.6.4 mechanism; reworked in 1.6.6). The run has
   * exhausted its retry budget. Inngest reports this via the function's
   * `onFailure` handler (NOT the run's own handler — see defineJob), so this
   * method is invoked OUT of the failing run's context: it correlates back to
   * the `running` row by (functionId, eventId) instead of receiving a row id.
   *
   * Why onFailure and not a try/catch in the handler (the 1.6.4 approach):
   * PRODECT_FINDINGS #39. On the REAL Inngest runtime, a `step.run` scheduled
   * from a catch block AFTER the step that terminally failed is never executed —
   * the executor finalizes the run as failed first. So the 1.6.4 dead-letter
   * write silently never happened in production (the in-process unit harness ran
   * the catch synchronously, masking it). `onFailure` is Inngest's first-class
   * "run exactly once after all retries are exhausted" hook, so the write is
   * reliable. The forced-failure E2E (1.6.6) is what surfaced the gap.
   *
   * In ONE transaction: flip the `running` job_run to `failed` AND write the
   * dead-letter row, so the durable failure record + its replayable payload
   * always land together. If no `running` row is found (the start write was
   * lost, or eventId correlation missed), it still writes a `failed` row + DLQ
   * row from the onFailure payload — a dead-letter is never dropped. Earlier
   * (non-final) attempts write nothing: the row stays `running` so the dashboard
   * shows a retrying run as in-flight rather than prematurely failed.
   */
  async recordTerminalFailure(input: TerminalFailureInput): Promise<JobRunDTO> {
    const failureJson = input.failure as unknown as Prisma.InputJsonObject;
    const run = await withSystemContext(async (tx) => {
      const existing = await jobRunRepository.findRunningByEventId(
        input.eventId,
        input.functionId,
        tx,
      );
      const finishedAt = new Date();
      // Tenancy + the run start come from the existing row when we found it;
      // otherwise fall back to the onFailure payload (defensive, see above).
      const workspaceId = existing ? existing.workspaceId : input.workspaceId;
      const startedAt = existing ? existing.startedAt : finishedAt;
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      const failedRun = existing
        ? await jobRunRepository.update(
            existing.id,
            { status: 'failed', finishedAt, durationMs, failure: failureJson },
            tx,
          )
        : await jobRunRepository.create(
            {
              workspaceId,
              functionId: input.functionId,
              eventName: input.eventName,
              eventId: input.eventId,
              attempt: input.attempts - 1, // zero-indexed final attempt
              status: 'failed',
              finishedAt,
              durationMs,
              failure: failureJson,
            },
            tx,
          );

      await jobRunDlqRepository.create(
        {
          // The DLQ row inherits the run's tenancy via the scalar FK (a real
          // workspace id, or null for a system / cross-workspace job).
          workspaceId,
          functionId: input.functionId,
          eventName: input.eventName,
          eventData: input.eventData,
          failure: failureJson,
          attempts: input.attempts,
          // firstFailedAt = when the failing run began; lastFailedAt = now (the
          // exhaustion moment). A single-run DLQ entry, so they bracket the run.
          firstFailedAt: startedAt,
          lastFailedAt: finishedAt,
        },
        tx,
      );
      return failedRun;
    });
    return toJobRunDTO(run);
  },
};
