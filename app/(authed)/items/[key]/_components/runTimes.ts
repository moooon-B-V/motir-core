import 'server-only';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import { formatRunInstant } from '@/lib/runs/runClock';

// Run timestamps, formatted ON THE SERVER (Story MOTIR-1789 · MOTIR-1796).
//
// ⚠️ THIS EXISTS TO STOP A HYDRATION MISMATCH, not to save the client work.
// A run list is a column of dates, and a date formatted during render reads the
// BROWSER's clock and locale on the client and the NODE process's on the
// server — so the two disagree on first paint and React replaces the markup it
// just streamed. `CLAUDE.md`'s live-UI rule names it: derive `now` and the
// timezone through the app's shipped seam rather than calling `Date.now()`
// during render.
//
// The cheapest correct answer for a list that does not tick is to format once,
// on the server, and hand the strings down: the section receives text and has no
// clock of its own to disagree with. A LIVE elapsed counter would be a different
// problem needing a different instrument, and the design does not ask for one —
// the run's own duration is on the run view.

/**
 * `{ [runId]: "29 Aug, 14:02 UTC" }` — one pre-formatted label per run.
 *
 * The FORMAT is `lib/runs/runClock.ts`'s, shared with the client surfaces
 * (MOTIR-3895) so a run's start time cannot read one way on the item page and
 * another in the run modal. What stays here is the SERVER-SIDE application of it
 * — formatting once and handing the strings down, so this section has no clock
 * of its own to disagree with on first paint.
 */
export function formatRunTimes(runs: DispatchRunDto[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const run of runs) {
    out[run.id] = formatRunInstant(run.startedAt);
  }
  return out;
}
