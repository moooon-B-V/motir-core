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

// ── The IN-FLIGHT cues (Story MOTIR-7820 · MOTIR-7830; Part XXV §25.6–25.7) ──
//
// ⚠️ A PRESENT STATE, NOT AN EVENT — and so kept OUT of the arrivals log above.
// An arrival is news that stays counted until the reader visits its level; a cue
// is "the planner is writing this now", counted from the CURRENT live steps on
// every render. A cue that leaves stops being counted at once, with nothing to
// clear. The steps themselves are the derivation's (`readPlanProgress`'s
// `liveSteps`): withdrawn targets and quiet sessions are already gone, so nothing
// here filters, ages or compares a time.

/** What a step marks. `author` → the item being DRAFTED; `lay` → the parent whose
 *  children are being LAID. */
export type InFlightCueKind = 'drafting' | 'laying';

/** One cue as the canvas's arrivals slot sees it: the node it marks, and the
 *  trail *Go there* drills to see it — the item's own level for `drafting`, the
 *  parent's own level (where its children land) for `laying`. */
export interface InFlightCue {
  nodeId: string;
  kind: InFlightCueKind;
  trail: readonly CanvasCrumb[];
}

/** The fields of a live step the mapping reads (`PlanProgressStep`'s). */
export interface InFlightStep {
  kind: 'settle' | 'lay' | 'author';
  targetNodeId: string | null;
}

/**
 * Map the live steps to cues. A `settle` step, and any step with no target node
 * (the untargeted lay and author), mark nothing (§25.6: an item not yet on the
 * plan has no cell). Several steps → several cues; one node named by both kinds
 * is `drafting`. `inFlight` holds one entry per cue whose level the plan's items
 * can place — a committed target the walk has not written a `modify` for, or a
 * parent with no child proposed yet, keeps its node cue wherever it is drawn and
 * adds no entry, because *Go there* would have nowhere to go. Order: the steps'
 * (earliest first).
 */
export function inFlightCues(
  items: readonly PlanReviewItemDto[],
  steps: readonly InFlightStep[],
  proposedWord: string,
): { cues: Map<string, InFlightCueKind>; inFlight: InFlightCue[] } {
  const cues = new Map<string, InFlightCueKind>();
  for (const step of steps) {
    if (step.kind === 'settle' || step.targetNodeId === null) continue;
    const kind: InFlightCueKind = step.kind === 'author' ? 'drafting' : 'laying';
    if (cues.get(step.targetNodeId) !== 'drafting') cues.set(step.targetNodeId, kind);
  }
  const inFlight: InFlightCue[] = [];
  for (const [nodeId, kind] of cues) {
    if (kind === 'drafting') {
      const item = items.find((i) => i.nodeId === nodeId);
      if (!item) continue;
      inFlight.push({
        nodeId,
        kind,
        trail: levelTrail(items, proposalLevelKey(item), proposedWord),
      });
    } else {
      if (!items.some((i) => proposalLevelKey(i) === nodeId)) continue;
      const trail = levelTrail(items, nodeId, proposedWord);
      if (trail[trail.length - 1]?.id !== nodeId) continue;
      inFlight.push({ nodeId, kind, trail });
    }
  }
  return { cues, inFlight };
}

/**
 * The cues the reader CANNOT see: the node is not on the drawn level, and it is
 * not a `laying` cue on the level the reader stands in (that one is the bar's
 * marker, §25.7 row 2).
 */
export function offLevelInFlight(
  inFlight: readonly InFlightCue[],
  drawnIds: ReadonlySet<string>,
  focusId: string | null,
): InFlightCue[] {
  return inFlight.filter(
    (c) => !drawnIds.has(c.nodeId) && !(c.kind === 'laying' && c.nodeId === focusId),
  );
}

/** What the ONE arrivals slot says (§25.7's table) — a copy key under
 *  `planningWorkspace.arrival`, its counts, and the trail *Go there* drills. */
export type LiveSlot =
  | { key: 'arrivedIn' | 'arrivedAcross'; count: number; trail: readonly CanvasCrumb[] }
  | { key: 'draftingIn' | 'draftingAcross'; count: number; trail: readonly CanvasCrumb[] }
  | { key: 'layingIn'; trail: readonly CanvasCrumb[] }
  | { key: 'newAndDraftingIn'; arrived: number; drafting: number; trail: readonly CanvasCrumb[] };

const levelOfTrail = (trail: readonly CanvasCrumb[]): string | null =>
  trail[trail.length - 1]?.id ?? null;

/**
 * The slot's wording, by §25.7's precedence. Arrivals are NEWS and in-flight
 * steps are STATE, so arrivals win the slot — except when arrivals and drafting
 * steps are on the SAME one level, which reads as one combined sentence. With no
 * arrivals: drafting on one level, drafting across several (named by the
 * earliest), then a lay. *Go there* goes to the latest arrival's level, else the
 * earliest in-flight step's. (The follow offer outranks all of it — the caller's.)
 */
export function liveSlot(
  arrivals: { count: number; levels: number; latest: PendingArrival } | null,
  offLevel: readonly InFlightCue[],
): LiveSlot | null {
  const drafting = offLevel.filter((c) => c.kind === 'drafting');
  const draftLevels = new Set(drafting.map((c) => levelOfTrail(c.trail)));
  if (arrivals) {
    if (
      arrivals.levels === 1 &&
      drafting.length > 0 &&
      draftLevels.size === 1 &&
      draftLevels.has(arrivals.latest.levelId)
    ) {
      return {
        key: 'newAndDraftingIn',
        arrived: arrivals.count,
        drafting: drafting.length,
        trail: arrivals.latest.trail,
      };
    }
    return {
      key: arrivals.levels > 1 ? 'arrivedAcross' : 'arrivedIn',
      count: arrivals.count,
      trail: arrivals.latest.trail,
    };
  }
  const first = drafting[0];
  if (first) {
    return {
      key: draftLevels.size > 1 ? 'draftingAcross' : 'draftingIn',
      count: drafting.length,
      trail: first.trail,
    };
  }
  const lay = offLevel.find((c) => c.kind === 'laying');
  return lay ? { key: 'layingIn', trail: lay.trail } : null;
}
