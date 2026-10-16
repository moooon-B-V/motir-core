// ONE HELD STREAM'S END STATE (Story MOTIR-8538 · MOTIR-8677).
//
// A reader holds `/api/workbench/stream` for the profile's hold time, reconnecting
// when it drops. At the end the held stream is in exactly ONE state:
//
//   open_at_end    opened, never dropped, and still open when the hold ended
//   reconnected    dropped at least once after it was open, and the hold ended
//                  on a reconnect that received its opening frame
//   lost           the hold ended without a live connection: the last reconnect
//                  failed, or a 200 stream never sent its opening frame
//   never_opened   the first attempt was refused before any stream opened (a 401,
//                  a two-factor 403, NO_ACTIVE_PROJECT 404) or never connected, and
//                  nothing opened later. An OPEN FAILURE, not a held stream: it is
//                  counted in `stream_open_failures`, never in the three above.
//
// A connection counts as open only on PROOF: a 200 `text/event-stream` AND its
// opening `watermark` frame (`app/api/workbench/stream/route.ts` writes that frame
// even when nothing moved).
//
// The events, in the order they happen:
//   { kind: 'open_ok' }                      an attempt got its opening frame
//   { kind: 'open_failed', streamed }        an attempt ended with no opening frame;
//                                            `streamed` = it answered 200 event-stream
//   { kind: 'dropped' }                      an open connection ended before the hold
//   { kind: 'frame' }                        a frame on an open connection
//   { kind: 'hold_ended' }                   the hold time is up
//
// PURE (no k6 import).

export const OPEN_AT_END = 'open_at_end';
export const RECONNECTED = 'reconnected';
export const LOST = 'lost';
export const NEVER_OPENED = 'never_opened';

/** The three states a HELD stream can end in, each its own k6 Counter. */
export const HELD_STATES = Object.freeze([OPEN_AT_END, RECONNECTED, LOST]);

/** The SSE frame the stream route writes (`WORKBENCH_STREAM_FRAME`). */
export const WATERMARK_FRAME = 'watermark';

/** A running tally for one held stream. */
export function createStreamTally() {
  let opened = false;
  let streamed = false;
  let connected = false;
  let interrupted = false;
  let frames = 0;
  let drops = 0;
  let ended = false;

  return {
    /** Apply one event. Events after `hold_ended` are ignored. */
    apply(event) {
      if (ended) return;
      switch (event.kind) {
        case 'open_ok':
          opened = true;
          streamed = true;
          connected = true;
          break;
        case 'open_failed':
          if (event.streamed) streamed = true;
          if (opened || streamed) interrupted = true;
          connected = false;
          break;
        case 'dropped':
          if (connected) drops += 1;
          connected = false;
          interrupted = true;
          break;
        case 'frame':
          if (connected) frames += 1;
          break;
        case 'hold_ended':
          ended = true;
          break;
        default:
          throw new Error(`unknown stream event: ${event.kind}`);
      }
    },
    /** The end state; meaningful once `hold_ended` was applied. */
    endState() {
      if (!opened && !streamed) return NEVER_OPENED;
      if (!connected) return LOST;
      return interrupted ? RECONNECTED : OPEN_AT_END;
    },
    get opened() {
      return opened;
    },
    get drops() {
      return drops;
    },
    get frames() {
      return frames;
    },
  };
}

/** The end state of a whole event sequence (a `hold_ended` is implied at the end). */
export function tallyStream(events) {
  const tally = createStreamTally();
  for (const e of events) tally.apply(e);
  tally.apply({ kind: 'hold_ended' });
  return tally.endState();
}

/**
 * Read one SSE event as a watermark frame: `{ moved, cursor }`, or null for a
 * heartbeat comment, an `error` frame or a body that does not parse.
 */
export function parseWatermarkFrame(event) {
  if (!event || event.name !== WATERMARK_FRAME || typeof event.data !== 'string') return null;
  try {
    const data = JSON.parse(event.data);
    if (!data || typeof data.cursor !== 'string' || !Array.isArray(data.moved)) return null;
    return { moved: data.moved, cursor: data.cursor };
  } catch {
    return null;
  }
}
