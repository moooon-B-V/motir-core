import { defineJob } from '../defineJob';

// ABANDONED-PLAN sweep (MOTIR-3064) — the reconciler that gives a dead
// generation job's plan a terminal status, so it stops reading as a proposal
// somebody owes a decision on.
//
// WHY A CRON AND NOT AN EVENT. Every other plan transition is driven by a product
// event: a producer appends, a person approves, a person declines. None of them
// fire for the failure this recovers. motir-ai's inbound seams into core are the
// success path, so a job that fails writes nothing here; and a motir-ai worker
// that dies mid-job writes nothing ANYWHERE — its own row stays `running`. The
// only thing left is to go and ask, which is what this does.
//
// The harm it undoes is quiet and permanent: `planRepository.findUndecidedByProject`
// reads `generating` as UNDECIDED, that read is the pending-proposal gate
// `autoPlanCadenceService` checks first, so one abandoned plan pauses that
// project's auto-planning for good — and the settings page reports it as a
// proposal waiting for a decision nobody can make.
//
// System-scoped (cross-workspace): the discovery read runs under
// `withSystemContext` against the plan policy's `FOR SELECT` `app.system_admin`
// arm; each write re-binds to that plan's own workspace, so nothing untenanted is
// ever written. The ledger row is untenanted, like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: the pass is a pure recompute from live state — a
// reconciled plan is no longer `generating` so it stops matching, an in-flight
// one is re-asked and left alone again, and a pass that finds nothing stops.
// Bounded per run (`ABANDONED_PLAN_SWEEP_BATCH_SIZE`).

/**
 * Hourly at :00 — thirty minutes before `autoPlanCadenceTick` (`30 * * * *`).
 *
 * The ORDER is the reason for the number, and it is UNCHANGED (MOTIR-3314). This
 * sweep's only consumer is the cadence gate, so reconciling before it means a
 * plan freed this hour unpauses that project's planning in the SAME hour's tick
 * rather than the next one. Hourly is the right grain for the same reason the
 * cadence tick is: what it unblocks moves on a human timescale, and the cost of a
 * pass that finds nothing is one indexed read.
 *
 * WHAT THE RE-TIMING GAVE UP: nothing. The pair moved :10/:20 → :00/:30, which
 * preserves the ordering and WIDENS the sweep→tick lead from ten minutes to
 * thirty. What it bought is two shared wake-minutes instead of two private ones
 * (`lib/jobs/schedules.ts`, the cluster invariant).
 */
export const ABANDONED_PLAN_SWEEP_CRON = '0 * * * *';

export const abandonedPlanSweep = defineJob(
  {
    id: 'system.abandoned-plan-sweep',
    cron: ABANDONED_PLAN_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('reconcile-abandoned-plans', () =>
      services.abandonedPlan.reconcileAbandoned(),
    );
  },
);
