import { Ban, Clock } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// The not-applied BADGE, in its own module (Subtask MOTIR-3346).
//
// ⚠️ It lives here rather than in `LessonRow` because BOTH a server component
// (the row, when nobody may act) and a `'use client'` island (the apply control,
// which owns the acted-on row's state) render it. Importing it out of `LessonRow`
// from a client module would pull that whole module — and everything it imports —
// into the client graph, for one small presentational component.

/**
 * Why a lesson is not currently being applied — the badge, and the two states
 * are drawn APART on purpose (§L6).
 *
 * `disabled` is somebody's decision: the ARCHIVED pill tone, whose own comment
 * calls it "an inactive state, not a severity", which is exactly this.
 * `not_recurred` is the clock, and it reverses itself on the next recurrence —
 * so it takes the asset's `--el-tint-yellow` over the neutral pill, since no
 * shipped tone carries that hue. Both put the meaning in WORDS with an
 * `aria-hidden` glyph; nothing rests on the fill (§L11).
 */
export function NotAppliedBadge({
  block,
  label,
}: {
  block: NonNullable<ProjectLessonDTO['injectionBlock']>;
  label: string;
}) {
  if (block === 'disabled') {
    return (
      <Pill tone="archived">
        <Ban className="size-3" aria-hidden />
        {label}
      </Pill>
    );
  }
  return (
    <Pill tone="neutral" className="bg-(--el-tint-yellow) text-(--el-text-strong)">
      <Clock className="size-3" aria-hidden />
      {label}
    </Pill>
  );
}
