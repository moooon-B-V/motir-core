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
 * Daily, at 04:10 UTC.
 *
 * ⚠️ THE CADENCE IS CHOSEN AGAINST THE SCHEDULE AS A WHOLE, not against this
 * job's own urgency (the clustering argument in `planTargetLockSweep`): the
 * longest quiet gap the cluster can ever have is bounded by its TIGHTEST cadence,
 * so a new frequent cron re-prices the whole always-awake compute bill. Daily is
 * right here on the merits anyway — what this recovers is a row that has ALREADY
 * been wrong for at least six hours, and nothing downstream is waiting on it. It
 * joins the daily housekeeping band rather than opening a new one.
 *
 * `catchUp: 'skip'`: a fire the worker was down across is worth nothing to
 * re-run. The candidate set is defined by elapsed time, so the next fire sees
 * everything the missed one would have, plus whatever accrued since. Running the
 * stale tick as well would do the same work twice.
 */
export const JOB_RUN_REAP_CRON = '10 4 * * *';

export const jobRunReap = defineJob(
  {
    id: 'system.job-run-reap',
    cron: JOB_RUN_REAP_CRON,
    catchUp: 'skip',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('reap-abandoned-job-runs', () => services.jobRuns.reapAbandoned());
  },
);
