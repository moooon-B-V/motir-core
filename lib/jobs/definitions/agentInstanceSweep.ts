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
    return ctx.step.run('sweep-agent-instances', () => services.agentInstanceSweep.sweep());
  },
);
