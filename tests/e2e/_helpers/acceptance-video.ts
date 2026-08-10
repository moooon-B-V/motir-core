import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildClientDiagnostics,
  DIAGNOSTIC_TAIL,
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
export const FIRST_PAINT_MS = 60_000;

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
}

export const test = base.extend<AcceptanceFixtures>({
  // `provide` is Playwright's fixture-value callback (normally named `use`); it
  // is renamed here so eslint's react-hooks rule doesn't mistake it for React's
  // `use` hook.
  chapter: async ({}, provide, testInfo) => {
    // t=0 is the fixture setup — as close to the recording start as the harness
    // can observe (the video begins at context creation, just before this).
    const start = Date.now();
    const chapters: Chapter[] = [];

    const chapter = async (label: string, body: () => Promise<void>): Promise<void> => {
      chapters.push({ label, tSeconds: Math.max(0, (Date.now() - start) / 1000) });
      await test.step(label, body);
      // Let the phase land before the next one starts. AFTER the body, so it
      // holds a state the body's own assertions already proved.
      await new Promise((resolve) => setTimeout(resolve, CHAPTER_HOLD_MS));
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

  beat: async ({ page }, provide) => {
    await provide(async () => {
      await page.waitForTimeout(BEAT_MS);
    });
  },

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
