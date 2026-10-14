import { describe, expect, it } from 'vitest';
import { planReviewEqual } from '@/lib/planning/planReviewEquality';

// planReviewEqual (Story MOTIR-8539 · Subtask MOTIR-8575) — the structural
// equality a plan snapshot is merged by.

describe('planReviewEqual', () => {
  it('treats key order as irrelevant', () => {
    expect(planReviewEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });

  it('distinguishes null from an absent key, and [] from null', () => {
    expect(planReviewEqual({ a: null }, {})).toBe(false);
    expect(planReviewEqual({ a: [] }, { a: null })).toBe(false);
    expect(planReviewEqual([], null)).toBe(false);
  });

  it('compares nested arrays by position', () => {
    expect(
      planReviewEqual({ todos: [{ t: 'x' }, { t: 'y' }] }, { todos: [{ t: 'x' }, { t: 'y' }] }),
    ).toBe(true);
    expect(
      planReviewEqual({ todos: [{ t: 'x' }, { t: 'y' }] }, { todos: [{ t: 'y' }, { t: 'x' }] }),
    ).toBe(false);
  });

  it('compares primitives by value', () => {
    expect(planReviewEqual('a', 'a')).toBe(true);
    expect(planReviewEqual(1, '1')).toBe(false);
    expect(planReviewEqual(null, null)).toBe(true);
  });
});
