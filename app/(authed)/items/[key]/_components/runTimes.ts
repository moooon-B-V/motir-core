import 'server-only';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';

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

/** `{ [runId]: "29 Aug, 14:02" }` — one pre-formatted label per run. */
export function formatRunTimes(runs: DispatchRunDto[]): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const out: Record<string, string> = {};
  for (const run of runs) {
    // UTC, deliberately and visibly: a run's timestamps are written by a machine
    // that may be anywhere, and a label silently rendered in the SERVER's zone is
    // a number a reader cannot check. Per-viewer local time is a real want and a
    // separate one — it needs the shipped locale seam and a client boundary,
    // which is the thing this module exists to avoid on a list that never ticks.
    out[run.id] = `${fmt.format(new Date(run.startedAt))} UTC`;
  }
  return out;
}
