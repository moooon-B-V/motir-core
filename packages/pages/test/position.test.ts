import { describe, expect, it } from 'vitest';
import {
  PAGE_LEVEL_PAGE_SIZE,
  PAGE_LEVEL_PAGE_SIZE_MAX,
  comparePageOrder,
  isAfterCursor,
  levelPageSize,
  positionBetween,
  positionsBetween,
} from '../src';

describe('positions', () => {
  it('makes a key between two others, and at either end', () => {
    const first = positionBetween(null, null);
    const after = positionBetween(first, null);
    const before = positionBetween(null, first);
    const mid = positionBetween(first, after);
    expect([after, before, mid, first].sort()).toEqual([before, first, mid, after]);
  });

  it('makes several ascending keys at once', () => {
    const keys = positionsBetween(null, null, 4);
    expect(keys).toHaveLength(4);
    expect([...keys].sort()).toEqual(keys);
  });

  it('refuses bounds out of order', () => {
    const a = positionBetween(null, null);
    const b = positionBetween(a, null);
    expect(() => positionBetween(b, a)).toThrow();
  });
});

describe('level order', () => {
  it('orders by position, then id, by code unit', () => {
    expect(comparePageOrder({ position: 'a0', id: 'z' }, { position: 'a1', id: 'a' })).toBe(-1);
    expect(comparePageOrder({ position: 'a1', id: 'a' }, { position: 'a0', id: 'z' })).toBe(1);
    expect(comparePageOrder({ position: 'a0', id: 'a' }, { position: 'a0', id: 'b' })).toBe(-1);
    expect(comparePageOrder({ position: 'a0', id: 'b' }, { position: 'a0', id: 'a' })).toBe(1);
    expect(comparePageOrder({ position: 'a0', id: 'a' }, { position: 'a0', id: 'a' })).toBe(0);
    // Code-unit order: 'Z' sorts before 'a', where a locale compare would not.
    expect(comparePageOrder({ position: 'aZ', id: 'x' }, { position: 'aa', id: 'x' })).toBe(-1);
  });

  it('reads the keyset predicate as strictly after the cursor', () => {
    const cursor = { position: 'a1', id: 'm' };
    expect(isAfterCursor({ position: 'a1', id: 'n' }, cursor)).toBe(true);
    expect(isAfterCursor({ position: 'a1', id: 'm' }, cursor)).toBe(false);
    expect(isAfterCursor({ position: 'a0', id: 'z' }, cursor)).toBe(false);
  });
});

describe('levelPageSize', () => {
  it(`defaults to ${PAGE_LEVEL_PAGE_SIZE}`, () => {
    expect(levelPageSize()).toBe(PAGE_LEVEL_PAGE_SIZE);
    expect(levelPageSize(null)).toBe(PAGE_LEVEL_PAGE_SIZE);
    expect(levelPageSize(Number.NaN)).toBe(PAGE_LEVEL_PAGE_SIZE);
  });

  it(`clamps to 1…${PAGE_LEVEL_PAGE_SIZE_MAX}`, () => {
    expect(levelPageSize(500)).toBe(PAGE_LEVEL_PAGE_SIZE_MAX);
    expect(levelPageSize(0)).toBe(1);
    expect(levelPageSize(-3)).toBe(1);
    expect(levelPageSize(20.7)).toBe(20);
  });
});
