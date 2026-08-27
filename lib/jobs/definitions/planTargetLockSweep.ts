import { defineJob } from '../defineJob';

// Planning-target lease sweep (Story MOTIR-2786 · MOTIR-2787) — the RECOVERY
// half of the `planning` status lock, scheduled on the 1.6 cron primitive like
// `rateLimitSweep`.
//
// WHY IT IS THE PRIMARY RECOVERY PATH AND NOT A BACKSTOP. Every other release is
// driven by a product event: a plan is approved, a plan is declined. None of
// those fire for the failures that actually strand a lock — a planner that
// crashes, a machine that vanishes mid-job (MOTIR-2783 shows a `running` job row
// whose machine is gone is never re-claimed), a redeploy, a user who closes the
// tab and never comes back. `PlanStatus` has no `failed` member, so a plan whose
// job died sits at `generating` until something goes and asks — which
// MOTIR-3064's abandoned-plan sweep now does, hourly, and only for a plan with no
// proposals in it. That does not make this one a backstop: it reconciles the
// PLAN, on a cadence set by the pause it lifts, while a stranded lease holds an
// item NOBODY can plan and has to come back in minutes whatever the plan row
// says. The only signal left HERE is still the passage of time, which is what
// this reads.
//
// And the failure it recovers is the one the story calls worse than the race the
// lock prevents: a race produces a confusing tree a person can repair; a lock
// that is never released produces an item NOBODY can plan again, with no
// user-facing remedy — discovered by a customer rather than by us.
//
// System-scoped: expired leases span workspaces, so the discovery read runs under
// `withSystemContext` (the table carries a `FOR SELECT` `app.system_admin` arm
// for exactly this) and each release then re-binds to that row's own workspace,
// so no write is ever untenanted.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction — a
// released lease stops matching `expires_at <= now`, and a pass that finds
// nothing stops. Bounded per run (`PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE`), so a
// backlog drains over several passes rather than holding locks across a large
// slice of the table in one.

/**
 * Every 30 minutes, ON the cluster.
 *
 * FAR more often than the daily housekeeping sweeps beside it, and deliberately:
 * those reclaim space, and this one unblocks a person who is trying to work. The
 * cost of the cadence is one indexed read of `(expires_at)` that returns nothing
 * almost every time; the cost of running it daily would be telling someone their
 * epic is unplannable until tomorrow.
 *
 * ⚠️ THIS IS THE SHARPEST TRADE THE CLUSTERING MAKES (MOTIR-3314), and it is
 * named here rather than averaged into a total. A ten-minute cadence was chosen against exactly
 * the cost this cadence increases, so the honest statement is the arithmetic:
 *
 *   worst-case wait for a stranded lease  =  the 30-minute LEASE + the sweep gap
 *     before:  30 + 10  =  40 min      after:  30 + 30  =  60 min
 *
 * The sentence that stood here — "the 30-minute lease dominates the total wait
 * either way, this only decides how much is added to it" — was true at ten minutes
 * and is exactly half true now: the added term equals the lease instead of being
 * a third of it. WHAT IT BOUGHT: ten minutes was the single tightest cadence in the
 * whole `system.*` set, and the longest quiet gap can never exceed the tightest
 * cadence in the set — so at ten minutes NO arrangement of the other thirteen jobs
 * could have produced a gap over 10 minutes, against a suspend delay observed at
 * ~9. This job alone decided whether the compute could ever sleep.
 *
 * WHY IT IS ACCEPTED: what it recovers is a rare failure (a planner that crashed,
 * a machine that vanished mid-job, a closed tab), the remedy is automatic in both
 * cases, and 60 minutes is still far inside "not tomorrow". Against it stands a
 * measured $19.50/mo of always-awake Neon compute. If that judgement is ever
 * revisited, revisit it as a §21 decision — a shorter cadence HERE re-prices the
 * whole schedule, which is the thing this comment exists to say.
 */
export const PLAN_TARGET_LOCK_SWEEP_CRON = '0,30 * * * *';

export const planTargetLockSweep = defineJob(
  {
    id: 'system.plan-target-lock-sweep',
    cron: PLAN_TARGET_LOCK_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('release-expired-planning-locks', () =>
      services.planTargetLock.releaseExpired(),
    );
  },
);
