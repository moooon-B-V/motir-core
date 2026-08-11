import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildClientDiagnostics,
  buildContentionReport,
  DIAGNOSTIC_TAIL,
  type ContentionDrain,
  type ContentionReading,
  type DiagnosticEvent,
} from './acceptance-diagnostics';

// The acceptance-video test harness (Story MOTIR-1627 · Subtask MOTIR-1632).
// Extends the Playwright test with a `chapter(label, body)` step that BOTH runs
// a `test.step` (for the trace/report) AND records a `{ label, tSeconds }`
// marker on the recording timeline. On teardown the markers are written to a
// `chapters.json` sidecar in the test's outputDir + attached to the report, so
// the uploader (`scripts/upload-acceptance-video.mjs`) can ship them to the
// publish endpoint alongside the video.
//
// The acceptance spec (MOTIR-1638) imports { test, expect } from here instead of
// '@playwright/test' and wraps each user-visible phase in `chapter(...)`.

export interface Chapter {
  label: string;
  tSeconds: number;
}

// ── Pacing: the recording is for a HUMAN (MOTIR-1772) ────────────────────────
//
// ⚠️ THE `waitForTimeout` BAN IN CLAUDE.md STILL HOLDS IN FULL. That rule
// forbids sleeping to WAIT FOR STATE, and nothing here does: a hold is only ever
// taken AFTER the spec's own authoritative signal has already proven the state
// (`waitForResponse` on a write, `expect(...)` on the rendered result). Remove
// every hold and the assertions are unchanged — a hold cannot mask a race
// because it never stands in for one. Do not "fix" this by deleting it.
//
// It exists because this lane's output is a VIDEO a person watches to accept a
// Story (Principle #18). Driven at machine speed a full five-phase Story flow
// finishes in ~5 seconds with every chapter stacked inside the first four —
// green, and useless as evidence (MOTIR-921, the incident this came from).
//
// Pacing lives HERE, on `chapter()`, and not in each spec, because `chapter()`
// is the one call an acceptance spec cannot skip: it is what produces the
// timeline markers, so a spec that wants chapters is paced whether or not its
// author thought about it. Opt-in pacing would rot on the first spec written by
// someone who had not read this comment.

/** Held after each chapter, so a viewer can take in the phase that just ran. */
export const CHAPTER_HOLD_MS = 2_500;

/** Held by an explicit `beat()` — one user-visible action's worth of screen time. */
export const BEAT_MS = 4_000;

