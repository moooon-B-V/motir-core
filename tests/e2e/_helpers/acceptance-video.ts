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

interface AcceptanceFixtures {
  /** Run a phase as a chaptered step; marks its start on the video timeline. */
  chapter: (label: string, body: () => Promise<void>) => Promise<void>;
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
    };

    await provide(chapter);

    // Sidecar next to the run's artifacts; the uploader globs for it.
    const file = path.join(testInfo.outputDir, 'chapters.json');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(chapters));
    await testInfo.attach('chapters', { path: file, contentType: 'application/json' });
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
