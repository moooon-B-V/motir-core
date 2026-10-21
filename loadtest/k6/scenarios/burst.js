// THE move_to_parent BURST (Story MOTIR-8538 · MOTIR-8675) — the 2026-10-13 shape
// behind MOTIR-8259: one agent makes `burstSize` SEQUENTIAL move_to_parent calls,
// each moving the next card of its OWN burst slot to the other of its OWN two
// parents. `burstAgents` bursts run at once (the profile scales it with N); no two
// share a card or a parent, so they contend only on the server.
//
// The profile starts this scenario at an offset into the steady window
// (`startTime`), so readers and the other agents are measured while it runs.

import exec from 'k6/execution';
import { Trend } from 'k6/metrics';
import { pickAgent } from '../lib/agents.js';
import { burstIteration } from '../lib/iterations.js';
import { callTool } from '../lib/mcpClient.js';
import { METRIC_NAMES, ROLE_AGENT } from '../lib/record.js';

const burstDuration = new Trend(METRIC_NAMES.burst, true);

/** `options`: `{ baseUrl, maxRetryAfterSeconds }`. One iteration = one whole burst. */
export function burst(manifest, options) {
  return function burstIterationFn() {
    const { agent } = pickAgent(manifest, 'burst', exec.vu.idInTest);
    const call = (tool, args) => callTool(agent.token, tool, args, { ...options, group: 'burst' });
    const started = Date.now();
    burstIteration(call, manifest, agent, exec.vu.iterationInScenario);
    burstDuration.add(Date.now() - started, { role: ROLE_AGENT, group: 'burst' });
  };
}