// ── The FIRST-PAINT budget (MOTIR-2506) ─────────────────────────────────────
//
// ⚠️ THIS IS A TIMEOUT, NOT A HOLD, and it is the opposite of the two above: it
// bounds how long an assertion MAY wait, and nothing ever sleeps for it. It
// exists because this lane's failures are not slow code — they are transient
// runner stalls landing on whichever test is unlucky.
//
// MEASURED (2026-08-09, PR #1980's three runs plus a local prod-build run):
//   * the planning workspace's first paint is SUB-SECOND locally — the whole
//     "Plan with AI opens the workspace" chapter is 4,981 ms, of which 4,000 is
//     its own deliberate `beat()`;
//   * a PASSING CI run is comparable to (in fact faster than) local — 26.9 s for
//     the whole plan-change test against 36.8 s locally;
//   * yet two different planning specs blew the config's default 20 s `expect`
//     timeout on the FIRST landmark after landing on `/planning`, on consecutive
//     runs of the SAME commit.
//
// A uniform slowdown would fail the same test every time and would show up in
// the median. A stall shows up exactly like this. So the budget is set far above
// any plausible real paint rather than a little above the observed one: at 60 s
// it is ~60x the measured paint, which rides out a stall while still failing a
// page that genuinely never renders — the assertion keeps its meaning, it just
// stops being a stopwatch on the runner's mood.
//
// ⚠️ USE IT ONLY FOR A FIRST LANDMARK AFTER A NAVIGATION. Once one landmark is
// up the page has rendered and its siblings resolve instantly, so a second
// assertion carrying this budget would be hiding a real regression behind a
// minute of patience. `MOTIR-1682` is the precedent for the shape (and the
// warning that a bigger number alone did not cure ITS cause, an on-demand
// compile this lane no longer has — see MOTIR-2506 for why sharding, not a
// bigger number, is the structural answer if this recurs).
//
// ── WHAT THE STALL ACTUALLY IS (MOTIR-2600, from the trace of the recurrence) ──
//
// It recurred AT 60 s (2026-08-10, PR #1999 attempt 1, job 93452609448), and the
// failed test's own trace says the budget was never the constraint. Reading it
// back, request by request:
//
//   * the RSC payload for the very navigation that "never painted" —
//     `/planning?mode=contextual&from=work-item&item=ARP-4&_rsc=…` — returned
//     **200 in 7.5 ms**, and the route's last three JS chunks in 18–21 ms each;
//   * of the 140 requests the page made in the whole test, **one** ever failed,
//     and it was a `_next/static` chunk 25 minutes earlier, not on this route;
//   * after those chunks the browser issued **no network activity at all** for
//     the entire 60 s, and the failure screenshot is a **blank white page** —
//     not even `app/(planning)/loading.tsx`'s skeleton, whose grey blocks would
//     be plainly visible. The a11y tree held two things: Radix's empty toast
//     viewport and Next's route announcer, both from the ROOT layout.
//
// So the page is not slow and the server is not stalling: the RSC payload and
// the code both ARRIVED, and the client-side App Router transition then never
// committed anything — not the segment, not its own loading boundary. A timeout
// cannot cure that, which is why raising this number a third time is forbidden
// on MOTIR-2600 rather than merely discouraged: at 60 s the assertion already
// waits ~60x the measured paint and the page is not painting at ANY number.
//
// What the trace canNOT discriminate is *why* React never committed — a thrown
// exception during chunk evaluation and a renderer starved of CPU by the
// runner's other tenants look identical once you only have "no network, no
// paint". The lane keeps no console output, no `pageerror`, and no renderer-side
// timing, so both readings survive. Closing that gap is what the
// `clientDiagnostics` fixture below now does: the next occurrence lands with the
// console, the page errors, the request ledger and the renderer's own clock
// attached to the failure, and is READ rather than re-derived.
//
// ── WHAT THE CAPTURE THEN SAID (MOTIR-2621, read 2026-08-11) ──
//
// It was read, and the first thing it establishes is that **this failure is not
// `/planning`'s**. The occurrence carrying the discriminating evidence landed on
// `acceptance-mcp-docs.spec.ts` — a PUBLIC docs route, no session, no planning
// code, no `motir-ai` on any path — and it carries the same IDLE-RENDERER
// SIGNATURE (runs 31438023288 and 31440555516, the identical shape twice):
//
//   * the destination's RSC payload — `/docs/mcp/tools?_rsc=…` — arrived 200 in
//     8-21 ms, at t=7.4 s;
//   * then **46.2 s with no network event at all**, `readyState: 'complete'`;
//   * `pageErrors: []` and `console: []` — and those are MEASUREMENTS, not gaps
//     in instrumentation: the same fixture recorded 2 console entries on the
//     `cli-connect` failures in the same run;
//   * ZERO genuinely failed requests once cancelled `_rsc` prefetches are
//     excluded (MOTIR-2643 — see below);
//   * the URL never advanced and `bodyText` is still the ORIGIN page's.
//
// So the client router fetched the destination payload and then committed
// nothing — on a route that shares none of `/planning`'s suspects. Whatever this
// is, it is a property of client-side navigation under this runner, not of the
// planning workspace. `/planning` is where we happened to look first, because it
// is the slowest-looking surface and the one with a plausible story.
//
// ⚠️ "The same failure exactly" was one step too strong, and MOTIR-2646 walked
// it back (this note said it, so this note corrects it). The two occurrences are
// not identical in what the CLIENT DID: on `/planning` the URL HAD advanced —
// `waitForURL` resolved — and the screenshot was blank, whereas on `mcp-docs`
// the URL NEVER advanced and the origin page was still fully painted. One cause
// remains plausible for both (Next advances the URL optimistically only for a
// destination it has already prefetched, so the same dead commit shows a
// different address bar depending on prefetch state), but plausible is what it
// is. What IS shared, and is what the paragraph above rests on, is the
// idle-renderer signature: payload in, then nothing, with no error on any
// channel. Do not carry "identical" forward as a finding.
//
// The two readings are now unequal rather than settled. An uncaught throw is
// DISFAVOURED — the `pageerror` channel demonstrably works and stayed empty —
// but not excluded, since a throw swallowed inside React's own error handling
// never reaches it. Starvation fits everything observed: 4 vCPU hosting
// `next start`, Inngest, Postgres and Playwright, and a main thread that never
// runs the commit. What has NOT been shown is a defect in any route's code.
//
// ⚠️ The corollary for whoever reads a future `client-diagnostics.json`: BEFORE
// MOTIR-2643 all five captures taken on 2026-08-10 reported "N request(s)
// failed" and named a URL, because `next/link` prefetch cancellations were
// counted in the tally. That LINE was wrong on every one of them; the VERDICT
// changed on the two `mcp-docs` captures, where excluding the cancelled
// prefetches leaves zero genuine failures and promotes the idle-renderer rung
// that matters here. The `cli-connect` capture from the same run recomputes to a
// failed-request verdict either way — it carries 2 real failures on
// `/api/ai/pre-plan`. So: if you are reading an artifact from before that fix,
// recompute the verdict — do not quote it. (MOTIR-2646 narrowed this from "that
// verdict was wrong on every one of them", which over-claimed the same way the
// line it was correcting did.)
export const FIRST_PAINT_MS = 60_000;

