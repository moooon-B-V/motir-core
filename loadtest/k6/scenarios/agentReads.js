// READ AGENTS (Story MOTIR-8538 · MOTIR-8675) — get_work_item, search_work_items,
// skeleton and get_plan, weighted by the profile, each VU one `read` agent.
//
// The profile (MOTIR-8678) wires the returned function into a k6 `scenarios`
// entry: `export const agentReadsExec = agentReads(manifest, profile.agents.read)`.
// No count is hard-coded here; weights, think time and the back-off cap are options.

import exec from 'k6/execution';
import { sleep } from 'k6';
import { pickAgent } from '../lib/agents.js';
import { readIteration } from '../lib/iterations.js';
import { callTool } from '../lib/mcpClient.js';

/** `options`: `{ baseUrl, weights: { tool: n }, thinkSeconds, maxRetryAfterSeconds }`. */
export function agentReads(manifest, options) {
  return function agentReadsIteration() {
    const { agent } = pickAgent(manifest, 'read', exec.vu.idInTest);
    const call = (tool, args) => callTool(agent.token, tool, args, { ...options, group: 'read' });
    readIteration(
      call,
      manifest,
      agent,
      exec.vu.iterationInScenario,
      options.weights,
      Math.random(),
    );
    if (options.thinkSeconds) sleep(options.thinkSeconds);
  };
}
