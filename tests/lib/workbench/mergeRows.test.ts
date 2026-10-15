import { describe, expect, it } from 'vitest';
import { keepIfEqual, mergeRowsByIdentity, structurallyEqual } from '@/lib/workbench/mergeRows';

// mergeRowsByIdentity (Story MOTIR-8539 · Subtask MOTIR-8574) — what lets a
// re-read of the Workbench land without re-rendering the rows that did not move.

interface Row {
  id: string;
  title: string;
  tags?: string[];
  owner?: { name: string } | null;
}

const idOf = (row: Row) => row.id;

describe('mergeRowsByIdentity', () => {
  it('returns the PREVIOUS ARRAY when every row is equal and in the same order', () => {
    const prev: Row[] = [
      { id: 'a', title: 'A', tags: ['x'], owner: { name: 'Mei' } },
      { id: 'b', title: 'B' },
    ];
    const next: Row[] = [
      { owner: { name: 'Mei' }, tags: ['x'], title: 'A', id: 'a' },
      { id: 'b', title: 'B' },
    ];
    expect(mergeRowsByIdentity(prev, next, idOf)).toBe(prev);
  });

  it('keeps the previous object for an equal row and takes the incoming one for a changed row', () => {
    const prev: Row[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const next: Row[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B, renamed' },
    ];
    const merged = mergeRowsByIdentity(prev, next, idOf);
    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(prev[0]);
    expect(merged[1]).toBe(next[1]);
  });

  it('never reorders: the result is in the incoming order, with the previous objects', () => {
    const prev: Row[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const next: Row[] = [
      { id: 'b', title: 'B' },
      { id: 'a', title: 'A' },
    ];
    const merged = mergeRowsByIdentity(prev, next, idOf);
    expect(merged).not.toBe(prev);
    expect(merged.map(idOf)).toEqual(['b', 'a']);
    expect(merged[0]).toBe(prev[1]);
    expect(merged[1]).toBe(prev[0]);
  });

  it('takes an arrival as-is and drops a departure', () => {
    const prev: Row[] = [{ id: 'a', title: 'A' }];
    const next: Row[] = [
      { id: 'c', title: 'C' },
      { id: 'a', title: 'A' },
    ];
    const merged = mergeRowsByIdentity(prev, next, idOf);
    expect(merged.map(idOf)).toEqual(['c', 'a']);
    expect(merged[0]).toBe(next[0]);
    expect(merged[1]).toBe(prev[0]);
    expect(mergeRowsByIdentity(next, prev, idOf).map(idOf)).toEqual(['a']);
  });
});

describe('structurallyEqual', () => {
  it('ignores key order and compares nested values', () => {
    expect(structurallyEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(structurallyEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it('treats null and an absent key as DIFFERENT — a field that disappeared is a change', () => {
    expect(structurallyEqual({ a: null }, {})).toBe(false);
    expect(structurallyEqual({ a: undefined }, {})).toBe(false);
  });
});

describe('keepIfEqual', () => {
  it('returns the previous value when equal, the next one otherwise', () => {
    const prev = { toDo: 3, inProgress: 1 };
    expect(keepIfEqual(prev, { inProgress: 1, toDo: 3 })).toBe(prev);
    const next = { toDo: 2, inProgress: 1 };
    expect(keepIfEqual(prev, next)).toBe(next);
  });
});
