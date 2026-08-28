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
 * Every 30 minutes, ON the cluster (`SCHEDULE_CLUSTER_MINUTES`, `[0, 30]`).
 *
 * ⚠️ THE MINUTE IS NOT FREE, AND THAT IS WHY THIS ONE IS NOT ITS OWN
 * (MOTIR-3314). On a compute that suspends when idle the billed quantity is how
 * often ANYTHING wakes, so a new distinct offset is a new wake, forever —
 * measured at $19.50/mo for a compute that never sleeps. A new scheduled job
 * that picks a "free-looking" minute is the exact reasoning the cluster guard
 * exists to stop, and `tests/jobs/schedule-cluster.test.ts` fails with this
 * job's name if it does.
 *
 * THE ARITHMETIC THIS CADENCE HAS TO SATISFY, stated rather than asserted:
 *
 *   worst case before a stalled container is torn down
 *     = the 15-minute grace window + the gap to the next tick (≤ 30 min)
 *     = 45 minutes
 *
 * against the 70-minute fleet reaper it exists to pre-empt. Twenty-five minutes
 * of headroom, and the container is metered and its slot released — which the
 * reaper's path does for neither. A tighter cadence would buy minutes of
 * container in a rare failure and cost a wake every time, for ever.
 */
export const SUPERVISION_SWEEP_CRON = '0,30 * * * *';

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
