// WRITE AGENTS (Story MOTIR-8538 · MOTIR-8675) — update_work_item,
// transition_status (along the declared todo ↔ in_progress pair), add_comment on
// the agent's share of its project's write pool, and add_plan_items (one title-only
// add, no parentRef, never final) on its own scratch plans.

import exec from 'k6/execution';
import { sleep } from 'k6';
import { pickAgent } from '../lib/agents.js';
import { writeIteration } from '../lib/iterations.js';
import { callTool } from '../lib/mcpClient.js';

/** `options`: `{ baseUrl, weights: { tool: n }, thinkSeconds, maxRetryAfterSeconds }`. */
export function agentWrites(manifest, options) {
  return function agentWritesIteration() {
    const { agent } = pickAgent(manifest, 'write', exec.vu.idInTest);
    const call = (tool, args) => callTool(agent.token, tool, args, { ...options, group: 'write' });
    writeIteration(
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
