import { defineJob } from '../defineJob';

// THE RUN-LIVENESS SWEEP (Story MOTIR-6526 · MOTIR-6528) — a thin caller over
// `dispatchRunSweepService.reapLapsed`, which carries the argument: a LOCAL run
// whose heartbeat has lapsed is closed `abandoned`, and its card is never touched
// (`docs/decisions/run-death-keeps-work.md` §2).
//
// ⚠️ NOT THE VERDICT. `isRunAlive` (`lib/runs/runLiveness.ts`) reads the run as
// dead at read time, within seconds of the 5-minute lapse, so the *run died*
// marker and the continue claim wait on nothing here. This makes the RECORD say
// so. That is why its cadence is the ordinary sub-hourly one rather than finer.
//
// A SEPARATE JOB from `system.dispatch-run-sweep`, deliberately: that one is
// daily because its reap's own 12-hour threshold dominates the wait; this one's
// threshold is five minutes, and a daily tick would leave a dead run's page
// reading `running` for up to a day.

/**
 * Every 5 minutes — the cadence every sub-hourly `system.*` job runs at since the
 * database became always-on (MOTIR-6893, `docs/decisions/always-on-database-job-
 * cadence.md`; the invariant is `tests/jobs/schedule-cadence.test.ts`).
 *
 *   worst case before the ROW says abandoned
 *     = the 5-minute lapse + the gap to the next tick (≤ 5 min)
 *     = 10 minutes
 *
 * and nothing a person sees waits on it — the marker reads the rule.
 *
 * ⚠️ WITH ONE EXCEPTION SINCE MOTIR-6881: the Workbench To fix tab. Its `run_died`
 * reason is recomputed when a run CLOSES, and for a local run that went silent this
 * reap is the close — so that card reaches To fix up to 10 minutes after its last
 * heartbeat (every other death is immediate). It was 35 minutes while this cron
 * sat on the retired :00/:30 cluster (MOTIR-3314); MOTIR-6932 moved it to every 5 minutes.
 */
export const RUN_LIVENESS_SWEEP_CRON = '*/5 * * * *';

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
