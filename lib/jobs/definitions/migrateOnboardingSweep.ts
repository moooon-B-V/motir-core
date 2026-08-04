import { defineJob } from '../defineJob';

// The migrate-onboarding SWEEP LANE — the cron that re-derives a migrate run's
// state from durable signals, for the runs nobody is watching.
//
// THE SHAPE BOTH STEPS ANSWER. A migrate run's steps only advance when something
// CALLS a transition, and the only callers are the wizard client and its
// `index-status` poll — both in the browser. Every transition of this state
// machine is therefore observed only by an OPEN TAB. Close it and the run's
// progress simply stops being noticed: the signals still arrive, nothing is
// listening. This lane is the listener, and it does exactly two things.
//
//   1. TERMINAL RECONCILIATION (MOTIR-2092) — complete every `active` run whose
//      project is already established (`project.onboardingRanAt` stamped). That
//      marker is the second, independent writer of "onboarding is over" that the
//      run never reads: `plansService.approvePlan` stamps it in the approve's own
//      transaction and only THEN does the client land `review → done`, and the
//      dogfood seed / the MOTIR-1799 operator stamp write it with no wizard at
//      all. Either way the project is permanently established while its run is
//      permanently `active`.
//   2. INDEX REPAIR (MOTIR-2082) — advance a run parked at `index` whose
//      code-graph index has since succeeded in the job ledger. The index step is
//      the slow one (waiting on it is why the wizard exists), so it is where a
//      tab is most likely to be closed mid-journey.
//
// WHY ONE LANE AND NOT TWO. Both steps are the same tick over the same table,
// answering the same question from durable state, and their ORDER is load-bearing
// (below) — which a second cron on its own schedule could not guarantee.
//
// ORDER: RECONCILE FIRST. An orphaned run parked at `index` is in scope for both
// steps. Reconciling first completes it where the user actually stopped; running
// the index repair first would advance it to `import` and the reconciliation
// would then record a `reconciledFromStep` the user never reached. Once
// reconciled the run is no longer `active`, so the index repair's own filter
// skips it — no coordination beyond the ordering.
//
// WHY SWEEPS AND NOT COMPLETION HOOKS. A hook fires only when a NEW signal
// arrives, so it could never heal a run whose index already succeeded or whose
// marker was already stamped — which is the entire motivating population in both
// cases. Re-deriving from state repairs runs wedged before this lane shipped and
// is robust to a dropped hook, where a hook gets no second chance.
//
// `retryPolicy: 'idempotent'`: each tick is a re-runnable scan whose only writes
// are guarded by a row lock plus a re-assert of the step (and the run's `active`
// status) under it — a second pass over already-repaired state finds nothing to
// do and no-ops. So the full retry budget is safe on a transient DB blip (unlike
// the health check's point-in-time 'none').
//
// System-scoped (cross-workspace): each discovery scan runs under
// withSystemContext inside the service (the migrate_onboarding policy's
// system-admin branch, and project's own system READ branch); every commit runs
// under that run's own withWorkspaceServiceContext. The ledger row is untenanted,
// like every `system.*` job. The handler stays tiny — two durable steps, each
// returning its summary for the run ledger.

/** Every 15 minutes — the index is minutes-scale and the approve race resolves
 *  the moment the marker lands, so a wedged run is repaired well within the
 *  window a returning user would notice, while staying clear of the top-of-hour
 *  ticks. */
export const MIGRATE_ONBOARDING_SWEEP_CRON = '7,22,37,52 * * * *';

export const migrateOnboardingSweep = defineJob(
  {
    id: 'system.migrate-onboarding-sweep',
    cron: MIGRATE_ONBOARDING_SWEEP_CRON,
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // Reconcile BEFORE repairing — see the ORDER note above.
    const reconciled = await ctx.step.run('reconcile-established-runs', () =>
      services.migrateOnboarding.runTerminalReconciliation(),
    );
    const indexed = await ctx.step.run('advance-wedged-index-runs', () =>
      services.migrateOnboarding.runIndexSweep(),
    );
    return { reconciled, indexed };
  },
);
