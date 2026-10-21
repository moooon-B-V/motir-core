// READERS (Story MOTIR-8538 · MOTIR-8677) — the signed-in people in the mix,
// beside the agents: a tab holding the Workbench open, and a person browsing.
//
// Each VU takes one seeded user (`../lib/manifest.js`, by `__VU`) and sends that
// user's session `Cookie` header, exactly as the seed wrote it, on every request.
//
//   readerTab     GET /workbench (the bare path 307s to its landing `?tab=`, so a
//                 page load is two requests; `workbench_renders` counts the load
//                 once), then holds GET /api/workbench/stream for the hold time,
//                 reconnecting like EventSource (`../lib/holdStream.js`). Each
//                 watermark frame whose `moved` is non-empty triggers ONE
//                 GET /api/workbench/window?tab=<viewed tab>&page=1, one in flight
//                 (`../lib/windowReadGate.js`) — the shipped client's rule. The
//                 agents' writes move the watermarks, so this measures the push
//                 path under agent load. These window reads are reader traffic the
//                 think-time estimate does not model: at most one per held tab per
//                 second (the stream polls once a second).
//   readerBrowse  a weighted loop with think time over /boards, /items,
//                 /items?page=<n>, GET /api/plans/<read plan> and the review page's
//                 poll GET /api/plans/<id>?since=<reviewVersion>, on the reader's
//                 OWN project's fixed read plans. A read plan is `planned`, so the
//                 poll's unchanged short-cut (generating plans only) never applies,
//                 and the review hands back no `reviewVersion` to poll with: the
//                 poll sends `?since=0` (`NO_REVIEW_VERSION`) and takes the
//                 server's conditional path to a full read, at a size that never
//                 drifts.
//
// ASSUMPTIONS, stated for the report's reader:
//   - Faithful to a TAB, not a browser: each page fetches its HTML document only,
//     never its /_next/static assets, which a real tab caches after its first load.
//   - Readers never write. Every change they see comes from the agents.
//   - Every reader redirect is followed by hand (`redirects: 0`), so each hop is
//     its own counted request, and a bounce to sign-in, re-consent, a two-factor
//     hold or no-project is an `error`, never a hop.
//
// What a held stream costs the instance: the route has no duration cap, so each
// held tab is one in-flight request against fly.toml's `type = "requests"`
// concurrency for its whole hold, and one watermark database read per second
// (`WORKBENCH_STREAM_POLL_MS`) that no request counter shows. The profile computes
// the proxy limit from it and the report lists the background reads.
//
// No tag, log line or summary field carries a cookie.

import http from 'k6/http';
import sse from 'k6/x/sse';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { weightedPick } from '../lib/agents.js';
import { headerValue } from '../lib/classify.js';
import { holdStream } from '../lib/holdStream.js';
import { LIMITED, OK, backoffSeconds, parseRetryAfter } from '../lib/outcome.js';
import {
  READER_METRIC_NAMES,
  ROLE_READER,
  STREAM_ROUTE,
  classifyReaderResponse,
  probeVerdict,
  recordReaderRequest,
} from '../lib/readerOutcome.js';
import { DEFAULT_BROWSE_WEIGHTS, browseTarget, readerIndexForVu } from '../lib/readerUsers.js';
import { LOST, OPEN_AT_END, RECONNECTED } from '../lib/streamTally.js';
import { createWindowReadGate, viewedTabOf, windowPath } from '../lib/windowReadGate.js';

export { readerScenarios } from '../lib/readerProfile.js';

// Init context: k6 requires custom metrics to be created at module load.
export const metrics = {
  requests: new Counter(READER_METRIC_NAMES.requests),
  duration: new Trend(READER_METRIC_NAMES.duration, true),
  http503: new Counter(READER_METRIC_NAMES.http503),
  renders: new Counter(READER_METRIC_NAMES.renders),
  streamOpened: new Counter(READER_METRIC_NAMES.streamOpened),
  streamOpenFailures: new Counter(READER_METRIC_NAMES.streamOpenFailures),
  streamDrops: new Counter(READER_METRIC_NAMES.streamDrops),
  streamOpenMs: new Trend(READER_METRIC_NAMES.streamOpenMs, true),
  streamFrames: new Counter(READER_METRIC_NAMES.streamFrames),
  streamOpenAtEnd: new Counter(READER_METRIC_NAMES.streamOpenAtEnd),
  streamReconnected: new Counter(READER_METRIC_NAMES.streamReconnected),
  streamLost: new Counter(READER_METRIC_NAMES.streamLost),
};

