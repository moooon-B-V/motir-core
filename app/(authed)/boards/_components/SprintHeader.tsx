'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CalendarRange, Clock, Target } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import type { SprintSummaryDto } from '@/lib/dto/boards';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { SPRINT_STATE_TONE } from '@/app/(authed)/backlog/_components/backlogShared';
import { CompleteSprintEntry } from './CompleteSprintEntry';
import { SprintHeaderBurndown } from './SprintHeaderBurndown';

// SprintHeader (Subtask 4.5.3) — the ONE net-new UI surface of the scrum board,
// drawn per `design/boards/scrum.mock.html` panels 0–1/3. A labelled landmark
// BAND above the REUSED 3.2/3.3 board, built from the 4.5.2 `SprintSummaryDto`.
// It is a quiet `--el-surface-soft` card band (NOT a tinted page surface —
// finding #35), with two clusters:
//   • LEFT  — sprint name (serif) + state `Pill`; the goal on one line (a `Target`
//     glyph + a bold "Goal ·" lead + the text), truncated with a `Tooltip` reveal;
//     the dates (`CalendarRange`) + time remaining (`Clock` "N days remaining", or
//     the "Ended" peach chip when `daysRemaining == 0`).
//   • RIGHT — the points summary (Committed / Completed / Remaining as labelled
//     NUMBERS, Remaining on the lavender emphasis tile) + the Complete-sprint entry.
//
// Not-colour-alone (finding #35): time remaining is TEXT; the state is a Pill with
// a WORD; the points are labelled numbers; the "Ended" treatment pairs the peach
// tint with an alert glyph + the word. The state Pill REUSES the shipped
// `SPRINT_STATE_TONE` (the same tone the backlog renders this sprint's state with)
// rather than the mock's bespoke dotted chip — so a sprint's state reads
// identically across the board and the backlog, and no primitive is hand-rolled.
//
// `daysRemaining` (floored at 0 by 4.5.2) drives time remaining — an overdue
// sprint reads "Ended", never a negative number. The points are the
// `SprintSummaryDto.points` bounded aggregate (NOT a sum of loaded cards, finding
// #57); a wholly-unestimated sprint (committed === 0) renders "—" for every figure
// (mirroring the shipped `SprintPointsBadge`), never a broken `NaN`. The reserved
// chart slot is FILLED by Subtask 4.6.5: `SprintHeaderBurndown` mounts the compact
// in-sprint burndown BESIDE the numeric points (charts.mock.html panel 5), without
// restructuring the band. Colour via `--el-*`, shape via element-semantic tokens.

