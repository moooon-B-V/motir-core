import { defineJob } from '../defineJob';

// THE ABANDONED-SUPERVISION SWEEP (Story MOTIR-3778 · Subtask MOTIR-3830) — a
// thin caller over `supervisionSweepService`, which carries the whole argument.
//
// Short version: a supervision is a chain of passes now, and a chain can stop.
// The only backstop left is the fleet reaper at 70 minutes, whose resolver is
// CI-intent-shaped and therefore destroys an index container with no
// attributable intent, no usage row and no slot release. This sweep reads
// Motir's own `job_supervision` rows and takes the terminal transition the chain
// would have taken.
//
// It does NOT replace the reaper. The reaper reads the PROVIDER and is the last
// line for a container Motir has no row for at all; this reads Motir's rows and
// is the first. Neither is touched by the other.

/**
 * Every 5 minutes — the cadence every sub-hourly `system.*` job runs at since the
 * database became always-on (MOTIR-6893, `docs/decisions/always-on-database-job-
 * cadence.md`). It sat on the retired :00/:30 cluster (MOTIR-3314) until
 * MOTIR-6932; the invariant is now `tests/jobs/schedule-cadence.test.ts`.
 *
 * THE ARITHMETIC THIS CADENCE HAS TO SATISFY, stated rather than asserted:
 *
 *   worst case before a stalled container is torn down
 *     = the 15-minute grace window + the gap to the next tick (≤ 5 min)
 *     = 20 minutes
 *
 * against the 70-minute fleet reaper it exists to pre-empt. Fifty minutes of
 * headroom, and the container is metered and its slot released — which the
 * reaper's path does for neither.
 */
export const SUPERVISION_SWEEP_CRON = '*/5 * * * *';

export const supervisionSweep = defineJob(
  {
    id: 'system.supervision-sweep',
    cron: SUPERVISION_SWEEP_CRON,
    /**
     * `latest` — §11.3's discriminator answered out loud: what does waiting for
     * the NEXT fire cost?
     *
     * MONEY, per minute. A stalled supervision is a container that is still
     * billing, so an outage that swallowed six fires has left six chains running
     * and the immediate sweep on restart reclaims spend the next fire would not
     * — the same argument `system.ci-runner-reap` makes in §11.4, and this job
     * is its Motir-side twin. One pass suffices because the candidate set is
     * defined by ELAPSED TIME (`next_poll_at < now − grace`) rather than by the
     * fire instant, so a single run sees everything every missed run would have;
     * and replaying is free, because a settled supervision stops matching
     * `state = 'watching'`.
     *
     * Not `all`, for the reason §11.5 gives about every sweep here: N fires would
     * each recompute the same answer.
     */
    catchUp: 'latest',
    /**
     * `idempotent`: the sweep converges by construction. A settled supervision
     * stops matching `state = 'watching'`, and the `watching → settling` claim is
     * a locked compare-and-set, so a retried pass settles nothing twice.
     */
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-abandoned-supervisions', () =>
      services.supervisionSweep.sweepAbandoned(),
    );
  },
);
