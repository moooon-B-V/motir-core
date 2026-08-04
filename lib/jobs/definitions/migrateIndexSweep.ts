import { defineJob } from '../defineJob';

// Migrate-onboarding INDEX SWEEP (MOTIR-2082) — the cron that re-evaluates the
// `index` step's exit condition for runs nobody is watching.
//
// A migrate run's steps only advance when something CALLS a transition, and the
// only callers are the wizard client and its `index-status` poll — both in the
// browser. The index step is the slow one (waiting on it is why the wizard
// exists), so a user who closes the tab before it finishes leaves the run
// `active` at `index` forever: the exit condition flips true later and nobody is
// listening. This lane is the listener.
//
// A completion hook on `system.code-graph-index` would NOT be equivalent — it
// fires only when a NEW index succeeds, so it could never heal a run whose index
// already succeeded, which is the whole motivating population. The sweep
// re-derives from durable state, so it repairs runs wedged before it shipped.
//
// `retryPolicy: 'idempotent'`: the tick is a re-runnable scan whose only write is
// a step hop guarded by a row lock + a re-assert of the step under it — a second
// pass over an already-advanced run finds it at `import` and no-ops. So the full
// retry budget is safe on a transient DB blip (unlike the health check's
// point-in-time 'none').
//
// System-scoped (cross-workspace): the discovery scan runs under
// withSystemContext inside the service (the migrate_onboarding policy's
// system-admin branch); each commit runs under that run's own
// withWorkspaceServiceContext. The ledger row is untenanted, like every
// `system.*` job. The handler stays tiny — one durable step returning the
// { scanned, advanced, failed } summary for the run ledger.

/** Every 15 minutes — the index is minutes-scale, so a wedged run is repaired
 *  well within the window a returning user would notice, while staying clear of
 *  the top-of-hour ticks. */
export const MIGRATE_INDEX_SWEEP_CRON = '7,22,37,52 * * * *';

export const migrateIndexSweep = defineJob(
  {
    id: 'system.migrate-index-sweep',
    cron: MIGRATE_INDEX_SWEEP_CRON,
    retryPolicy: 'idempotent',
  },
  (ctx, services) =>
    ctx.step.run('advance-wedged-index-runs', () => services.migrateOnboarding.runIndexSweep()),
);
