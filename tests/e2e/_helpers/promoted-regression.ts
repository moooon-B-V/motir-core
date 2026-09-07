import { test as base, expect } from '@playwright/test';

// The PROMOTED-SPEC fixture (Story MOTIR-2765 · Subtask MOTIR-2769).
//
// A spec promoted out of the acceptance lane keeps every assertion and loses the
// apparatus that existed to make a watchable RECORDING — the chaptering, the
// pacing holds, the story declaration. This module is that apparatus with the
// recording taken out: the same three fixture names and signatures
// `_helpers/acceptance-video` exports, so a promotion is a ONE-LINE import swap
// rather than a hand-edit of every `chapter()` and `beat()` in the file.
//
// ⚠️ WHY A SHIM RATHER THAN DELETING THE CALLS, recorded because "just strip
// them" is the obvious-looking alternative. The twelve specs promoted by
// MOTIR-2769 carry ~110 `chapter()` and ~150 `beat()` calls between them. Editing
// all of them by hand is ~260 opportunities to drop an assertion inside a
// `chapter()` body, in a diff whose size makes that invisible to a reviewer —
// and MOTIR-2769's own rule is that a promotion keeps every assertion, because a
// cleanup that quietly removes coverage is the failure mode it exists to
// prevent. The import swap cannot drop anything.
//
// What the shim actually removes:
//
//   chapter()  keeps the STEP (a `test.step` is free and makes the regression
//              report readable) and drops the CHAPTER_HOLD_MS hold and the
//              chapters.json sidecar. The label was always for a human watching.
//   beat()     becomes a no-op. It exists so a reviewer can see one action land;
//              nobody is watching a regression run. This is where the wall-clock
//              goes: BEAT_MS × ~150 calls is minutes per run, on every PR.
//   acceptanceStory()
//              becomes a no-op. A promoted spec publishes NO receipt — its story
//              already has a frozen one — and declaring a story it cannot write
//              to is exactly the confusion the lifecycle rule removes.
//
// The auto fixtures do NOT come across either: `clientDiagnostics` and
// `contention` write sidecars next to a video this lane does not record.
//
// A spec importing this belongs to a lane that runs on EVERY PR, so its red
// means a regression — which is the whole point of the promotion.
// See docs/decisions/acceptance-receipt-lifecycle.md §3 and
// docs/acceptance-lane-triage.md.
//
// ⚠️ WHICH OF THE TWO MODULES A SPEC MAY IMPORT IS ENFORCED, both ways
// (MOTIR-4751): `tests/e2e-acceptance-lane-imports.test.ts` reads this lane's
// `testMatch` out of `playwright.acceptance.config.ts` and fails a spec IN the
// lane that imports THIS module — it would record no chapters, no story and no
// receipt while passing — and a spec OUTSIDE it that imports
// `./acceptance-video`, which holds `CHAPTER_HOLD_MS` on every PR for a clip
// nobody publishes. The identical fixture names above are what make the
// promotion one line, and are also what make the mistake invisible to every
// other check; that guard is the one thing that sees it.

interface PromotedFixtures {
  /** Group a phase as a reported step. No hold — nothing is being watched. */
  chapter: (label: string, body: () => Promise<void>) => Promise<void>;
  /** Was per-action pacing for a viewer; a no-op here. */
  beat: () => Promise<void>;
  /** Was the receipt's target story; a promoted spec publishes nothing. */
  acceptanceStory: (storyKey: string) => void;
}

export const test = base.extend<PromotedFixtures>({
  chapter: async ({}, provide) => {
    await provide(async (label: string, body: () => Promise<void>) => {
      await test.step(label, body);
    });
  },
  beat: async ({}, provide) => {
    await provide(async () => {});
  },
  acceptanceStory: async ({}, provide) => {
    await provide(() => {});
  },
});

export { expect };

/** Re-exported so a promoted spec's import swap is genuinely ONE line.
 *
 *  `FIRST_PAINT_MS` is a plain timeout constant, not part of the recording
 *  apparatus — two of the promoted specs wait on it for a heavy route's first
 *  paint, which a regression lane needs exactly as much as a recording one. It is
 *  re-exported from its original home rather than copied, so there is still only
 *  one definition to change. */
export { FIRST_PAINT_MS } from './acceptance-video';
