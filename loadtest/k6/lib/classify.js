// CLASSIFYING ONE MCP RESPONSE (Story MOTIR-8538 · MOTIR-8675).
//
// `classifyMcpResponse({ status, headers, body, tool })` turns one `/api/mcp`
// answer into exactly one outcome from `./outcome.js`. PURE (no k6 import), so the
// unit tests run it under vitest.
//
// The rules, each pinned by tests/loadtest/agentScenarios.test.ts:
//   limited  ANY HTTP 429 — the status alone decides. The transport refusal
//            (`mcpRateLimitedResponse`, lib/rateLimit/mcpGuard.ts) carries a JSON-RPC
//            body with error.code -32029 and error.data.code 'RATE_LIMITED'; when it
//            parses, its error.data.retryAfterSeconds wins, else `Retry-After`.
//            Also an HTTP 200 tool result with isError and structuredContent.code
//            'RATE_LIMITED' (the per-tool shape, lib/mcp/toolResult.ts
//            `rateLimitedToolError`, MOTIR-8600).
//   empty    a claim_work_item result whose structuredContent.outcome is `taken`
//            or `not_claimable` (lib/dto/claim.ts).
//   error    any other non-200; an isError result; a body that does not parse; an
//            HTTP 200 body with an `error` member and no `result` (the -32602
//            unknown-key refusal of lib/mcp/strictInput.ts, which carries no
//            isError flag and would otherwise read as ok).
//   ok       everything else (a claim answered `claimed` or `mine` included).

import { EMPTY, ERROR, LIMITED, OK, parseRetryAfter } from './outcome.js';

/** lib/rateLimit/mcpGuard.ts `MCP_RATE_LIMITED_JSONRPC_CODE`. */
export const MCP_RATE_LIMITED_JSONRPC_CODE = -32029;
/** lib/rateLimit (the shared `RATE_LIMITED_CODE`), on both refusal shapes. */
export const RATE_LIMITED_CODE = 'RATE_LIMITED';
/** lib/dto/claim.ts — the claim outcomes that did no work. */
export const EMPTY_CLAIM_OUTCOMES = Object.freeze(['taken', 'not_claimable']);

/** A header value, whatever case the transport spelled its name in. */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * Parse a JSON-RPC body sent as plain JSON or as an SSE stream (`data:` lines),
 * the two shapes `/api/mcp` answers with. Returns null when it does not parse.
 */
export function parseRpcBody(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;
  const text = body.trimStart();
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify one `/api/mcp` response. Returns
 * `{ outcome, retryAfterSeconds, structured, result }`.
 *
 * @param {{ status: number, headers?: any, body?: string, tool?: string }} response
 */
export function classifyMcpResponse({ status, headers, body, tool }) {
  const rpc = parseRpcBody(body);
  if (status === 429) {
    const fromBody = parseRetryAfter(rpc?.error?.data?.retryAfterSeconds);
    return {
      outcome: LIMITED,
      retryAfterSeconds: fromBody ?? parseRetryAfter(headerValue(headers, 'retry-after')),
      structured: null,
      result: null,
    };
  }
  if (status !== 200 || rpc === null) {
    return { outcome: ERROR, retryAfterSeconds: null, structured: null, result: null };
  }
  const result = rpc.result;
  if (!result || typeof result !== 'object') {
    // A 200 with a JSON-RPC `error` and no `result` (the -32602 strict-input refusal).
    return { outcome: ERROR, retryAfterSeconds: null, structured: null, result: null };
  }
  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent
      : null;
  if (result.isError === true) {
    if (structured?.code === RATE_LIMITED_CODE) {
      return {
        outcome: LIMITED,
        retryAfterSeconds:
          parseRetryAfter(structured.retryAfterSeconds) ??
          parseRetryAfter(headerValue(headers, 'retry-after')),
        structured,
        result,
      };
    }
    return { outcome: ERROR, retryAfterSeconds: null, structured, result };
  }
  if (tool === 'claim_work_item' && EMPTY_CLAIM_OUTCOMES.includes(structured?.outcome)) {
    return { outcome: EMPTY, retryAfterSeconds: null, structured, result };
  }
  return { outcome: OK, retryAfterSeconds: null, structured, result };
}
