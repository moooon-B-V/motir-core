import { Prisma } from '@/generated/prisma/client';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { toJobRunDTO } from '@/lib/mappers/jobMappers';
import { withSystemContext } from '@/lib/workspaces/context';
import type { JobRunDTO, JobRunFailure, JobRunLane } from '@/lib/dto/jobs';

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
// INSERT/UPDATEs land under the non-bypass motir_app role in production (in
// dev/CI the superuser bypasses RLS regardless, so this is a no-op there). The
// READ path — the 1.6.5 dashboard — uses withWorkspaceContext instead, so a
// tenant sees only its own workspace's rows.

export interface RecordStartInput {
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  eventId: string;
  /**
   * WHICH ENGINE is writing this row (Bug MOTIR-3683). Required, with no default,
   * so a third writer cannot acquire a lane by accident: the two that exist —
   * `defineJob`'s Inngest handler and `lib/jobs/engine/ledger.ts` — each know
   * their own answer with certainty, and nothing downstream should be guessing it
   * from `eventId`'s shape.
   */
  lane: JobRunLane;
  attempt: number;
  idempotencyKey?: string | null;
}

/**
 * A late job whose tenant workspace — or whose own `job_run` row — was removed
 * out from under it. In production a hard tenant deletion; in the E2E harness a
 * between-test `TRUNCATE ... CASCADE` that a still-in-flight job outlives
 * (MOTIR-1545). Two shapes reach a ledger write:
 *   - the parent workspace is gone → an INSERT/UPDATE trips the workspace FK
 *     (Prisma `P2003`, wrapping the pg driver adapter's
 *     `ForeignKeyConstraintViolation`);
 *   - the row itself is gone → an update/delete targets a missing row
 *     (Prisma `P2025`).
 * Recording success / failure / start for such a run is MOOT, so the service
 * treats it as a benign terminal no-op rather than letting the rejection escape
 * `step.run` as an unhandled rejection that degrades the process. (`recordSuccess`
 * catches the "row gone" case up front via `findById` too — this backstops the
 * races where the parent vanishes DURING the write.)
 */
function isVanishedRunError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === 'P2003' || err.code === 'P2025';
  }
  // Defensive: some adapter paths can surface the FK violation un-wrapped.
  const message = err instanceof Error ? err.message : String(err);
  return /ForeignKeyConstraintViolation/i.test(message);
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
  /** The lane, for the row this may have to CREATE when correlation misses. */
  lane: JobRunLane;
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

/**
 * How long a ledger row may say `running` before the reap will close it, when
 * nothing else is holding it (Bug MOTIR-3683).
 *
 * Six hours, and the number is a floor rather than a preference: on the INNGEST
 * lane there is no queue row to consult, so this threshold is the ENTIRE test,
 * and the longest legitimately-long run observed on this ledger
 * (`system.code-graph-refresh`, five attempts) spanned about two. Closing a live
 * run is the worse error of the two available, so the margin goes that way.
 * ENGINE rows are protected by the queue-liveness veto regardless of age.
 */
export const JOB_RUN_ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;

/** How many stranded rows one sweep closes. A backlog drains over several passes. */
export const JOB_RUN_REAP_BATCH_SIZE = 200;

/**
 * The `failure.code` an abandoned row carries, so the operator surface — and any
 * audit — can tell "nothing ever came back" from "the handler threw". The two
 * are different facts and only one of them has a stack trace.
 */
export const JOB_RUN_ABANDONED_CODE = 'job_run_abandoned';

