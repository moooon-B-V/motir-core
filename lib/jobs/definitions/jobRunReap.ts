import { defineJob } from '../defineJob';

// THE ABANDONED-RUN REAP (Bug MOTIR-3683) — the standing guarantee that no
// `job_run` row says `running` for ever.
//
// WHY IT EXISTS ALONGSIDE THE CAUSE-FIX, rather than instead of it. The defect
// that stranded 29 runs on this ledger was one lane deriving `event_id` two
// different ways, and that is repaired at the two lines where it happened. This
// job answers the CLASS instead of the instance: the completion write is a
// WRITE, and a write can be lost — SIGKILL, a machine replaced mid-run, a
// misconfigured lane, a future engine path nobody has thought of. Every one of
// those leaves a row saying `running`.
//
// And `running` is the worst available lie. A `failed` row invites a question; a
// `running` row answers one. The ledger showed a job that died 25 days earlier as
// in-flight, and that is how a daily failure went unnoticed for three weeks.
//
// The rule the sweep applies — a live queue row vetoes the reap outright, and
// elapsed time is the only signal an Inngest-lane row has — lives with the
// service (`jobRunsService.reapAbandoned`), because it is the part a reader needs
// when they are asking why a particular run was or was not closed.
//
// `retryPolicy: 'idempotent'`: the sweep converges by construction. A row it
// closes stops matching `status = 'running'`, and a pass that finds nothing stops.
// Bounded per run (`JOB_RUN_REAP_BATCH_SIZE`), so a long-neglected ledger drains
// over several passes rather than holding one transaction across the backlog.

/**
 * Daily, at 06:00 UTC.
 *
 * ⚠️ THE MINUTE IS NOT A FREE CHOICE — `:00` or `:30`, and nothing else
 * (`SCHEDULE_CLUSTER_MINUTES`). Motir's Postgres suspends when idle and bills by
 * how often it WAKES, and every tick of every scheduled job is a guaranteed
 * write, so the bill is a property of the SET of schedules and no single job's
 * comment can defend it. `tests/jobs/schedule-cluster.test.ts` asserts the
 * resulting quiet gap; the measurement it is priced against is
 * `docs/decisions/application-hosting.md` §21.
 *
 * **This job picked `:10` first, for the load-spreading reason that is correct on
 * an always-on machine and wrong here, and the guard caught it.** Separation
 * between the daily sweeps is bought by the HOUR instead — 06:00 shares its cold
 * start with nothing, sits after the 03:30–05:00 housekeeping band, and lands
 * before the 09:00 health check, so an operator reading that report sees a ledger
 * the reap has already been over.
 *
 * Daily is right on the merits too: what this recovers has ALREADY been wrong for
 * at least six hours and nothing downstream is waiting on it.
 *
 * `catchUp: 'latest'` (§11.4): a missed fire still owes its work. The candidate
 * set is defined by elapsed time, so ONE pass sees everything every missed pass
 * would have — and what waiting for the next scheduled fire costs is another day
 * of the operator surface showing a dead run as `running`, which is the precise
 * harm this job exists to end. Replaying is free because the sweep converges: a
 * closed row stops matching `status = 'running'`.
 */
export const JOB_RUN_REAP_CRON = '0 6 * * *';

export const jobRunReap = defineJob(
  {
    id: 'system.job-run-reap',
    cron: JOB_RUN_REAP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('reap-abandoned-job-runs', () => services.jobRuns.reapAbandoned());
  },
);
