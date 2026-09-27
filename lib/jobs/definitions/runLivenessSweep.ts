import { defineJob } from '../defineJob';

// THE RUN-LIVENESS SWEEP (Story MOTIR-6526 · MOTIR-6528) — a thin caller over
// `dispatchRunSweepService.reapLapsed`, which carries the argument: a LOCAL run
// whose heartbeat has lapsed is closed `abandoned`, and its card is never touched
// (`docs/decisions/run-death-keeps-work.md` §2).
//
// ⚠️ NOT THE VERDICT. `isRunAlive` (`lib/runs/runLiveness.ts`) reads the run as
// dead at read time, within seconds of the 5-minute lapse, so the *run died*
// marker and the continue claim wait on nothing here. This makes the RECORD say
// so. That is why it can sit on the 30-minute cluster.
//
// A SEPARATE JOB from `system.dispatch-run-sweep`, deliberately: that one is
// daily because its reap's own 12-hour threshold dominates the wait; this one's
// threshold is five minutes, and a daily tick would leave a dead run's page
// reading `running` for up to a day.

/**
 * Every 30 minutes, ON the cluster (`SCHEDULE_CLUSTER_MINUTES`, `[0, 30]`), so it
 * opens no new wake-minute.
 *
 *   worst case before the ROW says abandoned
 *     = the 5-minute lapse + the gap to the next tick (≤ 30 min)
 *     = 35 minutes
 *
 * and nothing a person sees waits on it — the marker reads the rule.
 */
export const RUN_LIVENESS_SWEEP_CRON = '0,30 * * * *';

export const runLivenessSweep = defineJob(
  {
    id: 'system.run-liveness-sweep',
    cron: RUN_LIVENESS_SWEEP_CRON,
    /**
     * `latest` — what does waiting for the next fire cost? Only a run page saying
     * `running` for a run that has died. One pass covers every missed fire,
     * because the candidate set is defined by ELAPSED TIME
     * (`last_heartbeat_at < now − 5 min`), not by the fire instant.
     */
    catchUp: 'latest',
    /**
     * `idempotent`: a closed run stops matching `status = 'running'`, and the
     * close is a locked compare-and-set, so a retried pass closes nothing twice.
     */
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('reap-lapsed-runs', () => services.dispatchRunSweep.reapLapsed());
  },
);
