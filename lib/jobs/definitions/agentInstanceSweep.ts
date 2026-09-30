import { defineJob } from '../defineJob';

// THE AGENT-INSTANCE SWEEP (Story MOTIR-6860 · MOTIR-6873) — a thin caller over
// `agentInstanceSweepService.sweep`, whose header carries the argument. The
// latency-critical half (the idle window) rides the per-instance
// `agent-instance/idle-check` timer instead. `docs/decisions/agent-instances.md` §2
// names a 5-minute sweep, which is what this runs since MOTIR-6932 retired the
// :00/:30 cluster (AMENDMENT 1 had moved it to 30 minutes for that cluster).

/**
 * Every 5 minutes — the sub-hourly cadence every `system.*` job shares
 * (`tests/jobs/schedule-cadence.test.ts`).
 */
export const AGENT_INSTANCE_SWEEP_CRON = '*/5 * * * *';

export const agentInstanceSweep = defineJob(
  {
    id: 'system.agent-instance-sweep',
    cron: AGENT_INSTANCE_SWEEP_CRON,
    /**
     * `latest` — one pass covers every missed fire: each candidate is chosen by
     * state and elapsed time (quiet for 30 minutes, an interval 12 hours old, a
     * closed interval still pending), never by the fire instant.
     */
    catchUp: 'latest',
    /**
     * `idempotent`: every write is a guarded compare-and-set, and a charge is
     * keyed on its interval, so a retried pass settles and charges nothing twice.
     */
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const summary = await ctx.step.run('sweep-agent-instances', () =>
      services.agentInstanceSweep.sweep(),
    );
    // agent-terminal.md Q3 (MOTIR-6940): the terminal tickets past their 60-second
    // life, deleted here rather than on a cron minute of their own (the substrate
    // refuses any minute off the cluster). Its own step, so the instance summary's
    // memoized shape is unchanged.
    await ctx.step.run('sweep-agent-terminal-tickets', () =>
      services.agentTerminalRelay.sweepExpiredTickets(),
    );
    // MOTIR-6959: the terminal connections a relay stopped vouching for — it was
    // killed without shutting down — closed `relay_lost` at their last heartbeat.
    // On this 30-minute cadence a lost row closes within ~35 minutes; its
    // recorded `closedAt` is the heartbeat, not the sweep, so the lag never
    // inflates a duration. Its own step, for the same memoized-shape reason.
    await ctx.step.run('sweep-lost-terminal-connections', () =>
      services.agentTerminalRelay.sweepLostConnections(),
    );
    return summary;
  },
);
