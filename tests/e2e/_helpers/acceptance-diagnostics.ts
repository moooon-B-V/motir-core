// The acceptance lane's client diagnostics — the PURE half, in its own module
// so it can be unit-tested. Two reports live here:
//
//   * the MOTIR-2600 FAILURE report (`buildClientDiagnostics`) — what a red run
//     leaves behind, and which of four causes the evidence supports;
//   * the MOTIR-2646 CONTENTION report (`buildContentionReport`) — the same
//     renderer signals read on EVERY navigation of EVERY run, pass or fail.
//
// It is separate from `acceptance-video.ts` for one reason: that file imports
// `@playwright/test` to extend the fixture set, and a vitest suite cannot pull
// the Playwright runner into its own process. The artifacts this lane leaves
// behind ARE the deliverable of both cards, so their shape needs a guard like
// any other shipped surface — see `tests/acceptance-video-diagnostics.test.ts`.
// The fixtures that FEED them (the page listeners, the renderer read, the
// in-page recorder, the attachments) live next door.

/**
 * How many of each kind of client event the failure buffer keeps (most recent
 * wins). A cap rather than the full stream: a 90 s acceptance test can emit
 * thousands of responses, and the diagnostic value is entirely in the tail
 * around the failure.
 */
export const DIAGNOSTIC_TAIL = 200;

/** One page-side event the failure report replays. */
export interface DiagnosticEvent {
  /** Seconds since the test's page was created — the video's own clock. */
  t: number;
  kind: 'console' | 'pageerror' | 'response' | 'requestfailed';
  text: string;
}

export interface ClientDiagnostics {
  card: string;
  test: string;
  status: string;
  error: string | null;
  /** What the renderer said about itself at the moment of failure. */
  page: Record<string, unknown>;
  console: DiagnosticEvent[];
  pageErrors: DiagnosticEvent[];
  /** The request ledger's TAIL — the last {@link DIAGNOSTIC_TAIL} responses and
   *  every failed request, in the order the page saw them. */
  requests: DiagnosticEvent[];
  /** The one-line reading a person should start from. */
  verdict: string;
}

/** What the recorder puts between a request's target and why it failed. */
const FAILURE_SEPARATOR = ' — ';

/** The error text the browser reports for a request it tore down itself. */
const CANCELLED = 'net::ERR_ABORTED';

/** An RSC payload request — what `next/link` prefetching actually asks for. */
const RSC_PAYLOAD = /[?&]_rsc=/;

/**
 * Split a `requestfailed` event's text back into what was requested and why it
 * failed. The recorder writes `METHOD URL — errorText`
 * (`acceptance-video.ts`); a text with no separator is treated as BOTH halves
 * so the caller's checks still see it — a format change makes the filter below
 * over-eager at worst, never silently inert.
 */
function splitFailure(text: string): { target: string; failure: string } {
  const at = text.lastIndexOf(FAILURE_SEPARATOR);
  return at === -1
    ? { target: text, failure: text }
    : { target: text.slice(0, at), failure: text.slice(at + FAILURE_SEPARATOR.length) };
}

/**
 * A cancelled RSC prefetch — ordinary page behaviour wearing a failure's
 * clothes (MOTIR-2643).
 *
 * `next/link` prefetches every link it can see and the browser routinely
 * cancels those requests, which Playwright reports as `requestfailed` with
 * `net::ERR_ABORTED`. On the capture's first live failure that produced NINE of
 * them in a 40 ms burst at t≈1.6 s, on a healthy docs page — enough for the
 * failed-request rung to pre-empt the idle-renderer rung and announce a network
 * cause for a strict-mode locator violation.
 *
 * So they are excluded from the TALLY that picks the verdict, and left in the
 * `requests` ledger untouched: the ledger is evidence, the tally is judgement.
 * The filter is deliberately narrow — aborted AND carrying an `_rsc` marker —
 * because `net::ERR_ABORTED` alone is not synonymous with harmless (a real
 * navigation torn down mid-flight reports it too).
 */
export function isCancelledRscPrefetch(event: DiagnosticEvent): boolean {
  if (event.kind !== 'requestfailed') return false;
  const { target, failure } = splitFailure(event.text);
  return failure.includes(CANCELLED) && RSC_PAYLOAD.test(target);
}