const STREAM_PATH = '/api/workbench/stream';
const MAX_HOPS = 5;
const END_STATE_METRIC = {
  [OPEN_AT_END]: 'streamOpenAtEnd',
  [RECONNECTED]: 'streamReconnected',
  [LOST]: 'streamLost',
};

/** A reader request's params: the seed's cookie, no jar, no redirect following. */
function params(reader, route, responseType) {
  return {
    headers: { cookie: reader.cookieHeader },
    // A fresh jar per request: a Set-Cookie answer must never add a second session
    // cookie beside the one the seed wrote.
    jar: new http.CookieJar(),
    redirects: 0,
    responseType,
    tags: { name: route, route, role: ROLE_READER },
    responseCallback: http.expectedStatuses({ min: 200, max: 399 }),
  };
}

/** An absolute URL for a path or a `Location` value. */
function absolute(baseUrl, target) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `${baseUrl}${target}`;
}

/** One request, classified, recorded, and backed off on a `limited` answer. */
function request(options, reader, route, url, responseType = 'none') {
  const res = http.get(url, params(reader, route, responseType));
  const outcome = classifyReaderResponse({ status: res.status, headers: res.headers });
  recordReaderRequest(metrics, {
    route,
    outcome,
    status: res.status,
    durationMs: res.timings.duration,
  });
  if (outcome === LIMITED) {
    const told = parseRetryAfter(headerValue(res.headers, 'retry-after'));
    sleep(backoffSeconds(told, options.maxRetryAfterSeconds));
  }
  return { res, outcome, url };
}

/** A page load: each redirect hop its own counted request, a bounce not followed. */
function page(options, reader, route, path, responseType = 'none') {
  let url = absolute(options.baseUrl, path);
  let last = null;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    last = request(options, reader, route, url, responseType);
    const location = headerValue(last.res.headers, 'location');
    if (last.outcome !== OK || last.res.status < 300 || last.res.status >= 400 || !location) break;
    url = absolute(options.baseUrl, location);
  }
  return last;
}

/** One xk6-sse connection, for `holdStream`. */
function openStream(options, reader, path, timeoutMs, onEvent) {
  const res = sse.open(
    absolute(options.baseUrl, path),
    {
      headers: { cookie: reader.cookieHeader },
      jar: new http.CookieJar(),
      timeout: `${Math.max(1, Math.ceil(timeoutMs))}ms`,
      tags: { name: STREAM_ROUTE, route: STREAM_ROUTE, role: ROLE_READER },
    },
    (client) => {
      client.on('event', (event) => onEvent({ name: event.name, data: event.data }));
      // A read error (the hold's timeout, a reset) ends the connection; without the
      // close the extension would wait on a reader that has already stopped.
      client.on('error', () => client.close());
    },
  );
  return {
    status: res && typeof res.status === 'number' ? res.status : 0,
    contentType: res && res.headers ? (headerValue(res.headers, 'content-type') ?? null) : null,
  };
}

/** Record one stream attempt once its connection has ended. */
function recordAttempt(attempt) {
  const base = { role: ROLE_READER, route: STREAM_ROUTE };
  // Open only on proof (200 event-stream AND the opening frame). An answer that
  // classifies `ok` without that proof — a 200 that never sent its frame, a page
  // the client was redirected to — is an error.
  const classified = classifyReaderResponse({ status: attempt.status });
  const outcome = attempt.opened ? OK : classified === OK ? 'error' : classified;
  recordReaderRequest(metrics, { route: STREAM_ROUTE, outcome, status: attempt.status });
  if (attempt.opened) {
    metrics.streamOpenMs.add(attempt.openMs, base);
    if (attempt.firstOpen) metrics.streamOpened.add(1, base);
  } else {
    metrics.streamOpenFailures.add(1, {
      ...base,
      status: String(attempt.status),
      reconnect: String(attempt.reconnect),
    });
  }
}

