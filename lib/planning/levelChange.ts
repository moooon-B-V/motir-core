import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { levelTrail } from '@/lib/planning/planArrival';
import { proposalLevelKey } from '@/lib/planning/planShape';

// A pending change to the LEVEL YOU ARE STANDING IN (bug MOTIR-6223; design
// MOTIR-6241, `design/ai-chat/design-notes.md` § *A pending change to the LEVEL
// you are standing in*).
//
// Since MOTIR-6154 the planning surface opens INSIDE the node being planned, so
// that node is the LEVEL — the breadcrumb's last crumb — and never a card on it.
// `mergePlanLevel` frames the nodes ON a level, so a plan that changes the level
// itself drew its change nowhere: the reader was asked to confirm `1 changed` with
// no way to see what changed without climbing to the root. Nothing in the merge is
// wrong; the arrival moved out from under it.
//
// Both questions here are pure functions of the review model, answered for ONE
// level id, so the canvas can ask them of whichever level the reader is on —
// arrived, drilled or followed alike (the band is a property of the LEVEL, never
// of the door).

/** What the band says about the level in view. `null` ⇒ no band at all. */
export type LevelChange =
  | {
      state: 'changed';
      item: PlanReviewItemDto;
      /** The changed fields' WIRE names, in change order — labelled by the band
       *  exactly as the card's diff line labels them (`planReview.field_*`). */
      fields: string[];
      /** The proposed title, only when the title is among the changes — the crumb
       *  directly above keeps the committed one, so `was → now` is one glance. */
      proposedTitle: string | null;
    }
  | { state: 'removed'; item: PlanReviewItemDto }
  | { state: 'added'; item: PlanReviewItemDto };

/**
 * The plan's change to the level `levelId`, or `null` when there is none worth a
 * band — the NOTHING-CHANGED state, where the bar ships exactly as it did.
 *
 * A proposal keys by the node it is ABOUT (`nodeId`, MOTIR-3160's one keying
 * rule): a `modify` / `remove` by its target, an `add` by its plan item until
 * approve re-keys it to the work item it became. So the proposal about a level is
 * the one whose `nodeId` IS that level's id.
 *
 * Three verdicts draw nothing, each for a stated reason:
 *  - the ROOT (`null`) — the project is not a work item a plan can change, and the
 *    root has no bar to carry a band;
 *  - a LOCKED change (a `modify` / `remove` of a finished card) — the band's subject
 *    is a PENDING change, and `locked` is the absence of one;
 *  - an ACCEPTED `add` — the level exists now, so *"nothing here exists yet"* has
 *    stopped being true at the same moment it stopped being sayable.
 */
export function levelChangeFor(
  items: readonly PlanReviewItemDto[],
  levelId: string | null,
  outcome: 'accepted' | 'declined' | null,
): LevelChange | null {
  if (levelId === null) return null;
  const item = items.find((i) => i.nodeId === levelId);
  if (!item) return null;
  if (item.op === 'add') {
    return outcome === 'accepted' ? null : { state: 'added', item };
  }
  if (item.statusCategory === 'done') return null;
  if (item.op === 'remove') return { state: 'removed', item };
  const title = item.changes.find((c) => c.field === 'title');
  return {
    state: 'changed',
    item,
    fields: item.changes.map((c) => c.field),
    proposedTitle: title?.to ?? null,
  };
}

/**
 * WHERE THE PLAN IS, when it is not where the reader is — the second arming of
 * MOTIR-6161's *"Plan is in {identifier} · Go there"* (design MOTIR-6241 §
 * *BESIDE the anchor*).
 *
 * The offer's sentence is already true here, so it is composed unchanged; only
 * this is new: it arms when the pending plan places NOTHING on the reader's level
 * and places something on another. A plan that changes the reader's level ITSELF
 * is where they are — the band says that — so it arms nothing.
 *
 * Where several levels carry proposals it names the one holding the MOST; a tie
 * goes to the level NEAREST the reader, i.e. the one whose trail shares the
 * longest prefix with theirs (the nearest common ancestor wins over a cousin), and
 * a remaining tie to the level holding the plan's first proposal.
 */
export function planElsewhere(
  items: readonly PlanReviewItemDto[],
  readerTrail: readonly CanvasCrumb[],
  proposedWord: string,
): { levelId: string | null; trail: CanvasCrumb[] } | null {
  if (items.length === 0) return null;
  const here = readerTrail[readerTrail.length - 1]?.id ?? null;
  const counts = new Map<string | null, number>();
  for (const item of items) {
    const level = proposalLevelKey(item);
    if (level === here) return null;
    if (here !== null && item.nodeId === here) return null;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const readerIds = readerTrail.map((c) => c.id);
  let best: { levelId: string | null; trail: CanvasCrumb[]; count: number; shared: number } | null =
    null;
  // `Map` iterates in insertion order — the plan's own order — so the strict `>`
  // comparisons leave a full tie with the level named first.
  for (const [levelId, count] of counts) {
    const trail = levelTrail(items, levelId, proposedWord);
    let shared = 0;
    while (shared < trail.length && trail[shared]?.id === readerIds[shared]) shared += 1;
    if (best === null || count > best.count || (count === best.count && shared > best.shared)) {
      best = { levelId, trail, count, shared };
    }
  }
  return best && { levelId: best.levelId, trail: best.trail };
}
