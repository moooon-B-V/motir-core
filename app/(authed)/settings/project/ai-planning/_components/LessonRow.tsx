import Link from 'next/link';
import { Ban, ChevronRight, Clock, Repeat } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// The LESSON ROW and the chips it composes (Subtask MOTIR-3338), per
// `design/ai-settings/ai-planning-lessons.mock.html` panels 1–3 and
// design-notes.md §§L4, L6, L8, L10.
//
// Shared by the list and by the door card's preview, so the two cannot describe
// one lesson differently.

/**
 * One ROUTING AXIS as a chip. The axis NAME travels with the value, deliberately
 * (§L4): `story` alone reads as a status.
 *
 * `Pill tone="neutral"` is the primitive — `--el-chip-bg` / `--el-chip-border`,
 * the badge radius and the chip padding, all from it. The VALUE takes
 * `--el-text-strong` over the pill's secondary ink, which is the one place the
 * asset is more specific than the primitive (§L10); the axis name keeps the
 * pill's own `--el-text-secondary`.
 */
export function AxisChip({
  axis,
  value,
  muted = false,
}: {
  axis: string;
  value: string;
  /** A not-applied row's chips drop their fill (§L6). */
  muted?: boolean;
}) {
  return (
    <Pill tone="neutral" className={muted ? 'bg-transparent' : undefined}>
      <span className="text-(--el-text-secondary) font-normal">{axis}</span>
      <span className={muted ? 'text-(--el-text-secondary)' : 'text-(--el-text-strong)'}>
        {value}
      </span>
    </Pill>
  );
}

/**
 * The chip a lesson with NO axes shows.
 *
 * ⚠️ NOT three empty chips and NOT nothing. An empty axis means UNCONSTRAINED
 * upstream, so the lesson applies everywhere — and three missing chips would
 * read as missing data rather than as universal scope (§L4).
 */
export function EveryCardChip({ label }: { label: string }) {
  return (
    <Pill tone="neutral" className="bg-transparent">
      <span className="text-(--el-text-secondary)">{label}</span>
    </Pill>
  );
}

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

export interface LessonRowCopy {
  lastSeen: (when: string) => string;
  seen: (count: number) => string;
  everyCard: string;
  notApplied: string;
  notRecurred: (days: number) => string;
}

/**
 * One row in the library list.
 *
 * A LINK whose accessible name is the takeaway (§L11) — the whole row, so the
 * target is the row and not a chevron. The chevron is decorative.
 *
 * ⚠️ NO RETIRE ACTION HERE. The design draws one and MOTIR-3330 builds it; this
 * card renders whatever state the data already carries, so the two never fight
 * over the same markup (the card's own seam).
 */
export function LessonRow({
  lesson,
  href,
  copy,
}: {
  lesson: ProjectLessonDTO;
  href: string;
  copy: LessonRowCopy;
}) {
  const notApplied = lesson.injectionBlock !== null;
  const axes: { axis: string; value: string }[] = [
    ...lesson.kinds.map((value) => ({ axis: 'kind', value })),
    ...lesson.types.map((value) => ({ axis: 'type', value })),
    ...lesson.phases.map((value) => ({ axis: 'phase', value })),
  ];
  return (
    <Link
      href={href}
      data-testid="lesson-row"
      data-not-applied={notApplied ? 'true' : undefined}
      className="border-(--el-border-soft) hover:bg-(--el-surface-soft) flex items-start gap-3.5 border-b px-(--spacing-card-padding) py-3.5 last:border-b-0"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span
          className={
            notApplied
              ? 'text-(--el-text-tertiary) text-sm'
              : 'text-sm font-medium text-(--el-text)'
          }
        >
          {lesson.title}
        </span>
        <span
          className={`flex flex-wrap items-center gap-2 text-xs ${
            notApplied ? 'text-(--el-text-tertiary)' : 'text-(--el-text-secondary)'
          }`}
        >
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="text-(--el-icon-muted) size-3.5" aria-hidden />
            {copy.lastSeen(lesson.lastOccurredAt)}
          </span>
          <span aria-hidden className="text-(--el-text-tertiary)">
            ·
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Repeat className="text-(--el-icon-muted) size-3.5" aria-hidden />
            {copy.seen(lesson.recurrenceCount)}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {axes.length === 0 ? (
            <EveryCardChip label={copy.everyCard} />
          ) : (
            axes.map((a) => (
              <AxisChip
                key={`${a.axis}:${a.value}`}
                axis={a.axis}
                value={a.value}
                muted={notApplied}
              />
            ))
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-px">
        {lesson.injectionBlock !== null && (
          <NotAppliedBadge
            block={lesson.injectionBlock}
            label={
              lesson.injectionBlock === 'disabled'
                ? copy.notApplied
                : copy.notRecurred(lesson.retentionDays)
            }
          />
        )}
        <ChevronRight className="text-(--el-icon-muted) size-4" aria-hidden />
      </span>
    </Link>
  );
}
