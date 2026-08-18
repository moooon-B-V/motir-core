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
// job died sits at `generating` forever and NOTHING downstream ever learns the
// session is over. The only signal left is the passage of time, which is what
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
 * Every 10 minutes.
 *
 * FAR more often than the daily housekeeping sweeps beside it, and deliberately:
 * those reclaim space, and this one unblocks a person who is trying to work. The
 * cost of the cadence is one indexed read of `(expires_at)` that returns nothing
 * almost every time; the cost of running it daily would be telling someone their
 * epic is unplannable until tomorrow. The 30-minute lease dominates the total
 * wait either way — this only decides how much is added to it.
 */
export const PLAN_TARGET_LOCK_SWEEP_CRON = '*/10 * * * *';

export const planTargetLockSweep = defineJob(
  {
    id: 'system.plan-target-lock-sweep',
    cron: PLAN_TARGET_LOCK_SWEEP_CRON,
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('release-expired-planning-locks', () =>
      services.planTargetLock.releaseExpired(),
    );
  },
);
