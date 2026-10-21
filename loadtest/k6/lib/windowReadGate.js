// THE WINDOW-READ RULE (Story MOTIR-8538 · MOTIR-8677).
//
// A held Workbench tab re-reads its viewed tab — ONE
// `GET /api/workbench/window?tab=<viewed>&page=1` — for each `watermark` frame
// whose `moved` is non-empty, with at most one read in flight: a frame that
// arrives during a read sets a pending flag, and exactly one more read follows.
// That is the shipped client (`useWorkbenchWindow`, `lib/live/liveSignal.ts`). The
// frame's `moved` decides WHETHER to read, never WHAT: the window route takes the
// slug of the tab the reader is viewing, which the reader already holds.
//
// PURE (no k6 import). The k6 driver:
//   if (gate.frame(moved)) do { gate.begin(); read(); } while (gate.done());

/** The gate for one held tab. */
export function createWindowReadGate() {
  let inFlight = false;
  let pending = false;

  return {
    /**
     * A frame arrived. Returns true when the caller should start a read now;
     * false when the frame moved nothing, or a read is in flight (it is then
     * pending, and `done()` will say so).
     */
    frame(moved) {
      if (!Array.isArray(moved) || moved.length === 0) return false;
      if (inFlight) {
        pending = true;
        return false;
      }
      return true;
    },
    /** A read was sent. */
    begin() {
      if (inFlight) throw new Error('a window read is already in flight');
      inFlight = true;
    },
    /** The read in flight finished. Returns true when exactly one more must follow. */
    done() {
      inFlight = false;
      const again = pending;
      pending = false;
      return again;
    },
    get inFlight() {
      return inFlight;
    },
    get pending() {
      return pending;
    },
  };
}

/**
 * The tab a Workbench page load landed on: the `tab` query of the final URL (the
 * bare `/workbench` redirects to its landing URL carrying `?tab=`). Null when the
 * URL names none.
 */
export function viewedTabOf(url) {
  if (typeof url !== 'string') return null;
  const m = /[?&]tab=([^&#]*)/.exec(url);
  if (!m || m[1] === '') return null;
  return decodeURIComponent(m[1].replace(/\+/g, ' '));
}

/** The window re-read for a viewed tab. */
export function windowPath(tab) {
  return `/api/workbench/window?tab=${encodeURIComponent(tab)}&page=1`;
}