/**
 * Turn the captured buffers into the report that gets attached (MOTIR-2600).
 *
 * Pure, and exported, so the shape a failing lane leaves behind is asserted by
 * `tests/acceptance-video-diagnostics.test.ts` rather than only by staring at a
 * red run — the artifact IS the deliverable of this card's first half, so it
 * needs a guard like any other.
 *
 * The `verdict` line is the point. Three readings are separable from what is
 * captured, and naming which one the evidence supports is what stops the next
 * occurrence being re-derived from scratch:
 *   * a page error or a failed request in the tail → the client threw / a
 *     resource never arrived; the message names it. Cancelled RSC prefetches
 *     do NOT count as failures here — see {@link isCancelledRscPrefetch}.
 *   * no error, and the last response landed LONG before the failure → nothing
 *     was in flight: the transition is dead or the renderer was starved. This is
 *     the shape the 2026-08-10 recurrence had.
 *   * no error, and requests were still arriving → the page genuinely is slow,
 *     and the budget is the right lever after all.
 */
export function buildClientDiagnostics(input: {
  card: string;
  test: string;
  status: string;
  error?: string | null;
  page: Record<string, unknown>;
  console: DiagnosticEvent[];
  pageErrors: DiagnosticEvent[];
  requests: DiagnosticEvent[];
}): ClientDiagnostics {
  // The tally, not the ledger: a cancelled RSC prefetch stays in `requests`
  // below and is kept out of the count that chooses the verdict (MOTIR-2643).
  const failedRequests = input.requests.filter(
    (r) => r.kind === 'requestfailed' && !isCancelledRscPrefetch(r),
  );
  const idleMs = input.page['sinceLastResourceMs'];
  const verdict =
    input.pageErrors.length > 0
      ? `The page threw: ${input.pageErrors[input.pageErrors.length - 1]?.text ?? ''}`
      : failedRequests.length > 0
        ? `${failedRequests.length} request(s) failed; last: ${failedRequests[failedRequests.length - 1]?.text ?? ''}`
        : typeof idleMs === 'number' && idleMs >= 5_000
          ? `No request completed for ${Math.round(idleMs / 1000)}s before the failure — nothing was in ` +
            'flight, so this is a dead client transition or a starved renderer, NOT a slow page. ' +
            'Do not raise the timeout (MOTIR-2600).'
          : 'Requests were still arriving when the assertion expired — the page was doing work.';
  return {
    card: 'MOTIR-2600',
    test: input.test,
    status: input.status,
    error: input.error ?? null,
    page: input.page,
    console: input.console,
    pageErrors: input.pageErrors,
    requests: input.requests,
    verdict,
  };
}

// ── CONTENTION SAMPLING (MOTIR-2646) ─────────────────────────────────────────
//
// Everything above fires only when a test FAILS. This half fires always, and it
// exists because the failure it is about happens on ~1 run in 30.
//
// MOTIR-2621's census put the `/planning` stall at 2 occurrences in 57 runs, and
// its AC 3 asked for a remedy proposed against the LANE. A 3.5 % binary event
// cannot be A/B'd: detecting even a HALVING at that base rate needs on the order
// of a hundred runs per arm, so "change the lane, then prove it helped" is
// unbuildable and "change the lane and ship it" is a guess wearing a fix's
// clothes. Every previous step in this lineage took one of those two shapes.
//
// So the event is not what gets measured. The CONDITION behind it is. The
// renderer signals `buildClientDiagnostics` reads once, at the moment of a
// failure, are available on every navigation of every run; collected
// continuously they stop being one bit per run and become a distribution that
// moves with load. A remedy can then be judged in a handful of runs.
//
// FOUR SIGNALS, and they fail differently on purpose:
//
//   * `idleGapMs` — the longest stretch inside a navigation's window with no
//     resource completing. This is `sinceLastResourceMs` generalised: the
//     mcp-docs capture's 46 228 ms IS this quantity, read once. ⚠️ ON ITS OWN IT
//     DOES NOT WORK, and that is measured rather than feared — see the field's
//     own doc comment for the numbers. `CHAPTER_HOLD_MS` and `BEAT_MS` are
//     deliberate stretches of nothing, so this reads the hold schedule as
//     readily as the runner. Kept only so the two artifacts stay comparable.
//   * `idleToProbeMs` — the SAME measure with the pacing removed: the window
//     closes at the first probe after the navigation, which fires when the
//     chapter body ends and therefore BEFORE the hold. This is the headline, and
//     it still sees a stall (a dead transition holds its assertion open, so its
//     probe is a minute away and the gap says so).
//   * `longestTaskMs` / `blockingMs` — the Long Tasks API, windowed per
//     navigation. Immune to the holds (an idle main thread runs no tasks) and a
//     direct reading of the CPU contention that starvation would consist of.
//   * the drain's own `latencyMs` (`ContentionDrain`) — how long a trivial
//     `page.evaluate` took to round-trip. It is not a page metric at all: it
//     measures the whole path a Playwright assertion travels, main thread
//     included, and a starved renderer cannot answer it. Sampled at every hold,
//     it is the cheapest continuous proxy for the exact failure — a renderer
//     that will not run.
//
// None of the three is asserted on. The lane is a receipt (see
// `docs/decisions/acceptance-video.md`), so this records and never judges.

