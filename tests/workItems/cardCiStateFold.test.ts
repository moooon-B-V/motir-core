import { describe, expect, it } from 'vitest';
import {
  deliverySetIsGreen,
  deliveryStateForCard,
  deliveryStateForPromotion,
  foldCardCiState,
} from '@/lib/workItems/deliverySet';
import type { PrCiState } from '@/lib/github/prCiState';

// MOTIR-5470 — the CARD's own CI verdict, folded over its whole delivery set.
//
// The column this replaces was written by stamping THIS pull request's verdict
// onto each card it delivered, which is why a card with two pull requests read
// whichever reported last. The fold has no such freedom: it is a function of the
// SET, so no arrival order can change its answer. These are the pure halves —
// the per-member mapping and the fold — with the integration behaviour in
// `tests/github/cardCiState.test.ts`.

describe('deliveryStateForCard (MOTIR-5470)', () => {
  it('passes a settled verdict through untouched', () => {
    expect(deliveryStateForCard('failing', false)).toBe('failing');
    expect(deliveryStateForCard('running', false)).toBe('running');
    expect(deliveryStateForCard('passing', false)).toBe('passing');
  });

  it('reads a silent pull request in a CI-less repository as passing', () => {
    // The MOTIR-3823 decision, unchanged: a repository is allowed to have no CI,
    // and holding its cards red for ever punishes it for a choice it was
    // entitled to make.
    expect(deliveryStateForCard(null, true)).toBe('passing');
  });

  it('reads a silent pull request in a REPORTING repository as running', () => {
    // This is the ONE cell where the card and the promotion differ, and it is
    // the whole reason there are two mappers. The promotion has no third answer
    // to give, so it says `null` and withholds; the card is read by a PERSON, and
    // "waiting for a verdict" is exactly what they want to be told.
    expect(deliveryStateForCard(null, false)).toBe('running');
    expect(deliveryStateForPromotion(null, false)).toBeNull();
  });
});

describe('foldCardCiState (MOTIR-5470)', () => {
  it('folds an empty set to null — no deliveries is no CI, not a verdict', () => {
    expect(foldCardCiState([])).toBeNull();
  });

  it('folds a set with no verdict at all to null', () => {
    expect(foldCardCiState([null, null])).toBeNull();
  });

  it('agrees with a single member, which is nearly every card', () => {
    expect(foldCardCiState(['passing'])).toBe('passing');
    expect(foldCardCiState(['failing'])).toBe('failing');
    expect(foldCardCiState(['running'])).toBe('running');
  });

  it('RED WINS: one failing member makes the card failing', () => {
    // The acceptance criterion in prose: "a card delivered by two pull requests,
    // one failing and one passing, shows Checks failing". That pull request is
    // the one a person has to go and fix.
    expect(foldCardCiState(['passing', 'failing'])).toBe('failing');
    expect(foldCardCiState(['failing', 'passing'])).toBe('failing');
    expect(foldCardCiState(['running', 'failing'])).toBe('failing');
    expect(foldCardCiState(['failing', null])).toBe('failing');
  });

  it('RUNNING beats PASSING: a set still waiting has no settled verdict', () => {
    expect(foldCardCiState(['passing', 'running'])).toBe('running');
    expect(foldCardCiState(['running', 'passing'])).toBe('running');
    expect(foldCardCiState(['running', null])).toBe('running');
  });

  it('folds to passing only when every member that has a verdict passed', () => {
    expect(foldCardCiState(['passing', 'passing'])).toBe('passing');
    expect(foldCardCiState(['passing', null])).toBe('passing');
  });

  it('is ORDER-INDEPENDENT — which is the defect it exists to close', () => {
    // The previous writer's answer depended on which webhook arrived last. Every
    // permutation of one mixed set must give one answer.
    const permutations: PrCiState[][] = [
      ['passing', 'failing', 'running', null],
      [null, 'running', 'failing', 'passing'],
      ['running', 'passing', null, 'failing'],
      ['failing', null, 'passing', 'running'],
    ];
    for (const p of permutations) expect(foldCardCiState(p)).toBe('failing');
  });
});

describe('the card verdict and the promotion agree on GREEN (MOTIR-5470)', () => {
  // The badge's promise is that `passing` needs no badge BECAUSE green CI has
  // already moved the card to In Review. That promise is only true if the column
  // reads `passing` exactly when the promotion would promote. Both predicates
  // read the same classified members, so the equivalence is a property rather
  // than a coincidence — and this is where it is asserted rather than assumed.
  const cases: Array<{ state: PrCiState; cannotReport: boolean }[]> = [
    [],
    [{ state: 'passing', cannotReport: false }],
    [{ state: 'failing', cannotReport: false }],
    [{ state: 'running', cannotReport: false }],
    [{ state: null, cannotReport: false }],
    [{ state: null, cannotReport: true }],
    [
      { state: 'passing', cannotReport: false },
      { state: 'passing', cannotReport: false },
    ],
    [
      { state: 'passing', cannotReport: false },
      { state: 'failing', cannotReport: false },
    ],
    [
      { state: 'passing', cannotReport: false },
      { state: null, cannotReport: false },
    ],
    [
      { state: 'passing', cannotReport: false },
      { state: null, cannotReport: true },
    ],
  ];

  it.each(cases.map((members, i) => [i, members] as const))(
    'case %i: foldCardCiState === passing ⇔ deliverySetIsGreen',
    (_i, members) => {
      const card = foldCardCiState(
        members.map((m) => deliveryStateForCard(m.state, m.cannotReport)),
      );
      const green = deliverySetIsGreen(
        members.map((m) => deliveryStateForPromotion(m.state, m.cannotReport)),
      );
      expect(card === 'passing').toBe(green);
    },
  );

  it('holds for the EMPTY set in particular, where the two could easily part', () => {
    // `[].every(...)` is vacuously true, which is why `deliverySetIsGreen` has an
    // explicit empty-set rule. The fold reaches the same answer by a different
    // route — nothing to find — so this pins them together at the one input where
    // a careless implementation of either would disagree.
    expect(foldCardCiState([])).toBeNull();
    expect(deliverySetIsGreen([])).toBe(false);
  });
});
