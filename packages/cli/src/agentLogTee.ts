import type { DispatchRunReporter } from './dispatchRunReporter.js';

// The AGENT LOG TEE (Story MOTIR-1789 · MOTIR-3961) — the producer for the
// `log` event kind, which shipped complete in every other respect and had no
// caller at all.
//
// ⚠️ WHAT WAS MISSING, because it explains the shape of this file. The schema
// carried `DispatchEventKind.log` ("The opt-in log body"), `--report-log` was
// on all three dispatch commands, `dispatchRunReporter` stripped `body`
// centrally when the flag was off, `dispatchRunSweep` deleted bodies after 30
// days, and `motir help` promised the operator all of it. Nothing in
// `packages/cli/src` ever emitted one: the emitted vocabulary was
// `run_opened` · `scope_claimed` · `snapshot_frozen` · `card_claimed` ·
// `card_skipped` · `checkout_ready` · `prompt_issued` · `agent_started` ·
// `agent_exited` · `leg_verdict` · `session_pr` · `plan_approved` ·
// `ci_verdict` · `card_settled` · `run_closed`, and the only
// `reporter.event({ kind: 'log' })` calls in the repository were in this
// package's own tests. A green unit test proves a method works when it is
// called; it never proves that anything calls it.
//
// ⚠️ IT BATCHES, AND THAT IS NOT AN OPTIMISATION. `dispatchRunReporter` bounds
// its queue at `REPORTER_QUEUE_LIMIT` and drops the OLDEST past it, so that the
// TAIL survives — "the half an operator opens a run page for". A fifty-minute
// agent run emits tens of thousands of lines; one event per line would blow
// through that bound thousands of times over and leave a queue holding the last
// few hundred LINES rather than the last few hundred KILOBYTES. Accumulating to
// a size threshold keeps the same bound holding a useful amount of transcript.

/**
 * Bytes of agent output that accumulate before one `log` event is queued.
 *
 * Sized against the reporter's own queue rather than against latency: the pane
 * that reads these updates on the reporter's FLUSH cadence, not on this
 * threshold, so making it smaller buys no liveness and costs queue slots.
 */
export const LOG_CHUNK_BYTES = 4096;

export interface AgentLogTee {
  /** Take a chunk of the agent's output. Never throws. */
  write(chunk: string): void;
  /** Queue whatever is left. Call once, before the run's terminal event. */
  flush(): void;
}

export interface AgentLogTeeDeps {
  /** Queue one body. In production this is a `reporter.event` call. */
  emit: (body: string) => void;
  /** Overridden only by the tests. */
  chunkBytes?: number;
}

export function createAgentLogTee(deps: AgentLogTeeDeps): AgentLogTee {
  const limit = deps.chunkBytes ?? LOG_CHUNK_BYTES;
  let buffer = '';

  // Reporting is an OBSERVATION of the run and may never change it: a throw
  // here would propagate out of a stream 'data' handler and take the dispatch
  // with it. Swallowed at the one place every chunk passes through, for the
  // same reason the body strip lives in one place — a call site that forgot
  // would be the bug.
  const send = (body: string): void => {
    if (body === '') return;
    try {
      deps.emit(body);
    } catch {
      /* best-effort, always */
    }
  };

  return {
    write(chunk) {
      buffer += chunk;
      if (buffer.length < limit) return;
      send(buffer);
      buffer = '';
    },
    flush() {
      const rest = buffer;
      buffer = '';
      send(rest);
    },
  };
}

/**
 * The tee for ONE dispatched leg, or `null` when the operator did not ask for
 * log bodies.
 *
 * ⚠️ THE NULL IS ABOUT CAPTURE, NOT ABOUT PRIVACY, and the distinction is the
 * whole reason this reads `wantsLogBodies` rather than re-deriving the flag.
 * The scrub stays where it is — `dispatchRunReporter.event` strips `body` from
 * every event when the flag is off, and this file adds no second check and no
 * per-call-site branch. What it avoids is the WORK: without the opt-in, teeing
 * the agent's output would pipe every byte through this process to build events
 * whose bodies the reporter would then throw away.
 */
export function createLegLogTee(
  reporter: DispatchRunReporter,
  workItemKey: string,
): AgentLogTee | null {
  if (!reporter.wantsLogBodies) return null;
  return createAgentLogTee({
    emit: (body) => reporter.event({ kind: 'log', workItemKey, body }),
  });
}