/** The Long Tasks API's threshold — a task at or over this is reported. */
export const LONG_TASK_MS = 50;

/** One navigation the in-page recorder marked. */
export interface ContentionNavigationMark {
  /** `document` — a full page load; `soft` — a client-side App Router transition. */
  kind: 'document' | 'soft';
  /** Path + search of where it landed; the host is constant and would only bulk the sidecar. */
  url: string;
  /** Page-relative ms (`performance.now()`) at which the navigation was marked. */
  atMs: number;
}

/** One main-thread task over {@link LONG_TASK_MS}, as the observer saw it. */
export interface ContentionTask {
  atMs: number;
  durationMs: number;
}

/**
 * One cumulative read of a single DOCUMENT's contention state.
 *
 * Cumulative rather than incremental, and keyed by `timeOrigin`, because that is
 * what makes a lost drain harmless: each read carries the document's whole life
 * so far, so the LATEST read per document is sufficient and nothing has to be
 * stitched. A document navigation starts a new origin and therefore a new
 * reading, which is how a hard navigation stops discarding what came before it.
 */
export interface ContentionReading {
  /** `performance.timeOrigin` — the document's identity, and its epoch. */
  timeOrigin: number;
  /** `performance.now()` at the moment of the read; the end of the last window. */
  nowMs: number;
  navigations: ContentionNavigationMark[];
  longTasks: ContentionTask[];
  /** Completion times (page-relative ms) of every resource the document fetched. */
  resourceEndsMs: number[];
  /** The resource-timing buffer filled — gaps recorded after that point are not real. */
  resourceBufferFull: boolean;
  /**
   * Page-clock instants at which this document has been PROBED — one per drain,
   * accumulated by the fixture across the document's life.
   *
   * ⚠️ This is what makes {@link ContentionSample.idleToProbeMs} possible, and it
   * is the whole reason the reading carries something the page cannot supply. A
   * drain fires when a chapter body ENDS, i.e. before the hold that follows it,
   * so the first probe after a navigation is the last moment that belongs to the
   * navigation's own work rather than to the lane's pacing.
   */
  probeAtMs: number[];
}

/** What one navigation cost, on a runner shared with four other tenants. */
export interface ContentionSample {
  url: string;
  kind: 'document' | 'soft';
  atMs: number;
  /** To the next navigation, or to the read that closed the document. */
  windowMs: number;
  /**
   * ⚠️ DOMINATED BY THE LANE'S OWN PACING — measured, not merely suspected.
   * Across the 82 navigations of this instrument's first real run, the soft
   * navigations' median gap was 4,046 ms (≈ `CHAPTER_HOLD_MS` + `BEAT_MS`) and
   * the worst was 35,885 ms with a 35,898 ms window — a recording that navigated
   * once and then held, on a run where nothing went wrong. That is the same
   * order as the 46,228 ms of the actual stall, so this number ALONE cannot tell
   * a stall from a healthy paced recording. Kept because it is the quantity the
   * failure report reads and the two must stay comparable; use
   * {@link idleToProbeMs} to judge anything.
   */
  idleGapMs: number;
  /**
   * THE DECONTAMINATED IDLE GAP: the same measure, but the window closes at the
   * first PROBE after the navigation instead of at the next navigation — so it
   * covers the navigation's own work and stops before the hold that follows.
   * This is the signal a lane remedy would move.
   */
  idleToProbeMs: number;
  /** How long that shortened window was, so a reader can see what it excluded. */
  windowToProbeMs: number;
  longestTaskMs: number;
  /** Σ(task − {@link LONG_TASK_MS}) over the window — the API's blocking time. */
  blockingMs: number;
  longTaskCount: number;
  resourcesTruncated: boolean;
}

/** One probe of whether the renderer could answer at all. */
export interface ContentionDrain {
  /** Wall-clock ISO, so a sample can be joined against the job log's own lines. */
  at: string;
  /** Seconds into the recording — the clock `chapter()` marks. */
  tSeconds: number;
  latencyMs: number;
  /** The probe exceeded its budget: the renderer did not answer. */
  timedOut: boolean;
}

