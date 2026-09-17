import { describe, expect, it } from 'vitest';
import { CI_STATE_META, ciBadgeState } from '@/components/github/ciStateMeta';
import { CI_STATES } from '@/lib/github/prCiState';

// MOTIR-5474 — the ONE rule every card-level surface applies to `WorkItem.ciState`.
//
// The board card, the `/items` List and Tree rows and the Workbench row all draw
// from this function, so the table below is the whole specification of what any of
// them shows. Two decisions are encoded in it, and each is asserted rather than
// left to the call sites:
//
//   * `passing` draws NOTHING, because green CI is what moves a card to In Review
//     — a green badge would restate the column it sits in;
//   * a `done`-CATEGORY item draws nothing whatever its column says, because a
//     done item's old red is not actionable.

const CATEGORIES = ['todo', 'in_progress', 'done'] as const;
const VALUES = [...CI_STATES, null] as const;

describe('ciBadgeState — the four values × the three categories (MOTIR-5474)', () => {
  // The full 4 × 3 table, written out rather than computed, so a change to the
  // rule has to change a line here and be read.
  const expected: Record<string, Record<string, string | null>> = {
    failing: { todo: 'failing', in_progress: 'failing', done: null },
    running: { todo: 'running', in_progress: 'running', done: null },
    passing: { todo: null, in_progress: null, done: null },
    none: { todo: null, in_progress: null, done: null },
  };

  for (const value of VALUES) {
    for (const category of CATEGORIES) {
      const name = value ?? 'none';
      it(`${name} × ${category} → ${expected[name]![category] ?? 'nothing'}`, () => {
        expect(ciBadgeState(value, category)).toBe(expected[name]![category]);
      });
    }
  }

  it('covers every value the fold can write — the table is not a subset', () => {
    // `CI_STATES` is the single tuple `foldCardCiState` writes from (MOTIR-5470).
    // Deriving the rows from it means a fourth verdict added there fails HERE
    // rather than silently falling through to "draw nothing".
    expect(VALUES.length).toBe(CI_STATES.length + 1);
    for (const state of CI_STATES) expect(expected[state]).toBeDefined();
  });

  it('draws nothing for an UNKNOWN stored value, rather than throwing', () => {
    // The column is a plain `String?`, so a value from a future writer — or a
    // hand-edited row — must degrade to "no badge" rather than crash a board.
    expect(ciBadgeState('something-else', 'in_progress')).toBeNull();
    expect(ciBadgeState(undefined, 'todo')).toBeNull();
    expect(ciBadgeState('failing', null)).toBe('failing');
    expect(ciBadgeState('failing', undefined)).toBe('failing');
  });
});

describe('CI_STATE_META has ONE definition, shared by every surface', () => {
  it('carries a distinct GLYPH per state, which is what the row form relies on', () => {
    // The row renders the glyph ALONE, so two states sharing an icon would make
    // them indistinguishable without reading the accessible name.
    const icons = CI_STATES.map((s) => CI_STATE_META[s].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('carries a tone for every state the fold can write', () => {
    for (const state of CI_STATES) {
      expect(CI_STATE_META[state]).toBeDefined();
      expect(CI_STATE_META[state].pill).toBeTruthy();
    }
  });
});
