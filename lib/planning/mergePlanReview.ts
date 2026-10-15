import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import { planReviewEqual } from './planReviewEquality';

// A PLAN SNAPSHOT, MERGED INTO WHAT IS HELD BY IDENTITY (Story MOTIR-8539 ·
// Subtask MOTIR-8575).
//
// ⚠️ SNAPSHOT SEMANTICS ARE UNCHANGED. The server still answers the whole review
// and the response is still the truth: a proposal absent from `next` is absent
// from the result, and the result is in `next`'s order. The merge decides ONE
// thing — which previous objects can stand for the new ones — so a re-read that
// moved nothing gives the plan tree no new props, and a re-read that changed one
// proposal re-renders that proposal alone.
//
// Proposals are matched on `planItemId` (the review's stable key) and compared by
// structural equality over the WHOLE item. Every other top-level field keeps its
// previous reference while it is structurally equal, so `progress.observedAt`
// moving on every full read replaces `progress` and touches nothing else.
//
// Pure, no React: `useGeneratingPlanPoll`, `PlanDetail`, `usePlanGeneration` and
// `usePlanChangeConversation` all apply a snapshot through it, so none carries a copy.

export interface MergedPlanReview {
  /** The merged review — `prev` itself when nothing at all changed. */
  review: PlanReviewDto;
  /** `true` exactly when `review.items` is not `prev.items`. */
  itemsChanged: boolean;
  /** The proposals that took the incoming object because their content changed. */
  changedItemIds: ReadonlySet<string>;
}

const NOTHING_CHANGED: ReadonlySet<string> = new Set();

/**
 * `next`'s items, each replaced by its previous object when that is structurally
 * equal — and `prev` itself when the sequence and every item are unchanged.
 */
export function mergePlanItems(
  prev: readonly PlanReviewItemDto[],
  next: readonly PlanReviewItemDto[],
): { items: PlanReviewItemDto[]; changedItemIds: ReadonlySet<string> } {
  const before = new Map(prev.map((item) => [item.planItemId, item]));
  const changed = new Set<string>();
  let same = prev.length === next.length;
  const items = next.map((item, index) => {
    const old = before.get(item.planItemId);
    if (old === undefined) {
      same = false;
      return item;
    }
    const kept = planReviewEqual(old, item) ? old : item;
    if (kept === item && old !== item) changed.add(item.planItemId);
    if (kept !== prev[index]) same = false;
    return kept;
  });
  return {
    items: same ? (prev as PlanReviewItemDto[]) : items,
    changedItemIds: changed.size === 0 ? NOTHING_CHANGED : changed,
  };
}

/** `next` merged over `prev` (see the header). A `null` `prev` takes `next` whole. */
export function mergePlanReview(prev: PlanReviewDto | null, next: PlanReviewDto): MergedPlanReview {
  if (prev === null) {
    return {
      review: next,
      itemsChanged: true,
      changedItemIds: new Set(next.items.map((item) => item.planItemId)),
    };
  }
  if (prev === next) return { review: prev, itemsChanged: false, changedItemIds: NOTHING_CHANGED };

  const { items, changedItemIds } = mergePlanItems(prev.items, next.items);
  const prevFields = prev as unknown as Record<string, unknown>;
  const nextFields = next as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  let same = Object.keys(prevFields).length === Object.keys(nextFields).length;
  for (const key of Object.keys(nextFields)) {
    if (key === 'items') {
      merged[key] = items;
      if (items !== prev.items) same = false;
      continue;
    }
    const has = Object.prototype.hasOwnProperty.call(prevFields, key);
    const kept =
      has && planReviewEqual(prevFields[key], nextFields[key]) ? prevFields[key] : nextFields[key];
    if (!has || kept !== prevFields[key]) same = false;
    merged[key] = kept;
  }
  return {
    review: same ? prev : (merged as unknown as PlanReviewDto),
    itemsChanged: items !== prev.items,
    changedItemIds,
  };
}