export interface ContentionDistribution {
  count: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

export interface ContentionReport {
  card: string;
  test: string;
  status: string;
  /** How many navigations this recording contributed to the distribution. */
  navigations: number;
  /** ⚠️ Pacing-contaminated — see {@link ContentionSample.idleGapMs}. */
  idleGap: ContentionDistribution;
  /** The headline signal: the idle gap up to the navigation's own probe. */
  idleToProbe: ContentionDistribution;
  longestTask: ContentionDistribution;
  /** Over the drains that ANSWERED; the ones that did not are counted below. */
  drainLatency: ContentionDistribution;
  unresponsiveDrains: number;
  /** The navigation with the longest DECONTAMINATED gap — the run's closest approach. */
  worst: ContentionSample | null;
  samples: ContentionSample[];
  drains: ContentionDrain[];
}

/**
 * Nearest-rank percentile over a list of millisecond readings.
 *
 * Nearest-rank rather than interpolated because every consumer here is a tail
 * question ("how bad does it get"), and interpolation invents a value between
 * two real samples — which at n≈20 per recording is most of the answer.
 */
export function percentileMs(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

/** Median / p90 / max of one signal. An empty signal reports zeroes, not nulls. */
export function describeContention(values: number[]): ContentionDistribution {
  return {
    count: values.length,
    medianMs: percentileMs(values, 0.5),
    p90Ms: percentileMs(values, 0.9),
    maxMs: values.reduce((max, value) => Math.max(max, value), 0),
  };
}

/**
 * The longest stretch in `[start, end)` with no resource completing.
 *
 * The window's own edges anchor it: a navigation followed by nothing at all
 * reports the whole window, which is exactly the mcp-docs shape (the destination
 * payload landed, and then 46 s of nothing). Completions rather than starts,
 * matching `sinceLastResourceMs`, so the two numbers mean the same thing.
 */
function longestIdleGap(sortedEndsMs: number[], start: number, end: number): number {
  let previous = start;
  let longest = 0;
  for (const at of sortedEndsMs) {
    if (at <= start) continue;
    if (at >= end) break;
    longest = Math.max(longest, at - previous);
    previous = at;
  }
  return Math.round(Math.max(longest, end - previous));
}

/** Turn one document's cumulative reading into a sample per navigation. */
export function buildContentionSamples(reading: ContentionReading): ContentionSample[] {
  const ends = [...reading.resourceEndsMs].sort((a, b) => a - b);
  const marks = [...reading.navigations].sort((a, b) => a.atMs - b.atMs);
  const probes = [...reading.probeAtMs].sort((a, b) => a - b);
  return marks.map((mark, index) => {
    const start = mark.atMs;
    const end = Math.max(start, marks[index + 1]?.atMs ?? reading.nowMs);
    // The first probe strictly after the navigation, clamped into the window: a
    // navigation with no probe of its own (the spec ended, or two navigations
    // landed inside one chapter body) falls back to the full window, which is
    // the conservative direction — it over-reports rather than inventing a
    // shorter one.
    const probeEnd = Math.min(end, probes.find((at) => at > start) ?? end);
    const tasks = reading.longTasks.filter((task) => task.atMs >= start && task.atMs < end);
    return {
      url: mark.url,
      kind: mark.kind,
      atMs: start,
      windowMs: Math.round(end - start),
      idleGapMs: longestIdleGap(ends, start, end),
      idleToProbeMs: longestIdleGap(ends, start, probeEnd),
      windowToProbeMs: Math.round(probeEnd - start),
      longestTaskMs: tasks.reduce((max, task) => Math.max(max, task.durationMs), 0),
      blockingMs: Math.round(
        tasks.reduce((sum, task) => sum + Math.max(0, task.durationMs - LONG_TASK_MS), 0),
      ),
      longTaskCount: tasks.length,
      resourcesTruncated: reading.resourceBufferFull,
    };
  });
}

/** Assemble one recording's contention sidecar (MOTIR-2646). */
export function buildContentionReport(input: {
  test: string;
  status: string;
  /** One per DOCUMENT — the latest read of each, in any order. */
  readings: ContentionReading[];
  drains: ContentionDrain[];
}): ContentionReport {
  const samples = [...input.readings]
    .sort((a, b) => a.timeOrigin - b.timeOrigin)
    .flatMap(buildContentionSamples);
  const answered = input.drains.filter((drain) => !drain.timedOut);
  return {
    card: 'MOTIR-2646',
    test: input.test,
    status: input.status,
    navigations: samples.length,
    idleGap: describeContention(samples.map((sample) => sample.idleGapMs)),
    idleToProbe: describeContention(samples.map((sample) => sample.idleToProbeMs)),
    longestTask: describeContention(samples.map((sample) => sample.longestTaskMs)),
    drainLatency: describeContention(answered.map((drain) => drain.latencyMs)),
    unresponsiveDrains: input.drains.length - answered.length,
    // Ranked on the DECONTAMINATED gap: ranking on `idleGapMs` would nominate
    // whichever recording paced the longest, every time.
    worst: samples.reduce<ContentionSample | null>(
      (worst, sample) =>
        worst === null || sample.idleToProbeMs > worst.idleToProbeMs ? sample : worst,
      null,
    ),
    samples,
    drains: input.drains,
  };
}
