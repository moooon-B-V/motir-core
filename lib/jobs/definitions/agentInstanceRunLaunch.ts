import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { AgentInstanceRunLaunchData } from '../types';

// THE LAUNCH OF A CARD'S RUN IN A DEVELOPER'S AGENT (Story MOTIR-6864 ·
// MOTIR-7026; `docs/decisions/agent-instance-run.md` §4). Emitted by
// `agentInstanceRunService.start` once the run is open and its cards claimed, so
// the route answers at once.
//
// Each pass reads the run and its agent from the top (`awaitAgent`): an agent
// still coming up is settled once and the pass DEFERS (`deferRun`) — the agent
// row and the run row are the durable state, nothing is remembered between
// passes. Once the agent is `running`, the launch itself runs in ONE memoized
// step: the live probes, the run token minted and handed to the launcher on the
// exec's stdin, and the outcome recorded. The memo is the OUTCOME, never the
// token, so a resumed run replays a word and never re-execs.
//
// ⚠️ `retryPolicy: 'none'`, as `hosted-run/supervise`'s: a failed launch ends
// its run `failed` itself, and a blind retry could start a second session in the
// agent. `idempotency` keeps a double emit to ONE launch per run.
export const agentInstanceRunLaunch = defineJob(
  {
    id: 'agent-instance-run/launch',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as AgentInstanceRunLaunchData;
    const verdict = await services.agentInstanceRun.awaitAgent(data.dispatchRunId);
    if (typeof verdict === 'object') deferRun(verdict.deferUntil, 'the agent is coming up');
    if (verdict !== 'ready') return verdict;
    return ctx.step.run('launch-agent-run', () =>
      services.agentInstanceRun.launchNow(data.dispatchRunId),
    );
  },
);
