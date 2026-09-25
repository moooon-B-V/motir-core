import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-6184 — the surface-views asset's CHROME COPY, read against the catalogue
// rather than against a literal.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// The first version of `plan-review--surface-views.mock.html` composed the
// planning surface's own chrome — the Close + project bar and the RESTING FOOTER
// — by copying the class strings out of `PlanningWorkspaceHost.tsx` and then
// TYPING the text. The class strings were right and the text was invented: the
// footer read *"Ask for a change"* / *"Asking writes nothing — you will see the
// plan before anything is created."* where the shipped strings are
// `planningWorkspace.footerRestingTitle` / `footerRestingBody`, *"Roadmap — as
// saved"* / *"Nothing proposed. The conversation has changed nothing."*.
//
// It shipped in a published design result and was caught by a human reading the
// asset. Every guard in the design lane was green over it, because every guard
// in the design lane asks about COLOUR, SHAPE, structure or a dead rule — none of
// them reads a string.
//
// ── Why a guard and not a careful edit ──────────────────────────────────────
// A mock is product COPY, in the register it will ship in, and the invented pair
// was worse than merely wrong: it read as a call to action, which is exactly what
// that footer must not do (`PlanningWorkspaceHost.tsx`: *"deliberately quiet …
// so it never competes with the gate or reads as something to act on"*). A later
// card building to the asset would have transcribed it.
//
// Nothing mechanically ties a mock's copy to a message catalogue — the mock is
// HTML, the catalogue is JSON, and the only thing keeping them in agreement is
// whoever last edited both. Repairing this by hand and stopping would leave the
// next author to rediscover it. Same reasoning, and same shape, as
// `design-lesson-phase-chips` (MOTIR-5107) and `design-github-development-copy`
// (MOTIR-5152).
//
// ── What this asserts, and what it deliberately does not ────────────────────
// Every string below is read OUT of `messages/en.json`; this spec hard-codes
// none of them, so a rename that moves the catalogue moves the requirement with
// it and a rename that moves only one of the two fails here. It does not assert
// how MANY panels draw the footer — sheets may be added or removed — only that
// each string the surface's chrome renders appears in the asset, and that the
// retired invented copy never comes back.

const ROOT = process.cwd();
const MOCK = join(ROOT, 'design/ai-planning/plan-review--surface-views.mock.html');
const MESSAGES = join(ROOT, 'messages/en.json');

/**
 * The copy the asset INVENTED, which must not come back to the board.
 *
 * It gets its own assertion rather than being left to the first one: *"the
 * footer's title is not a catalogue string"* is true but unhelpful, and a reader
 * meeting this wants to be told the text was made up and where the real one is.
 */
const INVENTED = ['Ask for a change', 'Asking writes nothing'] as const;

/** The `planningWorkspace` keys whose text the surface's own chrome renders. */
const CHROME_KEYS = ['close', 'escKey'] as const;

/**
 * ⚠️ `footerRestingTitle` / `footerRestingBody` are NOT in `CHROME_KEYS`, and
 * their ABSENCE is asserted instead (Part XXI 21.8).
 *
 * They were, until the review round that found the invented copy. The decision
 * that followed is that **when there is nothing to show in the footer, the footer
 * hides**: with no proposal there is no slot at all and the canvas runs to the
 * pane's bottom edge.
 *
 * That is only safe because 21.8 also moves the bar from a `shrink-0` SIBLING of
 * the `min-h-0 flex-1` canvas box to an OVERLAY on its bottom edge. As a sibling,
 * a slot that came and went resized the box and slid the three control clusters
 * anchored to its bottom — bug MOTIR-1815, whose shipped fix was the always-there
 * resting footer. As an overlay the box is always full height, the clusters carry
 * a permanent inset, and nothing moves in either direction.
 *
 * Asserting the absence rather than simply dropping the keys is the point: an
 * un-asserted removal and an accidental re-add look identical in a later diff,
 * and the obvious "fix" for a pane with no foot is to put the old line back.
 */
const REMOVED_KEYS = ['footerRestingTitle', 'footerRestingBody'] as const;

const mock = readFileSync(MOCK, 'utf8');
const messages = JSON.parse(readFileSync(MESSAGES, 'utf8')) as {
  planningWorkspace: Record<string, string>;
};

/** `&`, `<` and `>` are entity-escaped in the asset, as they are in any HTML. */
function asRendered(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

describe("the surface-views asset's chrome copy comes from the catalogue (MOTIR-6184)", () => {
  it.each(CHROME_KEYS)('draws `planningWorkspace.%s` verbatim', (key) => {
    const value = messages.planningWorkspace[key];

    // A key that has moved is a failure of this spec's own premise, and saying so
    // is more useful than an absent-string failure against `undefined`.
    expect(value, `messages/en.json has no planningWorkspace.${key}`).toBeTypeOf('string');
    expect(value!.length).toBeGreaterThan(0);

    expect(
      mock.includes(asRendered(value!)),
      `${MOCK} does not draw planningWorkspace.${key} (${JSON.stringify(value)}). ` +
        'The surface chrome in this asset is the shipped chrome: resolve its text from ' +
        'messages/en.json rather than typing it.',
    ).toBe(true);
  });

  it.each(REMOVED_KEYS)('draws NOTHING from `planningWorkspace.%s` — the foot is empty', (key) => {
    const value = messages.planningWorkspace[key];

    // The key still exists in the catalogue while the shipped host still renders
    // it; MOTIR-6186 is what removes both. Once it has gone this assertion is
    // vacuously satisfied, so say so rather than passing quietly.
    if (typeof value !== 'string' || value.length === 0) return;

    expect(
      mock.includes(asRendered(value)),
      `${MOCK} draws planningWorkspace.${key} (${JSON.stringify(value)}) in the foot. ` +
        'Part XXI 21.8 HIDES the footer when there is nothing to show: the rail already ' +
        'says where the plan has got to, and an empty box holding its own height is chrome ' +
        'that exists to be invisible.',
    ).toBe(false);
  });

  it('draws the strip the bar overlays, so the hidden footer costs no layout shift', () => {
    // 21.8 hides the slot AND moves the bar from a sibling to an overlay. The
    // strip is how the asset shows that the space is reserved for the bar and the
    // canvas's control clusters sit above it — which is what replaces MOTIR-1815's
    // always-there resting footer. An asset that hides the foot and does NOT draw
    // this is specifying the regression.
    expect(
      mock.includes('class="barStrip"'),
      `${MOCK} hides the footer without drawing the strip the confirm bar overlays. ` +
        'Hiding the slot is only safe because the bar stops being a shrink-0 sibling of ' +
        'the canvas box (21.8); an asset that shows the first half and not the second ' +
        'reads as a licence to make the box conditional, which is bug MOTIR-1815.',
    ).toBe(true);
  });

  it.each(INVENTED)('does not carry the invented copy %j', (phrase) => {
    expect(
      mock.includes(phrase),
      `${MOCK} carries ${JSON.stringify(phrase)}, which is not a string the product renders. ` +
        'The resting footer is planningWorkspace.footerRestingTitle / footerRestingBody.',
    ).toBe(false);
  });
});
