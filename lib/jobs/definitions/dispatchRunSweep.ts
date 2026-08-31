import { defineJob } from '../defineJob';

// THE DISPATCH-RUN HOUSEKEEPING TICK (Story MOTIR-1789 · MOTIR-1792) — the clock
// behind the two obligations `docs/decisions/dispatch-run-record.md` Q4.2
// assigns to this card: the 30-day log-body retention window, and the
// abandoned-run reap.
//
// The policy is all in `dispatchRunSweepService` — the cross-tenant discovery
// under `withSystemContext`, the per-workspace write, the per-run failure that
// is counted rather than thrown. This file is the schedule and nothing else, the
// same split `planTargetLockSweep` and `accountErasureSweep` make.
//
// ⚠️ ONE JOB FOR TWO SWEEPS, and that is a decision rather than tidiness. They
// share a cadence (nightly is right for both), a tenancy shape (discover across,
// write within) and a subject (the dispatch-run record). Two jobs would be two
// wake minutes on a compute that suspends when idle, for work that takes
// milliseconds — and `SCHEDULE_CLUSTER_MINUTES` exists precisely to stop that.
//
// `retryPolicy: 'idempotent'`: both halves converge on re-run by construction. A
// cleared body no longer matches `body IS NOT NULL`, and a closed run no longer
// matches `status = 'running'` — so a second pass finds strictly less than the
// first and a pass that finds nothing does nothing.

/**
 * 06:30 every day — a clustered minute (`lib/jobs/schedules.ts`'s
 * `SCHEDULE_CLUSTER_MINUTES`, so it opens no new wake-minute and the quiet gap
 * is untouched), at the TAIL of the nightly cascade: 03:00
 * `system.account-erasure-sweep` → 03:30 `system.attachment-gc` → 04:00
 * `system.rate-limit-sweep` → 04:30 `system.automation-retention-sweep` → 05:00
 * `system.code-graph-offboard-sweep` → 05:30 `system.data-export-expiry-sweep`
 * → 06:00 `system.job-run-reap` → 06:30 here.
 *
 * ⚠️ DAILY, AND THE REAP IS WHAT DECIDES THAT — not the retention half. A body
 * one day past its window is a retention window of 31 days, which nobody will
 * notice and no promise breaks over. A run that died at 09:00 reading `running`
 * until the next tick is a run page that says *working* for up to a day, which
 * is exactly the wrong answer at exactly the moment somebody goes looking.
 *
 * The reason it is daily ANYWAY is that the reap's own threshold already
 * dominates that wait: a run is not abandoned until it has been `running` for
 * twelve hours (`DISPATCH_RUN_ABANDON_AFTER_HOURS`), so the worst case is
 * 12h + 24h either way and a tighter cadence would buy a fraction of it for a
 * new wake-minute. If that trade is ever revisited, revisit the THRESHOLD
 * first — it is the larger term and it costs nothing.
 */
export const DISPATCH_RUN_SWEEP_CRON = '30 6 * * *';

export const dispatchRunSweep = defineJob(
  {
    id: 'system.dispatch-run-sweep',
    cron: DISPATCH_RUN_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // The summary IS the return value, persisted on the run's `job_run` ledger
    // row — and it is the only durable record of a reap that failed on one run,
    // since a per-run failure is counted rather than thrown.
    return ctx.step.run('sweep-dispatch-runs', () => services.dispatchRunSweep.sweep());
  },
);
