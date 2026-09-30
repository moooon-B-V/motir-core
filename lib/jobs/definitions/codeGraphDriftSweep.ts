import { defineJob } from '../defineJob';

/**
 * THE DRIFT RECOMPUTE SWEEP (Story MOTIR-1754 · MOTIR-4644).
 *
 * ⚠️ A SWEEP RATHER THAN A REACTION, and the choice is about the RATE LIMIT, not
 * about latency. The obvious design is to recount on every push webhook — the
 * event that moves one half of the pair. But a busy repository pushes many times
 * a minute, each push would cost a provider round-trip, and GitLab.com
 * rate-limits some endpoints at 5 requests/minute: the repositories that drift
 * fastest would be exactly the ones whose counts stopped being taken. A sweep
 * with a per-tick ceiling gives every repository the same bounded service and
 * cannot be driven by the outside world.
 *
 * ⚠️ WHAT THAT COSTS, STATED: a count can be up to one cadence out of date. It is
 * a bounded, honest error — the number is always a real count of a real pair,
 * and the pair it belongs to is stored with it, so a read that finds the pair
 * moved reports `null` rather than the old number. Never a wrong count; at worst
 * an absent one.
 *
 * Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 * `lib/jobs/schedules.ts`); a different one would have to be named in
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` with its reason.
 */
export const CODE_GRAPH_DRIFT_SWEEP_CRON = '*/5 * * * *';

export const codeGraphDriftSweep = defineJob(
  {
    id: 'system.code-graph-drift-sweep',
    cron: CODE_GRAPH_DRIFT_SWEEP_CRON,
    // `latest` rather than `all`: a missed tick is not work to replay. The next
    // run selects from the CURRENT state of the estate, so catching up on three
    // skipped ticks would re-select the same rows three times.
    catchUp: 'latest',
    // Every write is conditional on the pair it was computed for, so a retried
    // tick either writes the same number again or writes nothing.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('recompute-code-graph-drift', () =>
      services.codeGraphDrift.recomputeDrift(),
    );
  },
);
