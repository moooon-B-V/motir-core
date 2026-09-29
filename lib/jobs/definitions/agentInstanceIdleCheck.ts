import { defineJob } from '../defineJob';
import type { AgentInstanceIdleCheckData } from '../types';

// THE AGENT-INSTANCE IDLE TIMER (Story MOTIR-6860 · MOTIR-6873;
// `docs/decisions/agent-instances.md` §2) — one timer per instance, and the
// reason the 30-minute idle window does not wait on a sweep.
//
// `agentInstanceLifecycleService` sends `agent-instance/idle-check` when an
// instance starts running and on every activity bump. DEBOUNCED per instance:
// each new event restarts the `period`, so the run lands once the instance has
// been quiet for 30 minutes and asks `checkIdle`, which hibernates it — or does
// nothing, when a bump arrived that the debounce has not yet seen.
//
// `timeout: '12h'` is the §2 backstop expressed as the debounce's cap: an
// instance that stays busy forever still gets its interval checked at twelve
// hours, and `checkIdle` hibernates it `backstop`. `system.agent-instance-sweep`
// is the net under both, for a timer the engine lost.
//
// ⚠️ THE KEY NAMES ONLY A REQUIRED FIELD. A key that does not resolve merges every
// event into ONE bucket (`codeGraphRefresh.ts`), which here would let one busy
// instance hold every other instance's idle check off.
export const agentInstanceIdleCheck = defineJob(
  {
    id: 'agent-instance/idle-check',
    /** `idempotent`: `checkIdle` is a guarded compare-and-set on the instance's state. */
    retryPolicy: 'idempotent',
    debounce: {
      key: 'event.data.instanceId',
      period: '30m',
      timeout: '12h',
    },
  },
  async (ctx, services) => {
    const data = ctx.event.data as AgentInstanceIdleCheckData;
    return ctx.step.run('check-instance-idle', () =>
      services.agentInstanceSweep.checkIdle(data.instanceId),
    );
  },
);
