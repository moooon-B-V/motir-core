// THE RUN AREA'S ONE TIME FORMAT (MOTIR-3895).
//
// ⚠️ EXTRACTED BECAUSE IT WAS ABOUT TO BE TYPED A THIRD TIME. The same fixed
// `en-GB` / UTC `Intl.DateTimeFormat` had already been written twice — once on
// the server in `items/[key]/_components/runTimes.ts` (MOTIR-1796) and once on
// the client in `runs/_components/RunsIndex.tsx` (MOTIR-3923) — and the run
// modal needs it again. Three copies of one format is how a run's start time
// starts reading differently depending which surface you are on.
//
// ⚠️ NO `server-only` HERE, and that is the point: `runTimes.ts` carries the
// marker because it is a server module, but the FORMAT itself is a pure
// function of an ISO string and is exactly as correct on either side. That is
// what makes it safe to share — a client component formatting through this
// produces byte-for-byte what the server would, so there is nothing for
// hydration to disagree about.
//
// UTC, deliberately and visibly: a run's timestamps are written by a machine
// that may be anywhere, and a label silently rendered in the viewer's zone is a
// number they cannot check against the terminal they ran it in. Per-viewer local
// time is a real want and a separate one — it needs the shipped locale seam.

/**
 * `"29 Aug, 14:02 UTC"` — one run timestamp, identically on client and server,
 * in the reader's language (`7. Okt., 14:02 UTC` under `de`, MOTIR-7771). The
 * 24-hour clock is kept in every language with `hourCycle: 'h23'`: it is the
 * shape a terminal prints, so the label stays checkable against it.
 */
export function formatRunInstant(iso: string, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  });
  return `${time.format(new Date(iso))} UTC`;
}

/**
 * `"18m 04s"` — how long a FINISHED run took.
 *
 * ⚠️ ONLY FOR A RUN THAT HAS ENDED, and the signature says so by requiring both
 * ends. A live run's ELAPSED time is a different instrument: it ticks, so it
 * needs a clock, and a clock read during render is the hydration mismatch this
 * module exists to avoid. The run's own status pill already says it is running,
 * which is the fact a reader is actually after.
 */
export function formatRunDuration(startedAtIso: string, endedAtIso: string): string {
  const ms = new Date(endedAtIso).getTime() - new Date(startedAtIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m` : m > 0 ? `${m}m ${pad(s)}s` : `${s}s`;
}
