import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, Clock, Repeat } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { NotAppliedBadge } from './LessonBadges';
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
 * ⚠️ THE ACTION IS A SIBLING OF THE LINK, NEVER A CHILD OF IT (MOTIR-3346).
 * §L11 asks for "a real button inside the row" and for the row to be a link, and
 * a `<button>` nested in an `<a>` is invalid HTML that axe flags twice —
 * `nested-interactive` (serious) and an unreachable control for anyone
 * navigating by role. So the ROW is a container, and the link and the button sit
 * side by side inside it: the link still covers the text and still takes the
 * takeaway as its accessible name, and the button gets its own.
 *
 * The hover tint moves to the container via `group-hover`, so the row still
 * lights up as one thing.
 */
export function LessonRow({
  lesson,
  href,
  copy,
  action,
}: {
  lesson: ProjectLessonDTO;
  href: string;
  copy: LessonRowCopy;
  /**
   * The row's right-hand gutter WHEN THIS READER MAY ACT (MOTIR-3346) — the
   * badge and the control together, as one client island.
   *
   * Passed IN rather than rendered here for two reasons. Whether it appears at
   * all is a PERMISSION question the server has already answered, and this
   * component is shared with the door card's read-only preview — a row that
   * decided for itself would be a second implementation of the rule. And the
   * badge travels WITH it, because badge and button are one piece of state (see
   * the note at the gutter below).
   */
  action?: ReactNode;
}) {
  const notApplied = lesson.injectionBlock !== null;
  const axes: { axis: string; value: string }[] = [
    ...lesson.kinds.map((value) => ({ axis: 'kind', value })),
    ...lesson.types.map((value) => ({ axis: 'type', value })),
    ...lesson.phases.map((value) => ({ axis: 'phase', value })),
  ];
  return (
    <div
      data-testid="lesson-row"
      data-not-applied={notApplied ? 'true' : undefined}
      className="group border-(--el-border-soft) hover:bg-(--el-surface-soft) flex items-start gap-3.5 border-b px-(--spacing-card-padding) py-3.5 last:border-b-0"
    >
      <Link href={href} className="flex min-w-0 flex-1 items-start gap-3.5">
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
          {/* ⚠️ THE BADGE IS RENDERED HERE **ONLY WHEN NOBODY CAN ACT**
              (MOTIR-3346). When there IS an action, the badge moves inside the
              client island with it — because the badge is the acted-on row's OWN
              state, and the page-state contract says that comes from the
              mutation RESPONSE, never from a re-read. Left server-rendered, it
              would keep saying "applied" after a retire until something
              refreshed it, and the only thing that could refresh it is exactly
              the `router.refresh()` the contract forbids for this surface. Two
              renderers for one badge would be a worse answer than one that moves. */}
          {action === undefined && lesson.injectionBlock !== null && (
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
      {action !== undefined && <span className="shrink-0 pt-px">{action}</span>}
    </div>
  );
}

// Re-exported so the detail page's existing import site keeps resolving.
export { NotAppliedBadge } from './LessonBadges';
