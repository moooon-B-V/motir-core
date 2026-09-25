import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { levelTrail } from '@/lib/planning/planArrival';
import { proposalLevelKey } from '@/lib/planning/planShape';

// The planning surface's LIVE pane (MOTIR-6300; `design/ai-planning/design-notes.md`
// Part XXIII) — the PURE half: what a snapshot of a plan being written means for
// the pane that draws it. No React, no fetch, no clock, so each rule is tested
// against plain fixtures.
//
// ⚠️ EVERY RULE HERE IS A DIFF OF TWO SNAPSHOTS, never an event. The generating
// poll REPLACES the review on every read (MOTIR-6295), so the snapshot is the only
// unit there is — the same premise `canvasMotion.ts` is built on (§23.4).

// ── The DEEPEN signature ─────────────────────────────────────────────────────

/**
 * A proposal's CONTENT signature — `PlanningCanvas`'s `changeKey` (MOTIR-6297).
 * A change while the node id stays is a DEEPEN, which cues the card in place and
 * never re-enters it (§23.4: "a changed title / type / body / sizing on a kept id").
 *
 * Built from exactly the fields the design names, plus the field diffs a `modify`
 * carries (its proposed values live there, not on the item's own columns). The op
 * is left out on purpose: a card changing op is not something a deepen describes.
 */
export function proposalChangeKey(item: PlanReviewItemDto): string {
  return digest(
    JSON.stringify([
      item.title,
      item.kind,
      item.type,
      item.descriptionMd,
      item.explanationMd,
      item.storyPoints,
      item.estimateMinutes,
      item.difficulty,
      item.changes,
    ]),
  );
}

/** A short, stable string hash (FNV-1a, 32 bit) — the key is compared, never read. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── The ANNOUNCEMENT (§23.15) ────────────────────────────────────────────────

/** The plan's `add` proposals, by id — what an announcement counts. */
export function addedProposalIds(items: readonly PlanReviewItemDto[]): Set<string> {
  return new Set(items.filter((i) => i.op === 'add').map((i) => i.planItemId));
}

/** How many `add`s are in `next` and were not in `seen` — one batch's count. */
export function newlyAddedCount(seen: ReadonlySet<string>, next: ReadonlySet<string>): number {
  let n = 0;
  for (const id of next) if (!seen.has(id)) n += 1;
  return n;
}

// ── The ARRIVALS count (§23.7) ───────────────────────────────────────────────

/** One of the plan's cards as the arrivals count sees it. */
export interface LiveArrival {
  /** The proposal's own id — stable while the plan is written. */
  id: string;
  /** The LEVEL it sits on: a canvas focus id, or `null` for the top level. */
  levelId: string | null;
  /** The breadcrumb down to that level — where *Go there* drills. */
  trail: readonly CanvasCrumb[];
  /**
   * Whether FIRST SIGHT of it is an arrival. True for an `add`; a `modify` /
   * `remove` names a committed card, and "a committed card never arrives" — it
   * counts only when a later snapshot MOVES it to another level.
   */
  arrivesOnFirstSight: boolean;
}

/** The plan's cards, for the arrivals count. `proposedWord` is `planReview.proposedCrumb`. */
export function liveArrivals(
  items: readonly PlanReviewItemDto[],
  proposedWord: string,
): LiveArrival[] {
  const trails = new Map<string | null, readonly CanvasCrumb[]>();
  return items.map((item) => {
    const levelId = proposalLevelKey(item);
    let trail = trails.get(levelId);
    if (trail === undefined) {
      trail = levelTrail(items, levelId, proposedWord);
      trails.set(levelId, trail);
    }
    return { id: item.planItemId, levelId, trail, arrivesOnFirstSight: item.op === 'add' };
  });
}

/** An arrival the reader has not seen: on a level other than the one they stood on. */
export interface PendingArrival {
  id: string;
  levelId: string | null;
  trail: readonly CanvasCrumb[];
  /** Arrival order — the LATEST is what *Go there* goes to. */
  seq: number;
}

export interface ArrivalsLog {
  /** The snapshot last folded in — `null` until the first, which is the baseline. */
  source: readonly LiveArrival[] | null;
  /** Every card seen so far, and the level it was last seen on. */
  known: ReadonlyMap<string, string | null>;
  pending: readonly PendingArrival[];
  seq: number;
  /** The level the reader stood on when this was last folded. */
  viewing: string | null;
}

export const EMPTY_ARRIVALS: ArrivalsLog = {
  source: null,
  known: new Map(),
  pending: [],
  seq: 0,
  viewing: null,
};

/**
 * Fold one snapshot into the log. The FIRST snapshot is the baseline and counts
 * nothing — nothing ARRIVED while the reader watched (§23.4's "the first read of a
 * pane plays nothing", for the count). After that, a card seen for the first time
 * (an `add`) or seen on a different level (a move) ARRIVED on its level, and it is
 * pending unless that level is the one being viewed. A card that leaves the plan,
 * or moves again, stops being pending where it was.
 */
export function foldArrivals(
  log: ArrivalsLog,
  next: readonly LiveArrival[],
  viewing: string | null,
): ArrivalsLog {
  const known = new Map(next.map((a) => [a.id, a.levelId] as const));
  if (log.source === null) return { ...log, source: next, known, viewing };
  let seq = log.seq;
  const pending = new Map(log.pending.map((p) => [p.id, p]));
  for (const a of next) {
    const before = log.known.get(a.id);
    const arrived = before === undefined ? a.arrivesOnFirstSight : before !== a.levelId;
    if (!arrived) continue;
    if (a.levelId === viewing) pending.delete(a.id);
    else pending.set(a.id, { id: a.id, levelId: a.levelId, trail: a.trail, seq: (seq += 1) });
  }
  const kept = [...pending.values()].filter(
    (p) => known.has(p.id) && known.get(p.id) === p.levelId,
  );
  return { source: next, known, pending: kept, seq, viewing };
}

/** The reader stood on `levelId`: its count clears (§23.7 "visiting a level clears its count"). */
export function visitLevel(log: ArrivalsLog, levelId: string | null): ArrivalsLog {
  return {
    ...log,
    viewing: levelId,
    pending: log.pending.filter((p) => p.levelId !== levelId),
  };
}

/** What the pill says: how many, across how many levels, and the latest one. */
export function arrivalsSummary(
  pending: readonly PendingArrival[],
): { count: number; levels: number; latest: PendingArrival } | null {
  if (pending.length === 0) return null;
  let latest = pending[0]!;
  for (const p of pending) if (p.seq > latest.seq) latest = p;
  return {
    count: pending.length,
    levels: new Set(pending.map((p) => p.levelId)).size,
    latest,
  };
}
