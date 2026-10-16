// THE k6 MCP CLIENT (Story MOTIR-8538 · MOTIR-8675).
//
// `callTool(token, tool, args, opts)` POSTs one bare JSON-RPC `tools/call` to
// `/api/mcp` with `Authorization: Bearer <token>` and
// `accept: application/json, text/event-stream`, with no session handshake — the
// wire shape `scripts/staging/lib/cases.ts` `mcp()` / `tool()` already uses against
// staging. It classifies the answer (`./classify.js`), records the metric contract
// (`./record.js`), backs off on a `limited` answer as a real client does, and
// returns `{ outcome, structured, retryAfterSeconds }`.
//
// It imports nothing from `lib/`: k6 runs plain JavaScript and cannot load the
// app's TypeScript. The token goes in the Authorization header only — never in a
// tag, a log line or the summary.

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { classifyMcpResponse } from './classify.js';
import { LIMITED, backoffSeconds } from './outcome.js';
import { METRIC_NAMES, recordCall } from './record.js';

// Init context: k6 requires custom metrics to be created at module load.
export const metrics = {
  duration: new Trend(METRIC_NAMES.duration, true),
  calls: new Counter(METRIC_NAMES.calls),
  errors: new Rate(METRIC_NAMES.errors),
  limited: new Rate(METRIC_NAMES.limited),
  retryAfter: new Trend(METRIC_NAMES.retryAfter),
};

let rpcId = 0;

/**
 * One tool call. `opts`: `baseUrl` (the app origin), `group` (`read` / `write` /
 * `claim` / `burst`), `maxRetryAfterSeconds` (the profile's cap on a back-off).
 */
export function callTool(token, tool, args, opts) {
  rpcId += 1;
  const res = http.post(
    `${opts.baseUrl}/api/mcp`,
    JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      // k6's own http_req_* metrics are tagged by name, never by the URL's query.
      tags: { name: 'POST /api/mcp', tool, group: opts.group, role: 'agent' },
      // A 4xx/5xx is an outcome to classify, not a failed check.
      responseCallback: http.expectedStatuses({ min: 200, max: 599 }),
    },
  );
  const verdict = classifyMcpResponse({
    status: res.status,
    headers: res.headers,
    body: typeof res.body === 'string' ? res.body : '',
    tool,
  });
  recordCall(metrics, {
    group: opts.group,
    tool,
    outcome: verdict.outcome,
    durationMs: res.timings.duration,
    retryAfterSeconds: verdict.retryAfterSeconds,
  });
  if (verdict.outcome === LIMITED)
    sleep(backoffSeconds(verdict.retryAfterSeconds, opts.maxRetryAfterSeconds));
  return {
    outcome: verdict.outcome,
    structured: verdict.structured,
    retryAfterSeconds: verdict.retryAfterSeconds,
  };
}