function formatDateRange(startDate: string | null, endDate: string | null, locale: string): string {
  if (!startDate || !endDate) return '';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

function PointStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex min-w-[64px] flex-col items-center gap-0.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) ${
        emphasis ? 'bg-(--el-sprint-accent)' : 'bg-(--el-muted)'
      }`}
    >
      <span className="text-lg leading-none font-bold tabular-nums text-(--el-text-strong)">
        {value}
      </span>
      <span className="text-[10.5px] font-semibold tracking-wide text-(--el-text-muted) uppercase">
        {label}
      </span>
    </div>
  );
}

export function SprintHeader({
  sprint,
  projectName,
  workflow,
  canEdit,
  onSprintCompleted,
}: {
  sprint: SprintSummaryDto;
  /** Active project name + workflow — handed to the Complete-sprint dialog (4.4).
   *  `workflow` is optional only so an isolated render need not supply it; the
   *  Complete-sprint entry is gated on its presence. */
  projectName: string;
  workflow?: WorkflowDto;
  /** Whether the actor may act on the board (Story 6.4.6) — gates the
   *  Complete-sprint entry, matching the read-only board treatment. */
  canEdit: boolean;
  /** Reload the board after the sprint completes (→ no-active-sprint state). */
  onSprintCompleted: () => void | Promise<void>;
}) {
  const t = useTranslations('boards');
  const locale = useLocale();

  const stateLabel = t(`sprintState.${sprint.state}`);
  const dateRange = formatDateRange(sprint.startDate, sprint.endDate, locale);
  // `daysRemaining` is floored at 0 by 4.5.2: 0 → the sprint has reached/passed its
  // end date → "Ended"; > 0 → "N days remaining"; null → no end date set (omit).
  const ended = sprint.daysRemaining === 0;
  const remainingText = ended
    ? t('sprintEnded')
    : sprint.daysRemaining != null
      ? t('sprintDaysRemaining', { days: sprint.daysRemaining })
      : null;

  // Unestimated (committed === 0) → every figure renders "—" (mirrors the shipped
  // SprintPointsBadge); otherwise the bounded aggregate numbers.
  const unestimated = sprint.points.committed === 0;
  const fmtPts = (n: number) => (unestimated ? '—' : String(n));
  const pointsAria = unestimated
    ? t('sprintPointsUnestimatedAria')
    : t('sprintPointsAria', {
        committed: sprint.points.committed,
        completed: sprint.points.completed,
        remaining: sprint.points.remaining,
      });

  return (
    <section
      aria-label={t('sprintRegionLabel', {
        name: sprint.name,
        state: stateLabel,
        remaining: remainingText ?? dateRange,
      })}
      data-testid="sprint-header"
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-(--spacing-control-x)"
    >
      {/* LEFT — name + state, goal (truncated, Tooltip reveal), dates + remaining */}
      <div className="flex min-w-0 flex-1 basis-[360px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="font-serif text-lg leading-tight font-semibold text-(--el-text-strong)">
            {sprint.name}
          </h2>
          <Pill status={SPRINT_STATE_TONE[sprint.state]}>{stateLabel}</Pill>
        </div>

        {sprint.goal ? (
          <div className="flex min-w-0 max-w-[560px] items-center gap-1.5 text-[13.5px] text-(--el-text-secondary)">
            <Target className="h-3.5 w-3.5 shrink-0 text-(--el-text-muted)" aria-hidden />
            <Tooltip content={sprint.goal}>
              <span tabIndex={0} className="block min-w-0 cursor-default truncate">
                <span className="font-semibold text-(--el-text-strong)">{t('sprintGoalLead')}</span>{' '}
                · {sprint.goal}
              </span>
            </Tooltip>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[13px] text-(--el-text-secondary)">
          {dateRange ? (
            <span className="inline-flex items-center gap-1.5">
              <CalendarRange className="h-3.5 w-3.5 text-(--el-text-muted)" aria-hidden />
              {dateRange}
            </span>
          ) : null}
          {ended ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[12.5px] font-semibold text-(--el-text-strong)"
              title={t('sprintEndedTitle')}
            >
              <AlertTriangle className="h-3.5 w-3.5 text-(--el-warning)" aria-hidden />
              {remainingText}
            </span>
          ) : remainingText ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-(--el-text-muted)" aria-hidden />
              {remainingText}
            </span>
          ) : null}
        </div>
      </div>

      {/* RIGHT — the compact burndown (the 4.6.5-filled chart slot), the points
          summary, and the Complete-sprint entry point */}
      <div className="flex shrink-0 flex-wrap items-center gap-4">
        <SprintHeaderBurndown sprintId={sprint.id} />
        <div className="flex items-stretch gap-1" aria-label={pointsAria}>
          <PointStat label={t('sprintCommitted')} value={fmtPts(sprint.points.committed)} />
          <PointStat label={t('sprintCompleted')} value={fmtPts(sprint.points.completed)} />
          <PointStat
            label={t('sprintRemaining')}
            value={fmtPts(sprint.points.remaining)}
            emphasis
          />
        </div>
        {canEdit && workflow ? (
          <CompleteSprintEntry
            sprintId={sprint.id}
            projectName={projectName}
            workflow={workflow}
            onCompleted={onSprintCompleted}
          />
        ) : null}
      </div>
    </section>
  );
}
