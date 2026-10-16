// HOLDING THE WORKBENCH STREAM LIKE A TAB (Story MOTIR-8538 · MOTIR-8677).
//
// `holdStream` holds `/api/workbench/stream` for `holdMs`, the way a browser's
// EventSource does: when the connection drops before the hold is up it waits the
// browser's default retry (3 s) and reconnects with `?since=<last cursor>`, and it
// gives up only when the hold ends. The route keeps no per-connection state and
// reads a replayed cursor as a redundant read (its header comment), so a
// reconnect is always safe to repeat.
//
// A FIRST attempt that is REFUSED (a 3xx bounce or a 4xx JSON answer: 401, a
// two-factor 403, NO_ACTIVE_PROJECT 404, or a 2xx that is not an event stream —
// the SSE client follows a bounce to the sign-in PAGE) is not retried: the route
// gates before the stream opens, and a refusal will not change by waiting. It is
// an open failure, never a held stream. A transport failure or a 5xx is retried.
//
// PURE: the transport is injected. `openStream(url, timeoutMs, onEvent)` opens one
// connection, calls `onEvent({ name, data })` for each SSE event, and returns
// `{ status, contentType }` once the connection has ended (`status` 0 when it
// never connected). It must end the connection by `timeoutMs` at the latest —
// that is how the hold ends. `now()` is in ms, `sleep(ms)` blocks. In k6 the
// transport is xk6-sse (`scenarios/readers.js`); in vitest it is a fake.

import { createStreamTally, parseWatermarkFrame } from './streamTally.js';

/** The browser's default EventSource retry. */
export const RECONNECT_BACKOFF_MS = 3000;

/**
 * A connection that ends this close to the deadline ended because the hold did
 * (the transport's timeout fires a little after the deadline it was given).
 */
export const HOLD_END_TOLERANCE_MS = 250;

/** True for a `Content-Type` that names an event stream. */
export function isEventStream(contentType) {
  return typeof contentType === 'string' && /^\s*text\/event-stream\b/i.test(contentType);
}

/** A first-attempt answer that waiting will not change. */
export function isRefusal(status, contentType) {
  if (status >= 200 && status < 300) return !isEventStream(contentType);
  return status >= 300 && status < 500 && status !== 408 && status !== 429;
}

/** The stream URL for a cursor: the bare path first, `?since=` on a reconnect. */
export function streamUrl(path, cursor) {
  return cursor === null || cursor === undefined
    ? path
    : `${path}?since=${encodeURIComponent(cursor)}`;
}

/**
 * Hold one stream. `onAttempt(attempt)` is called after each connection ends:
 * `{ status, contentType, opened, streamed, openMs, firstOpen, reconnect, refused }`.
 * `onFrame(frame)` is called for each watermark frame, the opening one included.
 * Returns `{ state, opened, drops, frames, attempts }`.
 *
 * @param {{
 *   openStream: (url: string, timeoutMs: number, onEvent: (event: { name: string, data: string }) => void) => { status?: number, contentType?: string | null } | null | undefined,
 *   now: () => number,
 *   sleep: (ms: number) => void,
 *   holdMs: number,
 *   path: string,
 *   backoffMs?: number,
 *   onAttempt?: (attempt: any) => void,
 *   onFrame?: (frame: { moved: string[], cursor: string }) => void,
 * }} hold
 */
export function holdStream({
  openStream,
  now,
  sleep,
  holdMs,
  path,
  backoffMs = RECONNECT_BACKOFF_MS,
  onAttempt,
  onFrame,
}) {
  const tally = createStreamTally();
  const deadline = now() + holdMs;
  let cursor = null;
  let attempts = 0;
  let everOpened = false;

  while (now() < deadline) {
    const started = now();
    let openMs = null;
    attempts += 1;
    const res = openStream(streamUrl(path, cursor), deadline - started, (event) => {
      const frame = parseWatermarkFrame(event);
      if (frame === null) return;
      if (openMs === null) {
        openMs = now() - started;
        tally.apply({ kind: 'open_ok' });
      }
      tally.apply({ kind: 'frame' });
      cursor = frame.cursor;
      if (onFrame) onFrame(frame);
    });
    const ended = now();
    const opened = openMs !== null;
    const status = typeof res?.status === 'number' ? res.status : 0;
    const streamed = status === 200 && isEventStream(res?.contentType);
    const refused = !opened && attempts === 1 && isRefusal(status, res?.contentType);
    if (onAttempt) {
      onAttempt({
        status,
        contentType: res?.contentType ?? null,
        opened,
        streamed,
        openMs,
        firstOpen: opened && !everOpened,
        reconnect: attempts > 1,
        refused,
      });
    }
    if (opened) everOpened = true;

    if (opened) {
      if (ended >= deadline - HOLD_END_TOLERANCE_MS) break;
      tally.apply({ kind: 'dropped' });
    } else {
      tally.apply({ kind: 'open_failed', streamed });
      if (refused) break;
    }
    const left = deadline - now();
    if (left <= 0) break;
    sleep(Math.min(backoffMs, left));
  }

  tally.apply({ kind: 'hold_ended' });
  return {
    state: tally.endState(),
    opened: tally.opened,
    drops: tally.drops,
    frames: tally.frames,
    attempts,
  };
}
