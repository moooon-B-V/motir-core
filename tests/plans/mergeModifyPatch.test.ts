import { describe, expect, it } from 'vitest';
import { PLAN_ITEM_PATCH_KEYS } from '@/lib/dto/plans';
import { DuplicatePlanTargetError } from '@/lib/plans/errors';
import { foldAppend, mergeModifyPatch } from '@/lib/plans/mergeModifyPatch';

// MOTIR-6051 — `agent-authored-plans.md` AMENDMENT 18 §2: a second `modify` of
// one committed card MERGES into the plan's one `modify`. The rule is stated
// per KEY CLASS, so these cases are too.

describe('mergeModifyPatch — per key class', () => {
  it('SCALAR: the later value wins per key, and an absent key keeps the earlier one', () => {
    expect(
      mergeModifyPatch({ title: 'A', priority: 'low' }, { priority: 'high', storyPoints: 3 }),
    ).toEqual({ title: 'A', priority: 'high', storyPoints: 3 });
  });

  it('NULLABLE: an explicit `null` in the later patch still CLEARS', () => {
    expect(
      mergeModifyPatch(
        { descriptionMd: 'Body', parentRef: 'wi_a' },
        { descriptionMd: null, parentRef: null },
      ),
    ).toEqual({
      descriptionMd: null,
      parentRef: null,
    });
  });

  it('EDGE LISTS: each is the de-duplicated union', () => {
    expect(
      mergeModifyPatch(
        { blockedByAdd: ['a', 'b'], blockedByRemove: ['x'] },
        { blockedByAdd: ['b', 'c'], blockedByRemove: ['y'] },
      ),
    ).toEqual({ blockedByAdd: ['a', 'b', 'c'], blockedByRemove: ['x', 'y'] });
  });

  it('a ref in BOTH lists cancels to NEITHER — whichever side added it', () => {
    expect(mergeModifyPatch({ blockedByAdd: ['a', 'k'] }, { blockedByRemove: ['a'] })).toEqual({
      blockedByAdd: ['k'],
    });
    expect(mergeModifyPatch({ blockedByRemove: ['a'] }, { blockedByAdd: ['a'] })).toEqual({});
  });

  it('is TOTAL over PLAN_ITEM_PATCH_KEYS — every key survives a merge from either side', () => {
    const edge = new Set(['blockedByAdd', 'blockedByRemove']);
    for (const key of PLAN_ITEM_PATCH_KEYS) {
      const value = edge.has(key) ? ['r'] : `v-${key}`;
      expect(mergeModifyPatch({ [key]: value }, {}), key).toEqual({ [key]: value });
      expect(mergeModifyPatch({}, { [key]: value }), key).toEqual({ [key]: value });
    }
  });

  it('DIFFICULTY (MOTIR-6133) merges as a scalar, exactly like storyPoints — later wins, `null` clears', () => {
    expect(
      mergeModifyPatch({ difficulty: 'medium', storyPoints: 3 }, { difficulty: 'high' }),
    ).toEqual({ difficulty: 'high', storyPoints: 3 });
    expect(mergeModifyPatch({ difficulty: 'medium' }, { title: 'T' })).toEqual({
      difficulty: 'medium',
      title: 'T',
    });
    expect(mergeModifyPatch({ difficulty: 'medium' }, { difficulty: null })).toEqual({
      difficulty: null,
    });
  });

  it('treats a missing patch on either side as empty', () => {
    expect(mergeModifyPatch(null, { title: 'T' })).toEqual({ title: 'T' });
    expect(mergeModifyPatch({ title: 'T' }, undefined)).toEqual({ title: 'T' });
  });
});

describe('foldAppend — which proposals become rows', () => {
  const row = (id: string, op: string, workItemId: string | null, patch: unknown = null) => ({
    id,
    op,
    workItemId,
    patch,
  });

  it('merges into the row the plan already holds, and keeps merging across the batch', () => {
    const fold = foldAppend(
      [row('r1', 'modify', 'X', { title: 'A' })],
      [
        { op: 'modify', workItemId: 'X', patch: { priority: 'high' } },
        { op: 'modify', workItemId: 'X', patch: { title: 'B' } },
        { op: 'add' },
      ],
    );
    expect(fold.dispositions).toEqual([
      { kind: 'mergeExisting', rowId: 'r1' },
      { kind: 'mergeExisting', rowId: 'r1' },
      { kind: 'insert' },
    ]);
    expect(fold.mergedExisting.get('r1')).toEqual({ title: 'B', priority: 'high' });
  });

  it('folds an in-batch pair into the EARLIER proposal, which is inserted with the merged patch', () => {
    const fold = foldAppend(
      [],
      [
        { op: 'modify', workItemId: 'X', patch: { title: 'A' } },
        { op: 'modify', workItemId: 'X', patch: { blockedByAdd: ['b'] } },
      ],
    );
    expect(fold.dispositions).toEqual([{ kind: 'insert' }, { kind: 'mergeBatch', index: 0 }]);
    expect(fold.mergedIncoming.get(0)).toEqual({ title: 'A', blockedByAdd: ['b'] });
  });

  it.each([
    ['modify', 'remove'],
    ['remove', 'modify'],
    ['remove', 'remove'],
  ])('still refuses %s then %s of one card — existing or in-batch', (first, second) => {
    expect(() => foldAppend([row('r1', first, 'X')], [{ op: second, workItemId: 'X' }])).toThrow(
      DuplicatePlanTargetError,
    );
    expect(() =>
      foldAppend(
        [],
        [
          { op: first, workItemId: 'X' },
          { op: second, workItemId: 'X' },
        ],
      ),
    ).toThrow(DuplicatePlanTargetError);
  });

  it('ignores `add`s, which have no target until materialize', () => {
    const fold = foldAppend([row('a1', 'add', null)], [{ op: 'add' }, { op: 'add' }]);
    expect(fold.dispositions).toEqual([{ kind: 'insert' }, { kind: 'insert' }]);
  });
});
