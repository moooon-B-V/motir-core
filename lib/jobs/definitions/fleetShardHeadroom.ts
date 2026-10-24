import { defineJob } from '../defineJob';

/**
 * THE HEADROOM PASS'S SCHEDULE (Story MOTIR-8953 · MOTIR-8969).
 *
 * Every minute: each fleet account, GitHub org and fleet kind against 70% of its
 * limits (`fleetShardHeadroomService.run`), one Sentry alert per (subject, limit).
 *
 * ⚠️ EVERY MINUTE, NOT EVERY FIVE. A 5-minute registration window must be read
 * inside its own window, so a pass every five minutes could miss a burst that
 * rose and fell between two passes.
 */
export const FLEET_SHARD_HEADROOM_CRON = '* * * * *';

export const fleetShardHeadroom = defineJob(
  {
    id: 'system.fleet-shard-headroom',
    cron: FLEET_SHARD_HEADROOM_CRON,
    // `latest`: a pass reads the CURRENT state, so a missed one is not work to
    // replay — the next one alerts on whatever is still over.
    catchUp: 'latest',
    // `idempotent`: it writes nothing but a prune, and a retried capture adds an
    // event to the same fingerprinted issue rather than opening a new one.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('fleet-shard-headroom', () => services.fleetShardHeadroom.run(new Date()));
  },
);
