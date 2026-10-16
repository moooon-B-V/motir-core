// THE SHARED OUTCOME VOCABULARY (Story MOTIR-8538 · MOTIR-8675).
//
// Every call a load-test scenario makes — an agent's MCP call, a run agent's
// `/api/v1` call, a reader's page or API request — is classified into exactly ONE
// of these four, and tagged `outcome` with it. The agent card (MOTIR-8675) owns
// this file; the run-lifecycle (MOTIR-8676) and reader (MOTIR-8677) scenarios
// import it, so the four strings are spelled once.
//
//   ok       the call was served and did its work — the only class that feeds a
//            latency trend
//   empty    served, but did no work (a claim answered `taken` / `not_claimable`).
//            Never a fast success: it would drag the latency floor down.
//   limited  refused by a rate limit (any HTTP 429, or a per-tool RATE_LIMITED
//            result). Never an error, never in a latency trend.
//   error    everything else that is not ok
//
// PURE: no k6 import, so vitest runs it.

export const OK = 'ok';
export const EMPTY = 'empty';
export const LIMITED = 'limited';
export const ERROR = 'error';

/** The four values, in a fixed order. */
export const OUTCOMES = Object.freeze([OK, EMPTY, LIMITED, ERROR]);

/** Seconds to wait when a refusal names no Retry-After at all. */
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * How long a client waits after a `limited` call: the refusal's own
 * `retryAfterSeconds`, else the default, capped at the profile's maximum — a real
 * client backs off as told, and a run never stalls on an absurd header.
 */
export function backoffSeconds(retryAfterSeconds, maxSeconds) {
  const told =
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_RETRY_AFTER_SECONDS;
  return typeof maxSeconds === 'number' && maxSeconds > 0 ? Math.min(told, maxSeconds) : told;
}

/** A positive number of seconds from a header or body value, else null. */
export function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
