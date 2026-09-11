import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-5107 — the lesson library's PHASE chip, in the asset, read against the
// catalogue rather than against a literal.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// MOTIR-4774 renamed the lesson axis's phases `skeleton` / `deepen` →
// `lay` / `author`, and MOTIR-4775 gave the chip a user-facing LABEL — the
// surface now renders *Laying a level* / *Writing a body* through
// `messages/en.json`. The design ASSET was outside both cards' scope and went
// on drawing `phase skeleton` in six places across five panels, so the artefact
// the design-reference rule sends every later card to read was specifying a
// badge the product no longer renders.
//
// ── Why a guard and not a careful edit ──────────────────────────────────────
// Nothing mechanically ties a mock's copy to a message catalogue: a mock is
// hand-written HTML, the catalogue is JSON, and the only thing that had ever
// kept them agreeing was whoever last edited both. That is the same shape as
// the drift this card is repairing, so repairing it by hand and stopping would
// leave the next rename to rediscover it.
//
// ── What this asserts, and what it deliberately does not ────────────────────
// It reads the LABELS out of `messages/en.json` and requires the board's phase
// chips to be exactly those strings. It hard-codes NEITHER label: a third
// rename that moves the catalogue moves this spec with it, and a rename that
// moves only one of the two fails here. What it does not assert is HOW MANY
// chips carry each label — a panel may gain or lose a row without this spec
// having an opinion — only that every phase chip on the board is a string the
// catalogue holds, and that both labels are actually drawn somewhere, so the
// asset cannot quietly stop exercising one of them.
//
// The RETIRED spellings get their own assertion rather than being left to the
// first one. `phase skeleton` failing as "not a catalogue label" is true but
// unhelpful; a reader meeting it wants to be told the value was renamed and
// where the current one lives.

const ROOT = process.cwd();
const MOCK = join(ROOT, 'design/ai-settings/ai-planning-lessons.mock.html');
const MESSAGES = join(ROOT, 'messages/en.json');
const NOTES = join(ROOT, 'design/ai-settings/design-notes.md');

/** The spellings MOTIR-4774 retired, which must not come back to the board. */
const RETIRED = ['skeleton', 'deepen'] as const;

/**
 * Every phase chip the board draws, as its VALUE text.
 *
 * The chip's shape is fixed by §L4 — the axis name travels with the value,
 * `<span class="k">phase</span>` followed by the value — so the value is
 * whatever sits between that span and the chip's closing tag.
 */
function phaseChipValues(html: string): string[] {
  const pattern = /<span class="k">phase<\/span>([^<]*)<\/span>/g;
  return [...html.matchAll(pattern)].map((m) => m[1]!.trim());
}

const mock = readFileSync(MOCK, 'utf8');
const notes = readFileSync(NOTES, 'utf8');
const phaseLabels = (
  JSON.parse(readFileSync(MESSAGES, 'utf8')) as {
    settings: { aiPlanning: { lessons: { phase: Record<string, string> } } };
  }
).settings.aiPlanning.lessons.phase;

describe('the lesson library asset draws the SHIPPED phase labels (MOTIR-5107)', () => {
  it('finds the catalogue keys the chips are supposed to render', () => {
    // Without this the assertions below would pass vacuously against an empty
    // label set if the catalogue were ever re-shaped.
    expect(Object.keys(phaseLabels).sort()).toEqual(['author', 'lay']);
    for (const [value, label] of Object.entries(phaseLabels)) {
      expect(label, `${value} has an empty label`).not.toBe('');
    }
  });

  it('finds phase chips on the board at all', () => {
    expect(phaseChipValues(mock).length).toBeGreaterThan(0);
  });

  it('draws every phase chip as a string the catalogue holds', () => {
    const labels = Object.values(phaseLabels);
    const strays = [...new Set(phaseChipValues(mock))].filter((v) => !labels.includes(v));
    expect(
      strays,
      `design/ai-settings/ai-planning-lessons.mock.html draws a phase chip the catalogue does ` +
        `not label: ${strays.map((s) => JSON.stringify(s)).join(', ')}. The chip renders ` +
        `messages/en.json settings.aiPlanning.lessons.phase.* — copy the string from there ` +
        `rather than typing the stored value.`,
    ).toEqual([]);
  });

  it('draws BOTH labels, so neither arm goes unexercised', () => {
    const drawn = new Set(phaseChipValues(mock));
    for (const [value, label] of Object.entries(phaseLabels)) {
      expect(
        drawn.has(label),
        `no panel draws the ${value} phase (${JSON.stringify(label)}), so the board stops ` +
          `specifying what that chip looks like`,
      ).toBe(true);
    }
  });

  it('carries none of the RETIRED phase spellings as a chip value', () => {
    for (const retired of RETIRED) {
      expect(
        phaseChipValues(mock),
        `"${retired}" is the pre-MOTIR-4774 spelling of a lesson phase. The axis stores ` +
          `lay / author and the chip renders their labels from messages/en.json ` +
          `settings.aiPlanning.lessons.phase.*.`,
      ).not.toContain(retired);
    }
  });

  it('says in the notes that the phase axis is the labelled one', () => {
    // §L4's asymmetry clause — the reason `kind` and `type` stay raw. A board
    // corrected without it invites the next reader to "fix" the other two.
    for (const label of Object.values(phaseLabels)) {
      expect(notes, `design-notes.md §L4 does not name ${JSON.stringify(label)}`).toContain(label);
    }
  });
});
