import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanProgressStep } from '@/lib/plans/planProgress';
import { stepLevel } from '@/lib/planning/livePane';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import type { FollowRequest } from '@/lib/planning/surfaceFollow';

// THE PLANNER DRIVES THE CANVAS (MOTIR-8592, Story MOTIR-8590; design
// `design/ai-planning/design-notes.md` Part XXVIII) — the PURE half: while a plan
// is generating, where should the canvas be right now, and is that a NEW request?
// No React, no fetch, no clock.
//
// ⚠️ IT READS `readPlanProgress(...).liveSteps` AS THEY ARE. That list is already
// the live set at the reader's `now` — quiet sessions dropped, a stalled plan
// empty — and already ordered by `startedAt`, ties by `sessionKey`. Nothing here
// re-orders, filters by time or re-phrases a step; the snapshot's order IS the
// tie-break (`planProgress.ts`'s header holds every surface to that).
//
// The level a step names is `livePane.ts`'s `stepLevel` — the same rule the cues
// and *Go there* use — so the three cannot drift apart.
//
// The host (MOTIR-8594) owns the rest: it keeps `held` across polls, keeps the
// following ON/OFF, owns `epoch` (Follow the planner bumps it), and calls these
// only while the plan is `generating` and following is on.

/** The step the canvas follows, and the level it names. */
export interface DrivenStep {
  /** The step's identity — see {@link drivenStepId}. */
  id: string;
  /** The level to show: a canvas focus id, or `null` for the top level. */
  levelId: string | null;
  /** The breadcrumb down to that level; `[]` is the top level. */
  trail: CanvasCrumb[];
}

type LiveStep = Pick<
  PlanProgressStep,
  'sessionKey' | 'kind' | 'targetRef' | 'targetNodeId' | 'startedAt'
>;

/**
 * A step's identity: its session, its target and when it started. The target and
 * start are in it because one session can reuse its key across targets (a plan.py
 * author session, a hosted session), and the canvas should follow the planner on
 * to its next card rather than treat that as the same step.
 */
export function drivenStepId(step: LiveStep): string {
  return JSON.stringify([step.sessionKey, step.targetRef, step.startedAt]);
}

/**
 * The step to drive the canvas from, given the one held since the last snapshot.
 *
 * - HOLD: while a live step with the held id is still present it stays the driven
 *   step, even if an earlier-started step has appeared. Its level is recomputed,
 *   so an item that moves level is followed; if it no longer resolves, nothing is
 *   driven this snapshot (`null`) and the caller keeps holding.
 * - Otherwise the FIRST live step, in the snapshot's own order, whose level
 *   resolves. A step that names nothing on the plan (`settle`, the untargeted lay
 *   and author, an unresolved target, a laid parent with no child yet) is
 *   skipped, never driven as "nothing".
 * - No resolvable step, or no live step at all → `null`: the canvas stays put.
 *
 * So the caller holds with `held = nextDrivenStep(held, …) ?? held`: a `null`
 * keeps the previous hold, and a held step that has left the live set is simply
 * not found next time, which hands over to the first resolvable step.
 */
export function nextDrivenStep(
  held: DrivenStep | null,
  liveSteps: readonly LiveStep[],
  items: readonly PlanReviewItemDto[],
  proposedWord: string,
): DrivenStep | null {
  if (held) {
    const still = liveSteps.find((s) => drivenStepId(s) === held.id);
    if (still) {
      const level = stepLevel(items, still, proposedWord);
      return level ? { id: held.id, ...level } : null;
    }
  }
  for (const step of liveSteps) {
    const level = stepLevel(items, step, proposedWord);
    if (level) return { id: drivenStepId(step), ...level };
  }
  return null;
}

/**
 * The keyed request for `ProjectRoadmapCanvas.followTo`. The key is STABLE while
 * the same step stays on the same level, so a re-render or a repeat poll asks for
 * nothing new; it changes on a new driven step, the held step's level moving, or
 * a new `epoch` (the caller's counter, bumped by Follow the planner so the same
 * level is asked for again). A `[]` trail is a real destination here: the top
 * level.
 */
export function drivenFollowRequest(
  driven: DrivenStep | null,
  epoch: number,
): FollowRequest | null {
  if (!driven) return null;
  return {
    key: `drive:${epoch}:${driven.id}:${driven.levelId ?? 'root'}`,
    trail: driven.trail,
  };
}
