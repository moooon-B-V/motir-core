// CLASSIFYING AND RECORDING ONE READER REQUEST (Story MOTIR-8538 · MOTIR-8677).
//
// A reader is a signed-in person: page loads, the Workbench's held stream, the
// window re-read a stream frame triggers, and plan reads. Every request it makes
// is classified into the shared four (`./outcome.js`) and recorded here.
//
//   ok       a 2xx, or a 3xx that is not a bounce — the bare `/workbench` answers
//            a 307 to its landing URL, and that hop is an ok request
//   limited  a 429. Never ok, never error, never in `reader_duration`.
//   error    every other status, a timeout or transport failure (status 0), and a
//            3xx that BOUNCES the reader out (to sign-in, re-consent, a two-factor
//            hold, no-project or onboarding): a cookie the target does not accept
//            must read as an error, not as a fast ok.
//   empty    never produced by a reader.
//
// The metric contract the report (MOTIR-8679) reads, fixed here:
//   reader_requests   Counter EVERY reader request — tags route, outcome, status, role
//   reader_duration   Trend   ok requests only — tags route, role. Never the stream,
//                             whose duration is its hold time.
//   http_503          Counter every 503 — tags route, role. Also an error. Nothing
//                             here says whether the proxy or the app sent it.
//
// PURE (no k6 import), so the story gate and vitest import it.

import { ERROR, LIMITED, OK } from './outcome.js';
import { headerValue } from './classify.js';

export const ROLE_READER = 'reader';

/** The seven `route` tag values. Server-side labels where one exists (requestLabel.ts). */
export const READER_ROUTES = Object.freeze([
  'workbench',
  'workbench_stream',
  'workbench_window',
  'boards',
  'items',
  'plan_get',
  'plan_poll',
]);

export const STREAM_ROUTE = 'workbench_stream';

export const READER_METRIC_NAMES = Object.freeze({
  requests: 'reader_requests',
  duration: 'reader_duration',
  http503: 'http_503',
  renders: 'workbench_renders',
  streamOpened: 'stream_opened',
  streamOpenFailures: 'stream_open_failures',
  streamDrops: 'stream_drops',
  streamOpenMs: 'stream_open_ms',
  streamFrames: 'stream_frames',
  streamOpenAtEnd: 'stream_open_at_end',
  streamReconnected: 'stream_reconnected',
  streamLost: 'stream_lost',
});

/**
 * Where an app redirect sends a reader it will not serve. A 3xx to one of these
 * is a refusal, not a hop. `/api/staff-session/clear` is the authed layout's
 * bounce for a stale staff cookie.
 */
export const BOUNCE_PATHS = Object.freeze([
  '/sign-in',
  '/re-consent',
  '/two-factor-required',
  '/no-project',
  '/onboarding',
  '/api/staff-session',
]);

/** The path of a `Location` value, absolute or relative; null when there is none. */
export function locationPath(location) {
  if (typeof location !== 'string' || location === '') return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(location);
  const path = m ? m[1] || '/' : location.split(/[?#]/)[0];
  return path;
}

/** True when a 3xx `Location` sends the reader out to sign in or clear a hold. */
export function isBounce(location) {
  const path = locationPath(location);
  if (path === null) return false;
  return BOUNCE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Classify one reader response into `ok | limited | error`.
 *
 * @param {{ status: number, headers?: any }} response
 */
export function classifyReaderResponse({ status, headers }) {
  if (status === 429) return LIMITED;
  if (status >= 200 && status < 300) return OK;
  if (status >= 300 && status < 400) {
    return isBounce(headerValue(headers, 'location')) ? ERROR : OK;
  }
  return ERROR;
}

/**
 * Record one reader request. `metrics` is `{ requests, duration, http503 }`, each
 * with k6's `add(value, tags)`. A stream request (`route: workbench_stream`) is
 * counted but never timed. Returns the outcome it recorded.
 *
 * @param {Record<'requests' | 'duration' | 'http503', { add: (value: number, tags: Record<string, string>) => void }>} metrics
 * @param {{ route: string, outcome: string, status: number, durationMs?: number }} request
 */
export function recordReaderRequest(metrics, { route, outcome, status, durationMs }) {
  const base = { role: ROLE_READER, route };
  metrics.requests.add(1, { ...base, outcome, status: String(status) });
  if (status === 503) metrics.http503.add(1, base);
  if (outcome === OK && route !== STREAM_ROUTE && typeof durationMs === 'number') {
    metrics.duration.add(durationMs, base);
  }
  return outcome;
}

/**
 * The `setup()` cookie probe's verdict on `GET /workbench` with the first
 * reader's cookie: null when the target accepts the seed's session, else the
 * reason the run must not start. A manifest the target does not accept (a seed,
 * `BETTER_AUTH_SECRET` or base-URL mismatch) would otherwise read as a slow
 * server, which the per-request `error` tag cannot tell apart.
 *
 * @param {{ status: number, headers?: any }} response
 */
export function probeVerdict({ status, headers }) {
  const fix =
    "the target does not accept the seed manifest's session cookie: re-seed against this " +
    "target, and check BETTER_AUTH_SECRET and MOTIR_BASE_URL match the seed's";
  if (status === 0) return 'cookie probe: the target did not answer GET /workbench';
  if (status === 401) return `cookie probe: GET /workbench answered 401 — ${fix}`;
  if (status === 403) return 'cookie probe: GET /workbench answered 403 (a two-factor hold?)';
  if (status >= 300 && status < 400) {
    const location = headerValue(headers, 'location');
    if (isBounce(location)) {
      return `cookie probe: GET /workbench redirected to ${locationPath(location)} — ${fix}`;
    }
    return null;
  }
  if (status >= 200 && status < 300) return null;
  return `cookie probe: GET /workbench answered ${status}`;
}
