import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { AgentInstanceRunSuperviseData } from '../types';

// THE SUPERVISION OF A CARD'S RUN IN A DEVELOPER'S AGENT (Story MOTIR-6864 ·
// MOTIR-7027; `docs/decisions/agent-instance-run.md` §6) — modelled on
// `hosted-run/supervise`. Emitted by `agentInstanceRunService.start` beside the
// launch, carrying nothing secret.
//
// Each pass reads the run and its agent FROM THE TOP (`supervise`) and either
// ends — the run already closed, or closed now because its agent stopped, it
// went silent past the 15-minute stall window, or it reached the 12-hour
// backstop — or DEFERS a minute (`deferRun`). The run row, its events and the
// agent row are the durable state; nothing is remembered between passes, so a
// resumed or re-delivered pass simply looks again. It is the one path with no
// TRANSITION to hang on: every other end (the CLI's close, Cancel, the lost
// machine, the sweep's backstop and credit stops, the lapse reap) happens where
// the transition does, and this finds the run closed.
//
// ⚠️ A CLOSED RUN IS STILL REVOKED. A run the CLI closed had its credentials
// revoked by `dispatchRunService.close`; a pass that finds it closed revokes
// again, which is how a revoke that failed at the close is retried. Idempotent.
//
// ⚠️ `retryPolicy: 'idempotent'`: every close is a locked compare-and-set and
// every revoke is idempotent, so a retried pass closes nothing twice. A pass
// that exhausts the platform's retries leaves the run to the net beneath it —
// the lapse reap closes a run whose CLI stopped heartbeating, the agent sweep's
// reconcile closes the run of a machine it finds gone, and the run credential
// expires at its 12-hour-plus-margin ceiling on its own. `idempotency` keeps a
// double emit to ONE supervision per run (the key is the run's id).
export const agentInstanceRunSupervise = defineJob(
  {
    id: 'agent-instance-run/supervise',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as AgentInstanceRunSuperviseData;
    const verdict = await services.agentInstanceRun.supervise(data.dispatchRunId);
    if (typeof verdict === 'object') deferRun(verdict.deferUntil, 'the run is still running');
    return verdict;
  },
);