// ── THE LANE REMEDY, AND THE INSTRUMENT IT IS ARGUED FROM (MOTIR-2646) ───────
//
// Everything above this line is a diagnosis, and MOTIR-2621 closed it: the stall
// is not a route's defect. Its AC 3 then asked for a remedy proposed against the
// LANE — fewer concurrent tenants during a navigation — and that is what this
// section owes. It is deliberately placed HERE, beside the budget, because the
// budget is the lever everyone reaches for first and this is the argument for
// not reaching for it again.
//
// ⚠️ WHY THE OBVIOUS CARD SHAPE IS UNBUILDABLE. The census is 2 occurrences in
// 57 runs, ≈3.5 %. Detecting even a HALVING of a 3.5 % binary event at any
// respectable confidence takes on the order of a hundred runs per arm. So
// "change the lane, then prove it helped" cannot be executed, and "change the
// lane and ship it" is what produced the two earlier wrong conclusions this note
// records. Both shapes were refused.
//
// What is built instead is the INSTRUMENT: `contentionSamples` below reads the
// same renderer signals on every navigation of every run, so the lane reports a
// distribution rather than one bit. `acceptance-diagnostics.ts`'s CONTENTION
// SAMPLING header carries the three signals and why they fail differently. The
// per-run sidecar is `contention.json`, beside `chapters.json`.
//
// ── THE CANDIDATES, AND WHAT EACH WOULD COST ─────────────────────────────────
//
// None of these is pre-selected; the samples decide, and "the change already
// made was enough" is an acceptable ending.
//
//   * THE 4-WAY SHARD, ALREADY LANDED (MOTIR-2600). It cut a ~30-minute serial
//     lane into four legs — and its effect on CONTENTION has never been
//     measured, because it landed before anything measured contention. Note that
//     its sign is not obvious: fewer specs per leg means less time per machine,
//     but each leg still hosts `next start` + Inngest + Postgres + Playwright on
//     its own 4 vCPU, so per-navigation contention need not have moved at all.
//     Cost: zero, it is already paid.
//   * QUIESCING THE INNGEST DEV SERVER for specs that never enqueue. It is one
//     of the five tenants and the job log shows it bursting. Cost: a config
//     change plus the risk of a spec that enqueues something nobody noticed.
//   * A LARGER RUNNER. Probably effective, and it is the tempting shortcut this
//     card exists to refuse until there is a number: it costs money on EVERY run
//     forever, and GitHub's larger runners are not free minutes (see
//     `github-runner-group-and-labels-facts`). Cost: recurring, and unbounded in
//     the number of runs.
//   * STAGGERING TENANT SEEDING away from navigations. Cost: harness complexity
//     in the seeds, and it only helps if the samples show seeding and stalls
//     coinciding — which is exactly what `ContentionDrain.at` exists to let a
//     reader check against the job log.
//
// Any of these that turns out to need a real change ships as ITS OWN card. This
// one produces the reading and the proposal.
//
// ── WHAT THE SAMPLES SAID ────────────────────────────────────────────────────
//
// (Filled from this PR's own lane runs — see the PR body for the full tables.)

