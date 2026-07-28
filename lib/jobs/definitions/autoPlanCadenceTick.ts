import { defineJob } from '../defineJob';

// Auto-plan CADENCE tick (Story 7.13 · MOTIR-916) — the scheduled trigger that
// promotes MOTIR-904's human-facing "your ready set is draining, expand a stub"
// nudge into an opt-in AUTO-expand. Each tick sweeps every project with
// `aiAutoPlanEnabled = true` and, for the ones whose ready set has drained below
// their `aiAutoPlanThreshold`, submits ONE shipped 7.4 `expand_item` job.
//
// Nothing is written to the work-item tree: the run's output lands as `Plan` +
// `PlanItem` proposal rows and a real work item appears only when a human
// approves. The tick starts a job; it does not plan.
//
// `retryPolicy: 'idempotent'`: the sweep is a pure recompute-from-live-state —
// every gate (the pending-proposal check, the ready count, the stub nomination)
// is re-derived on each run, and a project that already fired now HAS an
// undecided plan, so the gate skips it on the re-run. Re-running the whole
// sweep therefore converges rather than double-firing, which makes Inngest's
// full 5-attempt budget safe against a transient DB blip. (The per-project
// try/catch means a motir-ai outage for one tenant resolves the run
// SUCCESSFULLY with a `failed` entry in the summary, rather than burning
// retries re-sweeping every other tenant.)
//
// System-scoped (cross-workspace): the "which projects opted in?" scan runs
// under withSystemContext inside the service (the project policy's system-admin
// READ branch, added by this story's migration); everything after it runs per
// project in that project's workspace context, as its workspace owner. The
// ledger row is untenanted, like every `system.*` job. The handler stays tiny —
// one durable step returning the { scanned, fired, skipped, failed } summary.
//
// Hourly, at :20 — clear of the filter-subscription tick (:00), the 09:00 health
// check, and the 03:30 attachment GC, so a busy top-of-hour never stacks the
// sweep behind them. Hourly is the right grain because the input it reacts to
// (the ready set draining as work completes) moves on a human timescale, and a
// project only ever fires once per undecided plan anyway.
export const AUTO_PLAN_CADENCE_TICK_CRON = '20 * * * *';

export const autoPlanCadenceTick = defineJob(
  {
    id: 'system.auto-plan-cadence-tick',
    cron: AUTO_PLAN_CADENCE_TICK_CRON,
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('sweep-auto-plan-projects', () =>
      services.autoPlanCadence.runCadenceSweep(),
    );
  },
);
