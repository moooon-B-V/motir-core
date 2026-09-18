import { defineJob } from '../defineJob';

// THE OPEN-DELIVERY RECONCILE TICK (MOTIR-5390) — the clock behind
// `pullRequestReconcileService`, which re-reads open, delivering pull requests
// from GitHub and replays a close whose webhook delivery was lost.
//
// The policy is all in the service — the cross-tenant discovery, the per-tenant
// liveness read, the host read, the replay through the delivery path, the
// per-row failure that is counted rather than thrown. This file is the schedule
// and nothing else, the split `planTargetLockSweep` and `dispatchRunSweep` make.
//
// `retryPolicy: 'idempotent'`: a replayed close converges exactly as a
// redelivered one does (the sync's row lock and its `noop` on a card already in
// its target status), and a row it closed stops matching `state = 'open'`, so a
// second pass finds strictly less than the first.

/**
 * Every 30 minutes, ON the cluster (`lib/jobs/schedules.ts`'s
 * `SCHEDULE_CLUSTER_MINUTES`) — both clustered minutes, so it opens no new
 * wake-minute and the quiet gap is untouched.
 *
 * What it repairs is a card held at In Review by a merge Motir never heard about,
 * with nothing on the card to say so. Worst case for a lost merge is the
 * 10-minute quiet threshold plus the 30-minute gap: repaired inside the hour,
 * without anyone noticing it was stuck. A tighter cadence would re-price the whole
 * schedule (§21) to shave minutes off a failure that is rare by construction.
 */
export const PULL_REQUEST_RECONCILE_CRON = '0,30 * * * *';

export const pullRequestReconcile = defineJob(
  {
    id: 'system.pull-request-reconcile',
    cron: PULL_REQUEST_RECONCILE_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // The summary IS the return value, persisted on the run's `job_run` ledger
    // row — the durable record of a replay, and of a row that failed, since a
    // per-row failure is counted rather than thrown.
    // ⚠️ THE ID IS `-v2` BECAUSE THE RESULT SHAPE CHANGED (Story MOTIR-5652 ·
    // Subtask MOTIR-5671): the summary gained `gatesRaised`. A memo written under
    // the old id carries the narrower shape, and a run resuming across this deploy
    // would replay it into a reader that expects the field. The step is a READ and
    // an idempotent repair — `reconcileGatesFor` only raises what is missing — so
    // re-executing it under the new id on a resumed run is safe, which is what
    // makes the bump the right answer rather than a boundary guard.
    return ctx.step.run('reconcile-open-deliveries-v2', () =>
      services.pullRequestReconcile.reconcileOpenDeliveries(),
    );
  },
);