/**
 * `options`: `{ baseUrl, holdSeconds, thinkSeconds, maxRetryAfterSeconds }`.
 * Returns the iteration function for the profile's `readerTab` scenario.
 */
export function readerTab(readers, options) {
  return function readerTabIteration() {
    const reader = readers[readerIndexForVu(exec.vu.idInTest, readers.length)];
    const base = { role: ROLE_READER };

    const load = page(options, reader, 'workbench', '/workbench');
    if (load.outcome === OK) metrics.renders.add(1, { ...base, route: 'workbench' });
    // The tab this VU views for the rest of the iteration: the landing URL's own.
    const tab = viewedTabOf(load.url);

    const gate = createWindowReadGate();
    const held = holdStream({
      openStream: (path, timeoutMs, onEvent) =>
        openStream(options, reader, path, timeoutMs, onEvent),
      now: () => Date.now(),
      sleep: (ms) => sleep(ms / 1000),
      holdMs: options.holdSeconds * 1000,
      path: STREAM_PATH,
      onAttempt: recordAttempt,
      onFrame(frame) {
        metrics.streamFrames.add(1, { ...base, route: STREAM_ROUTE });
        if (tab === null || !gate.frame(frame.moved)) return;
        do {
          gate.begin();
          request(options, reader, 'workbench_window', absolute(options.baseUrl, windowPath(tab)));
        } while (gate.done());
      },
    });

    if (held.drops > 0) metrics.streamDrops.add(held.drops, { ...base, route: STREAM_ROUTE });
    const counter = END_STATE_METRIC[held.state];
    if (counter) metrics[counter].add(1, { ...base, route: STREAM_ROUTE });
    if (options.thinkSeconds) sleep(options.thinkSeconds);
  };
}

/** Each VU's last `reviewVersion` per plan, for the review page's poll. */
const reviewVersions = {};

/**
 * `options`: `{ baseUrl, weights, thinkSeconds, itemsPages, maxRetryAfterSeconds }`.
 * Returns the iteration function for the profile's `readerBrowse` scenario.
 */
export function readerBrowse(readers, options) {
  const weights = options.weights ?? DEFAULT_BROWSE_WEIGHTS;
  return function readerBrowseIteration() {
    const reader = readers[readerIndexForVu(exec.vu.idInTest, readers.length)];
    const step = weightedPick(weights, Math.random());
    const target = browseTarget(step, reader, reviewVersions, Math.random(), options.itemsPages);
    const isPlan = target.planId !== undefined;
    const done = page(options, reader, target.route, target.path, isPlan ? 'text' : 'none');
    if (isPlan && done.outcome === OK && typeof done.res.body === 'string') {
      try {
        const version = JSON.parse(done.res.body).reviewVersion;
        if (typeof version === 'string') reviewVersions[target.planId] = version;
      } catch {
        // Not JSON: the request is already counted by its status.
      }
    }
    if (options.thinkSeconds) {
      // ±50% jitter, so the browsers do not move in lockstep.
      sleep(options.thinkSeconds * (0.5 + Math.random()));
    }
  };
}

/**
 * The `setup()` cookie probe: `GET /workbench` with the first reader's cookie.
 * Aborts the whole run, before any VU starts, when the target does not accept it.
 */
export function probeReaderCookie(readers, options) {
  if (readers.length === 0) exec.test.abort('cookie probe: the manifest holds no users');
  const reader = readers[0];
  const res = http.get(`${options.baseUrl}/workbench`, {
    headers: { cookie: reader.cookieHeader },
    jar: new http.CookieJar(),
    redirects: 0,
    responseType: 'none',
    tags: { name: 'cookie_probe', role: ROLE_READER },
  });
  const reason = probeVerdict({ status: res.status, headers: res.headers });
  if (reason) exec.test.abort(reason);
}
