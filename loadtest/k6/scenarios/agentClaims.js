// CLAIM AGENTS (Story MOTIR-8538 · MOTIR-8675) — claim_work_item on a claim-pool key
// from the agent's own project, then the release in the same iteration (no
// assignee, back to `todo`), so the pool never drains during a run.
//
// ⚠️ claim_next_ready is NOT in this mix: it ranks the ready leaves of the WHOLE
// project and would take write, burst, run and backlog cards other scenarios use.
//
// A claim can be refused for CI credits only when CI metering is on
// (`isCiMeteringEnabled()`: cloud billing on AND `GITHUB_FALLBACK_ORG` set,
// lib/ciMetering/config.ts). Staging leaves both unset; such a refusal is an
// `error` here, never `limited` and never `ok`.

import exec from 'k6/execution';
import { sleep } from 'k6';
import { pickAgent } from '../lib/agents.js';
import { claimIteration } from '../lib/iterations.js';
import { callTool } from '../lib/mcpClient.js';

/** `options`: `{ baseUrl, thinkSeconds, maxRetryAfterSeconds }`. */
export function agentClaims(manifest, options) {
  return function agentClaimsIteration() {
    const { agent } = pickAgent(manifest, 'claim', exec.vu.idInTest);
    const call = (tool, args) => callTool(agent.token, tool, args, { ...options, group: 'claim' });
    claimIteration(call, manifest, agent, exec.vu.iterationInScenario);
    if (options.thinkSeconds) sleep(options.thinkSeconds);
  };
}
