import { defineJob } from '../defineJob';

// THE AGENT-INSTANCE SWEEP (Story MOTIR-6860 · MOTIR-6873) — a thin caller over
// `agentInstanceSweepService.sweep`, whose header carries the argument and the
// one deviation from `docs/decisions/agent-instances.md`: §2 names a 5-minute
// sweep, and this runs on the clustered 30-minute cadence the job substrate
// enforces, with the latency-critical half (the idle window) moved onto the
// per-instance `agent-instance/idle-check` timer.

/**
 * Every 30 minutes, ON the cluster (`SCHEDULE_CLUSTER_MINUTES`, `[0, 30]`), so it
 * opens no new wake-minute.
 */
export const AGENT_INSTANCE_SWEEP_CRON = '0,30 * * * *';

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
    return ctx.step.run('sweep-agent-instances', () => services.agentInstanceSweep.sweep());
  },
);