/**
 * How long the contention probe may wait for the renderer to answer.
 *
 * ⚠️ THIS NUMBER IS WHAT MAKES THE SAMPLING FREE, and it is why it is strictly
 * below {@link CHAPTER_HOLD_MS}. Every drain runs CONCURRENTLY with a hold the
 * lane was already taking, so the hold dominates and a passing run's wall clock
 * is unchanged. A probe that exceeds this is abandoned — and counted, because a
 * renderer that cannot answer a trivial `evaluate` in two seconds is the very
 * condition being measured, not an error.
 */
export const CONTENTION_SAMPLE_BUDGET_MS = 2_000;

/**
 * The in-page recorder, installed before the first navigation of every document.
 *
 * ⚠️ IT MUST NOT CHANGE WHAT IT MEASURES (the receipt-lane constraint in
 * `docs/decisions/acceptance-video.md`). What it does: pushes onto two capped
 * arrays, widens the resource-timing buffer, and wraps `history.pushState` /
 * `replaceState` in a passthrough that calls the original FIRST and returns its
 * result unchanged. It adds no listener the app can observe, no assertion, and
 * no wait. The `pushState` wrapper is the one app-visible mutation and it is a
 * mark, not a policy — Next's App Router is what calls it, and a soft navigation
 * is otherwise invisible from the page's own clock.
 */
const CONTENTION_RECORDER = () => {
  const KEY = '__motirContention';
  const scope = window as unknown as Record<string, unknown>;
  if (scope[KEY]) return;
  const state = {
    navigations: [] as { kind: 'document' | 'soft'; url: string; atMs: number }[],
    longTasks: [] as { atMs: number; durationMs: number }[],
    resourceBufferFull: false,
  };
  scope[KEY] = state;

  const mark = (kind: 'document' | 'soft') => {
    // Capped: a runaway router loop must not turn the sidecar into the artifact.
    if (state.navigations.length >= 500) return;
    state.navigations.push({
      kind,
      url: location.pathname + location.search,
      atMs: Math.round(performance.now()),
    });
  };
  mark('document');

  const history = window.history as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      mark('soft');
      return result;
    };
  }
  window.addEventListener('popstate', () => mark('soft'));

  // The default buffer is 250 entries and the browser SILENTLY STOPS RECORDING
  // once it fills — which would make every gap after that point a fiction, and
  // (worse) would have been quietly distorting `sinceLastResourceMs` in the
  // failure report above. Widened, and the overflow recorded rather than hidden.
  window.addEventListener('resourcetimingbufferfull', () => {
    state.resourceBufferFull = true;
  });
  try {
    performance.setResourceTimingBufferSize(3_000);
  } catch {
    // A browser without the setter keeps the default; the flag above still tells
    // the reader when that default was reached.
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (state.longTasks.length >= 1_000) return;
        state.longTasks.push({
          atMs: Math.round(entry.startTime),
          durationMs: Math.round(entry.duration),
        });
      }
      // `buffered` picks up tasks from before this observer existed.
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // `longtask` is Chromium-only. Without it the idle-gap and drain-latency
    // signals still work; only the CPU one goes quiet.
  }
};

/**
 * Read one document's whole contention state. Cumulative and non-destructive —
 * see {@link ContentionReading} for why that is what makes a lost drain
 * harmless.
 */
const CONTENTION_READER = () => {
  const state = (window as unknown as Record<string, unknown>)['__motirContention'] as
    | {
        navigations: { kind: 'document' | 'soft'; url: string; atMs: number }[];
        longTasks: { atMs: number; durationMs: number }[];
        resourceBufferFull: boolean;
      }
    | undefined;
  if (!state) return null;
  return {
    timeOrigin: performance.timeOrigin,
    nowMs: Math.round(performance.now()),
    navigations: state.navigations,
    longTasks: state.longTasks,
    resourceEndsMs: performance
      .getEntriesByType('resource')
      .map((entry) => Math.round(entry.startTime + entry.duration)),
    resourceBufferFull: state.resourceBufferFull,
  };
};

// The failure report itself is `./acceptance-diagnostics` — pure, and unit-tested
// there. What lives here is the fixture that FEEDS it.
export * from './acceptance-diagnostics';

