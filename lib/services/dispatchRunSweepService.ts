import { DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import {
  DISPATCH_RUN_ABANDON_AFTER_HOURS,
  DISPATCH_RUN_BODY_RETENTION_DAYS,
  dispatchRunService,
} from '@/lib/services/dispatchRunService';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';

// THE DISPATCH-RUN HOUSEKEEPING (Story MOTIR-1789 · MOTIR-1792) — the two
// obligations `docs/decisions/dispatch-run-record.md` Q4.2 assigns to this card.
//
// They share a service because they share a shape and a schedule: both are
// nightly, both DISCOVER across tenants and both WRITE per tenant. Neither is a
// convenience — each closes a hole the record would otherwise have:
//
//   1. THE RETENTION SWEEP nulls opt-in log bodies past their window. The body is
//      the only private, unbounded, low-half-life part of the record, and the
//      30-day window is half of what the product PROMISES an operator who turns
//      `--report-log` on. A promise with no clock behind it is a sentence in a
//      document.
//   2. THE ABANDONED-RUN REAP closes a run nothing is holding. A `running` row is
//      honest only while a process is still reporting to it; once nothing is,
//      `running` is the most reassuring possible way to render a dead run — the
//      run view says *working*, the cards under it never move again, and nobody
//      looks twice. The same argument `job_run`'s own reap makes (MOTIR-3683).
//
// ── THE TENANCY SHAPE, and why it is not one transaction ──────────────────
// The discovery reads run under `withSystemContext`, which arms the `FOR SELECT`
// system policy the `20260829130000_dispatch_run_system_read` migration adds —
// the workspace is not known until the first row comes back, so no wrapper could
// have bound it up front. Every WRITE then re-opens under
// `withWorkspaceContext` bound to THAT ROW'S OWN workspace, so nothing is ever
// written untenanted. The system arm is read-only precisely so this split cannot
// be short-circuited by a later job.
//
// ── A PER-ROW FAILURE NEVER FAILS THE TICK ────────────────────────────────
// Each run is closed in its own transaction and a refusal is counted rather than
// thrown. Retrying the tick would re-visit every run that already closed to
// reach the one that did not, and the one that did not is simply due again
// tomorrow — the same retry with none of the blast radius (the shape
// `accountErasureSweep` states for the same reason).

/** How many workspaces one retention pass clears, and how many runs one reap closes. */
export const DISPATCH_RUN_SWEEP_BATCH_SIZE = 200;

export interface DispatchRunSweepSummary {
  /** Workspaces whose expired bodies were cleared. */
  workspacesSwept: number;
  /** Event rows whose `body` was nulled. */
  bodiesCleared: number;
  /** Runs closed as `timed_out` / `abandoned`. */
  runsReaped: number;
  /**
   * Runs the discovery read found and that were already terminal by the time the
   * close ran — somebody's CLI got there first in the seconds between.
   *
   * Counted rather than swallowed, and NOT counted as reaped: a number that
   * conflated the two would report the reap doing work it did not do, on exactly
   * the nights when a fleet of runs finished normally.
   */
  runsRacedByClose: number;
  /** Runs whose close failed for any other reason. Logged, never thrown. */
  runsFailed: number;
}

export const dispatchRunSweepService = {
  async sweep(now: Date = new Date()): Promise<DispatchRunSweepSummary> {
    const summary: DispatchRunSweepSummary = {
      workspacesSwept: 0,
      bodiesCleared: 0,
      runsReaped: 0,
      runsRacedByClose: 0,
      runsFailed: 0,
    };

    // ── 1. The retention sweep ────────────────────────────────────────────
    const bodyCutoff = new Date(
      now.getTime() - DISPATCH_RUN_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const workspaceIds = await withSystemContext((tx) =>
      dispatchRunEventRepository.listWorkspacesWithExpiredBodies(
        bodyCutoff,
        DISPATCH_RUN_SWEEP_BATCH_SIZE,
        tx,
      ),
    );
    for (const workspaceId of workspaceIds) {
      const cleared = await withWorkspaceContext({ userId: '', workspaceId }, (tx) =>
        dispatchRunEventRepository.clearBodiesOlderThan(bodyCutoff, tx),
      );
      summary.workspacesSwept += 1;
      summary.bodiesCleared += cleared;
    }

    // ── 2. The abandoned-run reap ─────────────────────────────────────────
    const runCutoff = new Date(now.getTime() - DISPATCH_RUN_ABANDON_AFTER_HOURS * 60 * 60 * 1000);
    const stale = await withSystemContext((tx) =>
      dispatchRunRepository.listStaleRunningAcrossWorkspaces(
        runCutoff,
        DISPATCH_RUN_SWEEP_BATCH_SIZE,
        tx,
      ),
    );
    for (const run of stale) {
      // ⚠️ THROUGH `dispatchRunService.close`, deliberately — NOT a direct write.
      // The reap and the CLI's own close must take the SAME row lock and the
      // SAME already-terminal refusal, or the reap becomes the thing that can
      // overwrite a clean close with `timed_out`. `userId` is the run's own
      // initiator (or empty, when the account has since been deleted): the GUC
      // is bound because `withWorkspaceContext` always binds it, and no policy
      // on these three tables reads it.
      try {
        await dispatchRunService.close(
          run.id,
          { stopReason: 'abandoned' },
          { userId: run.createdById ?? '', workspaceId: run.workspaceId },
        );
        summary.runsReaped += 1;
      } catch (err) {
        if (err instanceof DispatchRunTerminalError) {
          summary.runsRacedByClose += 1;
          continue;
        }
        summary.runsFailed += 1;
        console.error('[dispatch-run-sweep] failed to reap run', run.id, err);
      }
    }

    return summary;
  },
};
