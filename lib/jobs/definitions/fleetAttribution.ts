import { defineJob } from '../defineJob';

/**
 * THE ATTRIBUTION RECONCILER'S SCHEDULE (Story MOTIR-6906 · MOTIR-6925) —
 * `docs/decisions/fleet-per-org-pool.md` §5.
 *
 * Every five minutes: list every machine the provider runs in the fleet
 * organisation, and kill whatever no paying organisation's live record owns
 * (`fleetAttributionService.reconcile`). It REPLACED `system.ci-runner-reap`'s
 * schedule (§6), so it also carries that job's other half, the sweep of intents
 * claimed but never booted.
 *
 * ⚠️ NEVER GATED ON ACTIVITY. A leak exists precisely when nothing in Motir is
 * running, so this is a cron over the provider, not a hook on a boot.
 *
 * ⚠️ THE CADENCE. With the 10-minute grace a leaked machine lives at most
 * grace + cadence = 15 minutes. Five lands on MOTIR-6893's default sub-hourly
 * cadence, so it needs no exception entry (§5, "Why 5 and not finer").
 */
export const FLEET_ATTRIBUTION_CRON = '*/5 * * * *';

export const fleetAttribution = defineJob(
  {
    id: 'system.fleet-attribution',
    cron: FLEET_ATTRIBUTION_CRON,
    // `latest`: a pass reads the CURRENT inventory, so one pass after an outage
    // does everything the missed ones would have — and every minute a leak
    // survives bills, so it runs as soon as the worker is back.
    catchUp: 'latest',
    // `idempotent`: a destroy of a destroyed machine is a no-op at the provider,
    // and a retried pass re-decides from the inventory rather than replaying.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const reconciled = await ctx.step.run('reconcile-fleet-attribution', () =>
      services.fleetAttribution.reconcile(),
    );
    const staleClaims = await ctx.step.run('sweep-stale-claims', () =>
      services.ciRunnerBoot.sweepStaleClaims(),
    );
    return { reconciled, staleClaims };
  },
);
