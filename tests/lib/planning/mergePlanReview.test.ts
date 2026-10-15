import { describe, expect, it } from 'vitest';
import { mergePlanItems, mergePlanReview } from '@/lib/planning/mergePlanReview';
import { planReview, planReviewItem } from '../../helpers/planReview';

// mergePlanReview (Story MOTIR-8539 · Subtask MOTIR-8575) — a plan snapshot merged
// into what is held, by identity. Snapshot semantics stay: `next` is the truth.

const item = (id: string, title = id.toUpperCase()) =>
  planReviewItem({ planItemId: id, nodeId: id, title });

/** A fresh copy of the same content — what a re-read hands back. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('mergePlanReview', () => {
  it('an equal snapshot keeps the previous `items` array and the previous review', () => {
    const prev = planReview([item('a'), item('b')]);
    const merged = mergePlanReview(prev, copy(prev));
    expect(merged.review.items).toBe(prev.items);
    expect(merged.itemsChanged).toBe(false);
    expect(merged.changedItemIds.size).toBe(0);
    expect(merged.review).toBe(prev);
  });

  it('one changed proposal takes the new object; every other keeps the previous one', () => {
    const prev = planReview([item('a'), item('b'), item('c')]);
    const next = copy(prev);
    next.items[1] = { ...next.items[1]!, title: 'B, renamed' };
    const merged = mergePlanReview(prev, next);
    expect(merged.review.items[0]).toBe(prev.items[0]);
    expect(merged.review.items[1]).toBe(next.items[1]);
    expect(merged.review.items[2]).toBe(prev.items[2]);
    expect([...merged.changedItemIds]).toEqual(['b']);
    expect(merged.itemsChanged).toBe(true);
  });

  it('a withdrawn proposal is gone and a new one appears in `next`s order', () => {
    const prev = planReview([item('a'), item('b')]);
    const next = planReview([item('c'), copy(item('a'))]);
    const merged = mergePlanReview(prev, next);
    expect(merged.review.items.map((i) => i.planItemId)).toEqual(['c', 'a']);
    expect(merged.review.items[1]).toBe(prev.items[0]);
    expect(merged.itemsChanged).toBe(true);
    expect(merged.changedItemIds.size).toBe(0);
  });

  it('a reorder yields a new array in `next`s order with every object kept', () => {
    const prev = planReview([item('a'), item('b')]);
    const next = planReview([copy(item('b')), copy(item('a'))]);
    const merged = mergePlanReview(prev, next);
    expect(merged.review.items).not.toBe(prev.items);
    expect(merged.review.items[0]).toBe(prev.items[1]);
    expect(merged.review.items[1]).toBe(prev.items[0]);
    expect(merged.itemsChanged).toBe(true);
  });

  it('a changed top-level field takes the next value and leaves `items` alone', () => {
    const prev = planReview([item('a')]);
    const next = { ...copy(prev), summary: 'A new summary' };
    const merged = mergePlanReview(prev, next);
    expect(merged.review).not.toBe(prev);
    expect(merged.review.summary).toBe('A new summary');
    expect(merged.review.items).toBe(prev.items);
    expect(merged.review.history).toBe(prev.history);
    expect(merged.itemsChanged).toBe(false);
  });

  it('a null `prev` takes `next` whole', () => {
    const next = planReview([item('a')]);
    const merged = mergePlanReview(null, next);
    expect(merged.review).toBe(next);
    expect(merged.itemsChanged).toBe(true);
  });
});

describe('mergePlanItems', () => {
  it('returns the previous array when nothing changed', () => {
    const prev = [item('a'), item('b')];
    expect(mergePlanItems(prev, copy(prev)).items).toBe(prev);
  });
});

describe("usePlanChangeConversation's `fileReview`", () => {
  it('files an unchanged read as the held review, and takes another plan whole', async () => {
    const { fileReview } = await import('@/lib/hooks/usePlanChangeConversation');
    const held = planReview([item('a'), item('b')]);
    expect(fileReview(held, copy(held))).toBe(held);
    expect(fileReview(held, copy(held)).items).toBe(held.items);
    const other = { ...copy(held), id: 'plan_other' };
    expect(fileReview(held, other)).toBe(other);
    expect(fileReview(null, other)).toBe(other);
  });
});
