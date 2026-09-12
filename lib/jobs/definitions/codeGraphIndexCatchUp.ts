import { defineJob } from '../defineJob';

/**
 * THE INDEX CATCH-UP SWEEP (MOTIR-5290 · Story MOTIR-4335) — re-asks the internal
 * index allowance for repositories MOTIR-4593 paused, and resumes indexing where
 * it may. See `codeGraphIndexCatchUpService` for why this is a pull.
 *
 * ⚠️ THE MINUTE IS NOT FREE TO PICK. `lib/jobs/schedules.ts` clusters every
 * `system.*` cron onto minutes 0 and 30 so the database can suspend between them;
 * this takes both, like the drift sweep, and costs no new wake. Thirty minutes is
 * the latency between a top-up and the index resuming.
 */
export const CODE_GRAPH_INDEX_CATCH_UP_CRON = '0,30 * * * *';

export const codeGraphIndexCatchUp = defineJob(
  {
    id: 'system.code-graph-index-catch-up',
    cron: CODE_GRAPH_INDEX_CATCH_UP_CRON,
    // A missed tick is not work to replay: the next pass selects from the current
    // pauses and asks the current allowance.
    catchUp: 'latest',
    // Each pass is a recompute from live state; a retried pass asks again and
    // enqueues what the refresh job's debounce coalesces.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('catch-up-paused-indexes', () => services.codeGraphIndexCatchUp.catchUp());
  },
);