interface AcceptanceFixtures {
  /** Run a phase as a chaptered step; marks its start on the video timeline. */
  chapter: (label: string, body: () => Promise<void>) => Promise<void>;
  /**
   * Hold the frame for one user-visible action (MOTIR-1772).
   *
   * `chapter()` already paces each PHASE; call this for per-action pacing inside
   * a phase, where a reviewer needs to see each individual step land (a toggle
   * flipping, a value being typed, a dock opening). Pacing, never
   * synchronisation — see the note at {@link CHAPTER_HOLD_MS}.
   */
  beat: () => Promise<void>;
  /**
   * Declare which STORY this recording accepts (MOTIR-1684). The uploader
   * publishes the clip to THIS story — so the self-test dogfood pins itself to
   * MOTIR-1627 and a per-story acceptance spec pins itself to its own story,
   * regardless of the PR that triggered the run. Writes an
   * `acceptance-story.json` sidecar next to `chapters.json` in the test's
   * outputDir; the uploader reads it as the top-precedence target (over the
   * PR-derived key). Call once, in the recorded happy-path test.
   */
  acceptanceStory: (storyKey: string) => void;
  /**
   * AUTO fixture — nothing calls it (MOTIR-2600). It listens on the page for the
   * whole test and, when the test FAILS, writes `client-diagnostics.json` beside
   * the video and attaches it to the report.
   *
   * Auto, and on every test rather than on the first-paint assertion alone,
   * because the stall it exists for "lands on whichever test happens to be
   * running" — a capture wired only into the one helper that carries
   * {@link FIRST_PAINT_MS} would miss the next occurrence the moment it lands on
   * a spec that reaches `/planning` some other way.
   */
  clientDiagnostics: void;
  /**
   * AUTO fixture (MOTIR-2646) — installs the in-page contention recorder and
   * drains it, writing a `contention.json` sidecar on EVERY run, pass or fail.
   *
   * It hands back a `sample()` the pacing helpers call inside the holds they
   * were already taking, which is what makes it free: see
   * {@link CONTENTION_SAMPLE_BUDGET_MS}. Nothing else should call it — a drain
   * outside a hold would be the one thing this must never do, which is cost a
   * passing run wall-clock time.
   */
  contention: ContentionRecorder;
}

interface ContentionRecorder {
  /** Drain the page's buffer. Bounded, never throws, safe to run inside a hold. */
  sample: () => Promise<void>;
}

