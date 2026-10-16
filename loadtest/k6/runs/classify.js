// CLASSIFYING ONE RUN-LIFECYCLE RESPONSE (Story MOTIR-8538 · MOTIR-8676).
//
// `classifyRunResponse({ step, status, headers, body })` → exactly one of the
// shared four (`../lib/outcome.js`):
//
//   ok       the step's documented success status — 201 for the open, 204 for a
//            heartbeat, 200 otherwise — and a claim answered `claimed` or `mine`
//   empty    a claim answered `taken` or `not_claimable`: served, did no work
//   limited  a 429 (`RATE_LIMIT_EXCEEDED`, lib/api/v1/rateLimit.ts). Its
//            `retryAfterSeconds` comes from the body first, `Retry-After` second;
//            the iteration backs off and resumes the same run.
//   error    anything else
//
// PURE (no k6 import).

import { EMPTY, ERROR, LIMITED, OK, parseRetryAfter } from '../lib/outcome.js';
import { headerValue } from '../lib/classify.js';

/** The success status of each step. */
export const SUCCESS_STATUS = Object.freeze({
  read: 200,
  claim: 200,
  prompt: 200,
  open: 201,
  heartbeat: 204,
  events: 200,
  close: 200,
  recycle: 200,
});

export const CLAIM_TOOK = Object.freeze(['claimed', 'mine']);
export const CLAIM_REFUSED = Object.freeze(['taken', 'not_claimable']);

function parseJson(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ step: string, status: number, headers?: any, body?: string | null }} response
 * @returns {{ outcome: string, retryAfterSeconds: number | null, json: any }}
 */
export function classifyRunResponse({ step, status, headers, body }) {
  const json = parseJson(body);
  if (status === 429) {
    return {
      outcome: LIMITED,
      retryAfterSeconds:
        parseRetryAfter(json?.retryAfterSeconds) ??
        parseRetryAfter(headerValue(headers, 'retry-after')),
      json,
    };
  }
  if (status !== SUCCESS_STATUS[step]) return { outcome: ERROR, retryAfterSeconds: null, json };
  if (step === 'claim') {
    const claim = json?.outcome;
    if (CLAIM_TOOK.includes(claim)) return { outcome: OK, retryAfterSeconds: null, json };
    if (CLAIM_REFUSED.includes(claim)) return { outcome: EMPTY, retryAfterSeconds: null, json };
    return { outcome: ERROR, retryAfterSeconds: null, json };
  }
  return { outcome: OK, retryAfterSeconds: null, json };
}
