import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

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
export const FIRST_PAINT_MS = 60_000;

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
