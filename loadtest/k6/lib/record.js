// RECORDING ONE CALL INTO THE METRIC CONTRACT (Story MOTIR-8538 · MOTIR-8675).
//
// The contract the report (MOTIR-8679) reads, fixed here:
//   mcp_call_duration   Trend   SERVED (`ok`) calls only — tags group, tool, role
//   mcp_calls           Counter EVERY call — tags group, tool, outcome, role. The
//                               report's source for every count (errors, refusals,
//                               empty claims, throughput); the Trend cannot supply them.
//   mcp_errors          Rate    over every call: outcome === error
//   mcp_rate_limited    Rate    over every call: outcome === limited
//   retry_after_seconds Trend   the wait a `limited` call was told
//   burst_duration      Trend   one whole burst (recorded by the burst scenario)
//
// Every metric carries `role` (`agent` here; `run` and `reader` in the sibling
// scenarios), so the report separates the three without k6's `scenario` tag.
//
// PURE: the metric objects are passed in (`mcpClient.js` builds the k6 ones), so a
// test can hand in stubs and read back exactly what was added.

import { ERROR, LIMITED, OK } from './outcome.js';

export const ROLE_AGENT = 'agent';

export const METRIC_NAMES = Object.freeze({
  duration: 'mcp_call_duration',
  calls: 'mcp_calls',
  errors: 'mcp_errors',
  limited: 'mcp_rate_limited',
  retryAfter: 'retry_after_seconds',
  burst: 'burst_duration',
});

/**
 * Record one classified call. `metrics` is `{ duration, calls, errors, limited,
 * retryAfter }`, each with k6's `add(value, tags)`. Tags never carry a token.
 *
 * @param {Record<'duration' | 'calls' | 'errors' | 'limited' | 'retryAfter', { add: (value: any, tags: Record<string, string>) => void }>} metrics
 * @param {{ group: string, tool: string, outcome: string, durationMs: number, retryAfterSeconds?: number | null, role?: string }} call
 */
export function recordCall(metrics, { group, tool, outcome, durationMs, retryAfterSeconds, role }) {
  const base = { role: role ?? ROLE_AGENT, group, tool };
  metrics.calls.add(1, { ...base, outcome });
  metrics.errors.add(outcome === ERROR, base);
  metrics.limited.add(outcome === LIMITED, base);
  if (outcome === OK) metrics.duration.add(durationMs, base);
  if (outcome === LIMITED && typeof retryAfterSeconds === 'number') {
    metrics.retryAfter.add(retryAfterSeconds, base);
  }
}
