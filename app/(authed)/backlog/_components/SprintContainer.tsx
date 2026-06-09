'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Calendar, ChevronDown, Gauge, Hash, MoreHorizontal, Play } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { SprintDto } from '@/lib/dto/sprints';
import { BacklogRows, useRankedIssues } from './BacklogList';
import { CreateIssueRow } from './CreateIssueRow';
import { StartSprintDialog } from './StartSprintDialog';
import { sprintRegionId } from './backlogDnd';
import { SPRINT_STATE_TONE, type StatusByKey } from './backlogShared';

// A sprint-planning container (Story 4.2 · Subtask 4.2.3, read render). A
// collapsible panel per design/backlog/backlog.mock.html panel 1: chevron, name
// + state `Pill`, date range, the bounded issue-count badge, the reserved
// committed-points + velocity SEAM slots, the Start-sprint entry-point seam, the
// `⋯` menu (placed), the sprint's ranked issue rows (bound to 4.1.4
// `getSprintIssues` via `/api/sprints/[id]/issues`), and the placed inline
// create-row.
//
// SEAMS (4.2.1 design notes — drawn, not improvised): the committed-points slot
// is filled by Story 4.3, the velocity slot by Story 4.6. The Start-sprint FLOW
// is now WIRED (Story 4.4 · Subtask 4.4.5): on a planned sprint with ≥1 issue the
// entry-point button opens the `StartSprintDialog`; an empty planned sprint keeps
// it disabled (the 4.2.1 rule), and a non-planned sprint shows no Start button
// (its lifecycle action is Complete — Story 4.4.6). The committed-points +
// velocity slots stay labelled `--el-text-faint` placeholders.

function formatDateRange(
  startDate: string | null,
  endDate: string | null,
  locale: string,
  notStarted: string,
): string {
  if (!startDate || !endDate) return notStarted;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

export function SprintContainer({
  sprint,
  statusByKey,
  assigneeNameById,
  projectName,
  activeSprint,
  onStarted,
}: {
  sprint: SprintDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Project name + the project's active sprint — for the start dialog's
   *  friendly one-active-sprint message (Subtask 4.4.5). */
  projectName: string;
  activeSprint: SprintDto | null;
  /** Refresh the sprint list after a successful start. */
  onStarted: () => void | Promise<void>;
}) {
  const t = useTranslations('backlog');
  const locale = useLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const state = useRankedIssues(`/api/sprints/${sprint.id}/issues`);

  const stateLabel = t(`sprintState.${sprint.state}`);
  const dateRange = formatDateRange(sprint.startDate, sprint.endDate, locale, t('notStarted'));

  // The Start-sprint entry point (4.2.3 seam) is live ONLY for a planned sprint;
  // enabled once it holds ≥1 issue (the 4.2.1 rule), disabled-with-reason when
  // empty. A non-planned sprint shows no Start button (Complete is its action).
  const isPlanned = sprint.state === 'planned';
  const canStart = isPlanned && sprint.issueCount >= 1;

  return (
    <section
      aria-label={t('sprintRegionLabel', {
        name: sprint.name,
        state: stateLabel,
        count: sprint.issueCount,
      })}
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-subtle)"
    >
      <div className="flex items-center gap-2 border-b border-(--el-border) px-(--spacing-card-padding) py-(--spacing-control-y)">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandSprint') : t('collapseSprint')}
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface-soft)"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        <span className="font-semibold text-(--el-text-strong)">{sprint.name}</span>
        <Pill status={SPRINT_STATE_TONE[sprint.state]}>{stateLabel}</Pill>
        <span className="flex items-center gap-1 text-xs text-(--el-text-muted)">
          <Calendar className="h-3.5 w-3.5" aria-hidden />
          {dateRange}
        </span>
        <span
          className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)"
          data-testid={`sprint-count-${sprint.id}`}
        >
          {sprint.issueCount}
        </span>
        <span className="flex-1" />
        {/* Committed-points SEAM → Story 4.3 (reserved, not computed). */}
        <span
          className="flex items-center gap-1 text-xs text-(--el-text-faint)"
          title={t('committedPointsSeam')}
          aria-label={t('committedPointsSeam')}
        >
          <Hash className="h-3.5 w-3.5" aria-hidden />
          {t('pointsPlaceholder')}
        </span>
        {/* Velocity SEAM → Story 4.6 (reserved, not computed). */}
        <span
          className="flex items-center gap-1 text-xs text-(--el-text-faint)"
          title={t('velocitySeam')}
          aria-label={t('velocitySeam')}
        >
          <Gauge className="h-3.5 w-3.5" aria-hidden />
          {t('velocityPlaceholder')}
        </span>
        {/* Start-sprint entry point (4.2.3 seam) — WIRED to the flow (4.4.5).
            Rendered only for a planned sprint; disabled until it has ≥1 issue. */}
        {isPlanned ? (
          <button
            type="button"
            disabled={!canStart}
            title={canStart ? undefined : t('startSprintEmpty')}
            onClick={() => setStartOpen(true)}
            className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) hover:border-(--el-accent) hover:text-(--el-accent) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-(--el-border) disabled:hover:text-(--el-text-secondary)"
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            {t('startSprint')}
          </button>
        ) : null}
        {/* `⋯` sprint menu — PLACED; wired in Subtask 4.2.5. */}
        <button
          type="button"
          disabled
          aria-label={t('sprintActions')}
          title={t('sprintActionsComingSoon')}
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) disabled:opacity-40"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {collapsed ? null : (
        <div className="p-(--spacing-control-x)">
          <BacklogRows
            state={state}
            statusByKey={statusByKey}
            assigneeNameById={assigneeNameById}
            ariaLabel={t('sprintIssuesLabel', { name: sprint.name })}
            maxHeightClass="max-h-[50vh]"
            regionId={sprintRegionId(sprint.id)}
            regionKind="sprint"
            regionLabel={sprint.name}
            sprintId={sprint.id}
            createRow={<CreateIssueRow />}
            createRowOnEmpty
            emptyState={
              <p className="my-1 rounded-(--radius-card) border border-dashed border-(--el-border) px-(--spacing-control-x) py-4 text-center text-xs text-(--el-text-muted)">
                {t('sprintEmpty')}
              </p>
            }
          />
        </div>
      )}

      {isPlanned ? (
        <StartSprintDialog
          open={startOpen}
          onOpenChange={setStartOpen}
          sprint={sprint}
          projectName={projectName}
          activeSprint={activeSprint}
          onStarted={onStarted}
        />
      ) : null}
    </section>
  );
}