export const test = base.extend<AcceptanceFixtures>({
  // `provide` is Playwright's fixture-value callback (normally named `use`); it
  // is renamed here so eslint's react-hooks rule doesn't mistake it for React's
  // `use` hook.
  chapter: async ({ contention }, provide, testInfo) => {
    // t=0 is the fixture setup — as close to the recording start as the harness
    // can observe (the video begins at context creation, just before this).
    const start = Date.now();
    const chapters: Chapter[] = [];

    const chapter = async (label: string, body: () => Promise<void>): Promise<void> => {
      chapters.push({ label, tSeconds: Math.max(0, (Date.now() - start) / 1000) });
      await test.step(label, body);
      // Let the phase land before the next one starts. AFTER the body, so it
      // holds a state the body's own assertions already proved.
      //
      // The contention drain (MOTIR-2646) rides ALONGSIDE the hold rather than
      // before or after it: its budget is strictly below CHAPTER_HOLD_MS, so
      // `Promise.all` finishes when the hold does and the recording's pace is
      // arithmetically unchanged.
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, CHAPTER_HOLD_MS)),
        contention.sample(),
      ]);
    };

    await provide(chapter);

    // Sidecar next to the run's artifacts; the uploader globs for it.
    const file = path.join(testInfo.outputDir, 'chapters.json');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(chapters));
    await testInfo.attach('chapters', { path: file, contentType: 'application/json' });

    // How long the recording actually ran. The uploader's watchability guard
    // (MOTIR-1772) needs the TOTAL, which the chapter markers alone cannot give:
    // a marker is a START offset, so a single-chapter recording's last marker is
    // ~0 no matter how long the clip is. Its own sidecar, so `chapters.json`
    // keeps the exact array shape the publish endpoint already consumes.
    // `specFile` (MOTIR-1937) — the repo-relative path of the spec that produced
    // this recording, so the uploader can match a recording back to the PR that
    // OWNS it. Publishing supersedes a story's current evidence, so a run must
    // only publish the receipts for specs it actually changed; without this the
    // only key available was the recording's declared STORY, which every run
    // resolves identically no matter whose branch it is on.
    const metaFile = path.join(testInfo.outputDir, 'recording-meta.json');
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        totalSeconds: Math.max(0, (Date.now() - start) / 1000),
        specFile: path.relative(process.cwd(), testInfo.file),
      }),
    );
    await testInfo.attach('recording-meta', { path: metaFile, contentType: 'application/json' });
  },

  beat: async ({ page, contention }, provide) => {
    await provide(async () => {
      // Same free-riding arrangement as `chapter()` above: the drain's budget is
      // well under BEAT_MS, so the beat's own hold is what times this out.
      await Promise.all([page.waitForTimeout(BEAT_MS), contention.sample()]);
    });
  },

  contention: [
    async ({ page }, provide, testInfo) => {
      // Before any navigation — an init script installed later would miss the
      // document the test starts on, which is the one every spec navigates FROM.
      await page.addInitScript(CONTENTION_RECORDER);

      const t0 = Date.now();
      /** Latest cumulative reading PER DOCUMENT, keyed by its `performance.timeOrigin`. */
      const readings = new Map<number, ContentionReading>();
      const drains: ContentionDrain[] = [];

      const sample = async (): Promise<void> => {
        const startedAt = Date.now();
        // `page.evaluate` has no per-call timeout, and the failure being measured
        // is precisely a renderer that never answers — so the budget is enforced
        // here. A `.catch` on the evaluate rather than a try/catch around the
        // race: the abandoned call settles later (when the page closes, usually
        // as a rejection) and must not surface as an unhandled rejection.
        const reading = await Promise.race([
          page.evaluate(CONTENTION_READER).catch(() => null),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), CONTENTION_SAMPLE_BUDGET_MS),
          ),
        ]);
        const drain: ContentionDrain = {
          at: new Date(startedAt).toISOString(),
          tSeconds: Math.max(0, (startedAt - t0) / 1000),
          latencyMs: Date.now() - startedAt,
          timedOut: reading === null,
        };
        drains.push(drain);
        if (reading !== null) readings.set(reading.timeOrigin, reading);
      };

      await provide({ sample });

      // The last window closes here — the drains above are per-hold, and a spec's
      // final navigation is usually followed by an assertion and then teardown.
      // This fixture depends on `page`, so the page is still open.
      await sample();

      const report = buildContentionReport({
        test: testInfo.titlePath.join(' › '),
        status: testInfo.status ?? 'unknown',
        readings: [...readings.values()],
        drains,
      });
      // A test that never navigated (or never held) contributes nothing, and an
      // empty sidecar in every output dir is noise the uploader would have to
      // walk past.
      if (report.navigations === 0 && report.drains.length === 0) return;

      const file = path.join(testInfo.outputDir, 'contention.json');
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
      await testInfo.attach('contention', { path: file, contentType: 'application/json' });

      // ⚠️ AND ONE LINE IN THE JOB LOG — this is not a convenience, it is what
      // makes the instrument USABLE. The sidecar rides in the report artifact
      // alongside the videos, and this lane's four shard artifacts are ~1.5 GB;
      // reading a distribution out of them means a multi-minute download per
      // shard, which is enough friction that nobody will do it on a green run —
      // and a green run is precisely when this must be read. The log is where a
      // reader already is, `gh api …/logs` is one call, and the whole summary
      // fits on a line. `warn` for the same reason `clientDiagnostics` uses it:
      // `log` is the one console method this repo's lint config forbids.
      console.warn(
        `[acceptance-video] MOTIR-2646 contention — navs=${report.navigations} ` +
          `idleGap med/p90/max=${report.idleGap.medianMs}/${report.idleGap.p90Ms}/${report.idleGap.maxMs}ms ` +
          `longestTask med/p90/max=${report.longestTask.medianMs}/${report.longestTask.p90Ms}/${report.longestTask.maxMs}ms ` +
          `drainLatency med/p90/max=${report.drainLatency.medianMs}/${report.drainLatency.p90Ms}/${report.drainLatency.maxMs}ms ` +
          `unresponsive=${report.unresponsiveDrains}/${report.drains.length} ` +
          `worst=${report.worst ? `${report.worst.idleGapMs}ms@${report.worst.kind}:${report.worst.url}` : 'none'}`,
      );
    },
    { auto: true },
  ],

  clientDiagnostics: [
    async ({ page }, provide, testInfo) => {
      const t0 = Date.now();
      /** Seconds since this page was created — the same clock `chapter()` marks. */
      const at = () => Math.round(Date.now() - t0) / 1000;
      const consoleEvents: DiagnosticEvent[] = [];
      const pageErrors: DiagnosticEvent[] = [];
      const requests: DiagnosticEvent[] = [];
      const push = (list: DiagnosticEvent[], event: DiagnosticEvent) => {
        list.push(event);
        if (list.length > DIAGNOSTIC_TAIL) list.shift();
      };

      page.on('console', (message) =>
        push(consoleEvents, {
          t: at(),
          kind: 'console',
          text: `[${message.type()}] ${message.text()}`.slice(0, 500),
        }),
      );
      page.on('pageerror', (error) =>
        push(pageErrors, {
          t: at(),
          kind: 'pageerror',
          text: `${error.message}\n${error.stack ?? ''}`.slice(0, 2_000),
        }),
      );
      page.on('requestfailed', (request) =>
        push(requests, {
          t: at(),
          kind: 'requestfailed',
          text: `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown failure'}`,
        }),
      );
      page.on('response', (response) =>
        push(requests, {
          t: at(),
          kind: 'response',
          text: `${response.status()} ${response.request().method()} ${response.url()}`,
        }),
      );

      await provide();

      // Green run: nothing to say, and nothing written into the recording dir
      // the uploader walks.
      if (testInfo.status === testInfo.expectedStatus) return;

      // The RENDERER's own account of itself, read while the page is still open
      // (this fixture depends on `page`, so it tears down first). Wrapped
      // because a crashed or closed page is exactly one of the outcomes being
      // diagnosed — an unavailable evaluate is itself a finding, not a reason to
      // lose the rest of the report.
      let pageState: Record<string, unknown>;
      try {
        pageState = await page.evaluate(() => {
          const resources = performance.getEntriesByType('resource');
          const last = resources[resources.length - 1];
          return {
            url: location.href,
            readyState: document.readyState,
            visibility: document.visibilityState,
            bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
            // THE DISCRIMINATOR. A page that is merely late still has requests
            // landing; a dead transition or a starved renderer leaves a silent
            // tail, and its length is how long nothing at all happened.
            sinceLastResourceMs: last
              ? Math.round(performance.now() - (last.startTime + last.duration))
              : null,
            resourceCount: resources.length,
            lastResources: resources.slice(-10).map((entry) => ({
              name: entry.name,
              startMs: Math.round(entry.startTime),
              durationMs: Math.round(entry.duration),
            })),
          };
        });
      } catch (err) {
        pageState = { unavailable: String(err) };
      }

      const report = buildClientDiagnostics({
        card: 'MOTIR-2600',
        test: testInfo.titlePath.join(' › '),
        status: testInfo.status ?? 'unknown',
        error: testInfo.error?.message ?? null,
        page: pageState,
        console: consoleEvents,
        pageErrors,
        requests,
      });

      const file = path.join(testInfo.outputDir, 'client-diagnostics.json');
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
      await testInfo.attach('client-diagnostics', { path: file, contentType: 'application/json' });
      // Also in the job log: that is the one place a reader is already looking
      // when the check goes red, and it costs one line. `warn` rather than `log`
      // because a failed test's cause is not chatter — and because `log` is the
      // one console method this repo's lint config does not allow.
      console.warn(`[acceptance-video] MOTIR-2600 diagnostics — ${report.verdict}`);
    },
    { auto: true },
  ],

  acceptanceStory: async ({}, provide, testInfo) => {
    let declared: string | null = null;
    await provide((storyKey: string) => {
      declared = storyKey;
    });
    // On teardown, persist the declared story next to the video (same dir as
    // chapters.json) so the uploader publishes the clip to THIS story.
    if (declared) {
      const file = path.join(testInfo.outputDir, 'acceptance-story.json');
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ storyKey: declared }));
      await testInfo.attach('acceptance-story', { path: file, contentType: 'application/json' });
    }
  },
});

export { expect };
