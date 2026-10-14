'use client';

import { BrandMark } from '@/components/brand/BrandMark';
import { usePlanProgressReading } from '@/lib/hooks/usePlanProgressReading';
import { readPlanAtWork, type PlanProgressSnapshot } from '@/lib/plans/planProgress';

// THE MOTIR MARK AT WORK (Story MOTIR-8413 · Subtask MOTIR-8417; design
// `design/ai-chat/design-notes.md` § _Motir at work_ › _Where the mark sits_).
//
// ONE instance, in the planning rail's header between its status dot and its
// _Motir AI_ label. While `readPlanAtWork(...).atWork` the shipped glyph takes the
// drafting ink and breathes (`app/globals.css`, `.plan-at-work-mark`); otherwise it
// holds the shipped static form. The answer is READ, never recomputed: this file
// compares no timestamp, branches on no state name and never reads `.steps`.
//
// Decorative: the wrapper is `aria-hidden` and the glyph already is, so it adds no
// role, no name, no live region and no tab stop — the state words ship on the
// progress line's marker (MOTIR-7820), not here.

export interface PlanAtWorkMarkViewProps {
  atWork: boolean;
}

/** The PURE form — total over the boolean: `true` breathes, `false` is still. */
export function PlanAtWorkMarkView({ atWork }: PlanAtWorkMarkViewProps) {
  return (
    <span
      className="plan-at-work-mark inline-flex shrink-0"
      data-testid="plan-at-work-mark"
      data-at-work={atWork ? 'true' : 'false'}
      aria-hidden="true"
    >
      <BrandMark variant="mark" size={14} />
    </span>
  );
}

export interface PlanAtWorkMarkProps {
  progress: PlanProgressSnapshot | null;
  /** The poll's `failing` — handed to the clock and the derivation, never re-tested. */
  failing?: boolean;
}

/** The mark, with its own clock — the shape `PlanProgressLine` set. */
export function PlanAtWorkMark({ progress, failing = false }: PlanAtWorkMarkProps) {
  const reading = usePlanProgressReading(progress, { failing });
  return <PlanAtWorkMarkView atWork={readPlanAtWork(reading, { failing }).atWork} />;
}
