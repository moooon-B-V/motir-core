'use client';

import { BrandMarkFlow } from '@/components/brand/BrandMarkFlow';
import { usePlanProgressReading } from '@/lib/hooks/usePlanProgressReading';
import { readPlanAtWork, type PlanProgressSnapshot } from '@/lib/plans/planProgress';

// THE MOTIR MARK AT WORK — the avatar of the turn Motir AI is working on
// (MOTIR-9213; design `design/ai-chat/design-notes.md` § _The Motir mark at work_,
// MOTIR-9212, which retires MOTIR-8417's breathing header mark).
//
// ONE instance, the round ink avatar of the rail's working-turn row, beside the
// hand-off, the act record and the planner notes. While Motir AI is at work the
// glyph flows (`BrandMarkFlow`); otherwise it holds the shipped still mark. The
// plan half of the answer is READ, never recomputed: this file compares no
// timestamp, branches on no state name and never reads `.steps`.
//
// Decorative: the disc is `aria-hidden` and so is the glyph, so it adds no role,
// no name, no live region and no tab stop — the state words ship on the act
// record and the progress line, not here.

/** The avatar's glyph in its 28 px disc (60%; the design moved it from 13 px). */
export const PLAN_AT_WORK_GLYPH_PX = 17;

export interface PlanAtWorkMarkViewProps {
  atWork: boolean;
}

/** The PURE form — total over the boolean: `true` flows, `false` is still. */
export function PlanAtWorkMarkView({ atWork }: PlanAtWorkMarkViewProps) {
  return (
    <span
      className="plan-at-work-mark flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-(--el-accent) text-(--el-accent-text)"
      data-testid="plan-at-work-mark"
      data-at-work={atWork ? 'true' : 'false'}
      aria-hidden="true"
    >
      <BrandMarkFlow flowing={atWork} size={PLAN_AT_WORK_GLYPH_PX} />
    </span>
  );
}

export interface PlanAtWorkMarkProps {
  /** The plan being written that the rail watches, or `null` when there is none. */
  progress: PlanProgressSnapshot | null;
  /** The poll's `failing` — handed to the clock and the derivation, never re-tested. */
  failing?: boolean;
  /**
   * Any OTHER job of this session streaming to this viewer: an ask turn being
   * read, a look-up, a debug turn, a plan run still in its conversation phase.
   * The rail passes `false` while a plan run is in its planning phase or a plan
   * is on screen, so a stream still open over a stalled, failing or finished
   * plan does not keep the mark moving.
   */
  turnStreaming?: boolean;
}

/**
 * `motirAtWork`, the one datum (design § _What the mark answers_): a plan being
 * written that is moving, OR any other Motir AI job streaming. The mark, with
 * its own clock — the shape `PlanProgressLine` set.
 */
export function PlanAtWorkMark({
  progress,
  failing = false,
  turnStreaming = false,
}: PlanAtWorkMarkProps) {
  const reading = usePlanProgressReading(progress, { failing });
  const planAtWork = progress ? readPlanAtWork(reading, { failing }).atWork : false;
  return <PlanAtWorkMarkView atWork={planAtWork || turnStreaming} />;
}