export const jobRunsService = {
  /**
   * Insert the `running` row at job start; returns the persisted DTO, or `null`
   * when the run's tenant workspace has already vanished (see
   * `isVanishedRunError`) — a job starting mid-teardown must not crash the
   * process on the workspace FK.
   */
  async recordStart(input: RecordStartInput): Promise<JobRunDTO | null> {
    try {
      const run = await withSystemContext((tx) =>
        jobRunRepository.create(
          {
            // Scalar FK (not a relation connect) — see jobRunRepository.create.
            workspaceId: input.workspaceId,
            functionId: input.functionId,
            eventName: input.eventName,
            eventId: input.eventId,
            lane: input.lane,
            attempt: input.attempt,
            status: 'running',
            idempotencyKey: input.idempotencyKey ?? null,
          },
          tx,
        ),
      );
      return toJobRunDTO(run);
    } catch (err) {
      if (isVanishedRunError(err)) return null;
      throw err;
    }
  },

  /**
   * Flip a run to `succeeded`. Reads startedAt inside the tx to compute
   * durationMs from DB timestamps (not wall-clock in the wrapper, which would
   * be wrong across Inngest's step replays).
   *
   * `output` (5.2.7) is the handler's resolved value when it is JSON-safe —
   * defineJob hands it over so a run's summary (the attachment-GC's
   * scanned/deleted/failed counts) lives on the ledger row itself. Omitted /
   * undefined stores NULL.
   */
  async recordSuccess(id: string, output?: Prisma.InputJsonValue): Promise<JobRunDTO | null> {
    try {
      const run = await withSystemContext(async (tx) => {
        const existing = await jobRunRepository.findById(id, tx);
        // Row gone (an orphaned run from a torn-down test, or a genuinely
        // deleted run): recording success is a benign no-op (MOTIR-1545).
        if (!existing) return null;
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - existing.startedAt.getTime();
        return jobRunRepository.update(
          id,
          {
            status: 'succeeded',
            finishedAt,
            durationMs,
            ...(output !== undefined ? { output } : {}),
          },
          tx,
        );
      });
      return run ? toJobRunDTO(run) : null;
    } catch (err) {
      // Backstop the race where the row/tenant vanishes mid-transaction.
      if (isVanishedRunError(err)) return null;
      throw err;
    }
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
  async recordTerminalFailure(input: TerminalFailureInput): Promise<JobRunDTO | null> {
    const failureJson = input.failure as unknown as Prisma.InputJsonObject;
    try {
      const run = await withSystemContext(async (tx) => {
        const existing = await jobRunRepository.findUnsettledByEventId(
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
                lane: input.lane,
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
    } catch (err) {
      // A stranded onFailure whose tenant workspace vanished (teardown / hard
      // delete) must not FK-crash the process — recording the failure is moot
      // once the tenant is gone (MOTIR-1545).
      if (isVanishedRunError(err)) return null;
      throw err;
    }
  },

  /**
   * THE ABANDONED-RUN REAP (Bug MOTIR-3683) — close every ledger row that is
   * still `running` with nothing left to finish it.
   *
   * ⚠️ IT IS NOT A FIX FOR THE CAUSE, and stating that is the point of having it.
   * The cause measured on this ledger was one lane deriving `event_id` two
   * different ways, and that is repaired where it happened. This is the standing
   * answer to the CLASS: a completion write is a write, and a write can always be
   * lost — the process is SIGKILLed, the machine is replaced, a lane is
   * misconfigured, a future engine grows a path nobody has thought of yet. Every
   * one of those leaves a row saying `running` for ever, and `running` is the
   * most reassuring possible rendering of a dead run. A ledger whose integrity
   * depends on no write ever being lost has no integrity to depend on.
   *
   * TWO SIGNALS, and only one of them exists on both lanes:
   *
   *   1. **A live queue row** — decisive, and available for ENGINE rows only. A
   *      run sleeping at a `step.sleep` or waiting out a retry backoff is
   *      `pending` with a future `run_at`, and its ledger row is legitimately
   *      still `running`. Reaping that would close a run about to resume, so a
   *      live queue row vetoes the reap outright, however old the row is.
   *   2. **Elapsed time** — the only signal an INNGEST row has, because that lane
   *      writes no queue row at all. Hence a threshold set generously (six hours,
   *      against a longest observed legitimate run of about two) rather than
   *      tightly: on that lane the threshold is the whole test, and closing a
   *      live run is a worse error than closing a dead one late.
   *
   * `durationMs` is deliberately left NULL. The row's `finished_at` is when the
   * reap NOTICED, not when the run stopped, and a duration computed from it would
   * be a number nobody measured — which is the genre of thing this whole bug is
   * about.
   */
  async reapAbandoned(
    opts: { now?: Date; olderThanMs?: number; limit?: number } = {},
  ): Promise<{ scanned: number; abandoned: number; stillLive: number }> {
    const now = opts.now ?? new Date();
    const olderThanMs = opts.olderThanMs ?? JOB_RUN_ABANDON_AFTER_MS;
    const limit = opts.limit ?? JOB_RUN_REAP_BATCH_SIZE;
    const startedBefore = new Date(now.getTime() - olderThanMs);

    return withSystemContext(async (tx) => {
      const candidates = await jobRunRepository.findStaleRunning(startedBefore, limit, tx);
      let abandoned = 0;
      let stillLive = 0;
      for (const run of candidates) {
        const live = await jobQueueRepository.countLiveForEventRef(run.functionId, run.eventId, tx);
        if (live > 0) {
          stillLive += 1;
          continue;
        }
        // Guarded on the row still being `running` — a worker that was merely
        // slow may have settled it between the read above and this write, and
        // overwriting a real terminal state with `abandoned` would destroy the
        // one record an operator needs.
        abandoned += await jobRunRepository.markAbandonedIfRunning(
          run.id,
          now,
          {
            message: `Abandoned after ${Math.round(olderThanMs / 60_000)} minutes with no completion write and no live queue run.`,
            code: JOB_RUN_ABANDONED_CODE,
          },
          tx,
        );
      }
      return { scanned: candidates.length, abandoned, stillLive };
    });
  },
};
