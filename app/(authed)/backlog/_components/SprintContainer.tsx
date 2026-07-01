'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Calendar, CheckCircle2, ChevronDown, Gauge, Play } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { SprintPointsBadge } from '@/components/issues/SprintPointsBadge';
import type { SprintDto } from '@/lib/dto/sprints';
import { BacklogRows, useRankedIssues } from './BacklogList';
import { CreateIssueRow } from './CreateIssueRow';
import { StartSprintDialog } from './StartSprintDialog';
import { CompleteSprintDialog } from './CompleteSprintDialog';
import { SprintActionsMenu } from './SprintActionsMenu';
import { useSprintPoints } from './useSprintPoints';
import { useBacklogDnd } from './BacklogDndProvider';
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
// is now FILLED (Story 4.4 · Subtask 4.4.9 — finding #69) by the live
// `rollupForSprint` roll-up via `GET /api/sprints/[id]/points`; the velocity slot
// stays a labelled `--el-text-faint` placeholder for Story 4.6. The Start-sprint
// FLOW is WIRED (Story 4.4 · Subtask 4.4.5): on a planned sprint with ≥1 issue the
// entry-point button opens the `StartSprintDialog`; an empty planned sprint keeps
// it disabled (the 4.2.1 rule). An ACTIVE sprint shows a **Complete sprint**
// entry point instead — self-mounted here (Story 4.4.6) and wired to the
// `CompleteSprintDialog` (carry-over chooser + sprint report); Story 4.5.3 mounts
// the SAME flow in the scrum header (4.5 → 4.4, one-way).

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
  order,
  statusByKey,
  assigneeNameById,
  projectName,
  activeSprint,
  plannedSprints,
  onStarted,
  onCompleted,
  onRenamed,
  onDeleted,
  onUpdated,
  issuesRefreshKey,
  filterQuery,
  filterActive,
}: {
  sprint: SprintDto;
  /** Top-to-bottom stack position (sprints precede the backlog) — shift-range order (4.2.5). */
  order: number;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  /** Project name + the project's active sprint — for the start dialog's
   *  friendly one-active-sprint message (Subtask 4.4.5). */
  projectName: string;
  activeSprint: SprintDto | null;
  /** The project's PLANNED sprints — the complete dialog's carry-over targets
   *  (Subtask 4.4.6); used only when this container is the active sprint. */
  plannedSprints: SprintDto[];
  /** Refresh the sprint list after a successful start. */
  onStarted: () => void | Promise<void>;
  /** Refresh the sprint list after a sprint is completed (it drops out of the
   *  planning view). Fires on the complete dialog's close (Subtask 4.4.6). */
  onCompleted: () => void | Promise<void>;
  /** Refresh the sprint list after this sprint is renamed (MOTIR-1493) — the
   *  header name + region aria-label re-read from the refetched metadata. */
  onRenamed: () => void | Promise<void>;
  /** Refresh the backlog after this sprint is deleted (Subtask 4.2.5 /
   *  MOTIR-1492) — the deleted sprint drops out of the planning view AND its
   *  work items fall back to the backlog list, so both must re-read. */
  onDeleted: () => void | Promise<void>;
  /** Refresh the sprint list after an in-place edit (e.g. dates, MOTIR-1494) —
   *  no issues move, so only the `/api/sprints` metadata re-reads (the header's
   *  date range). */
  onUpdated: () => void | Promise<void>;
  /** Bumped when ANY sprint completes — re-reads this card's issue list so a
   *  carry-over INTO this (planned target) sprint shows the moved rows (bug 11). */
  issuesRefreshKey: number;
  /** Active-filter querystring appended to the sprint's `/api/sprints/[id]/issues`
   *  fetch (Subtask 8.8.18) — the read became filter-aware in 8.8.20, so the
   *  sprint re-projects to its matching rows + filtered count. '' → unfiltered. */
  filterQuery: string;
  filterActive: boolean;
}) {
  const t = useTranslations('backlog');
  const locale = useLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  // The filter rides the fetch query (8.8.20) so the sprint shows only matching
  // rows + the FILTERED total; a change re-navigates the page → new prop → new
  // endpoint → `useRankedIssues` refetches (no router.refresh).
  const endpoint = filterQuery
    ? `/api/sprints/${sprint.id}/issues?${filterQuery}`
    : `/api/sprints/${sprint.id}/issues`;
  const state = useRankedIssues(endpoint, issuesRefreshKey);
  // Live committed-points roll-up (Subtask 4.4.9 — finding #69) filling the
  // Story-4.3 seam: a null read or a wholly-unestimated sprint renders "—".
  // `sprintPointsRefreshKey` is the tick the dnd coordinator bumps after a
  // membership change / point edit commits, so the badge re-fetches its ON-READ
  // roll-up instead of showing a stale figure until a page reload (MOTIR-1495).
  const { sprintPointsRefreshKey } = useBacklogDnd();
  const points = useSprintPoints(sprint.id, true, sprintPointsRefreshKey);

  const stateLabel = t(`sprintState.${sprint.state}`);
  const dateRange = formatDateRange(sprint.startDate, sprint.endDate, locale, t('notStarted'));

  // The Start-sprint entry point (4.2.3 seam) is live ONLY for a planned sprint;
  // enabled once it holds ≥1 issue (the 4.2.1 rule), disabled-with-reason when
  // empty. An ACTIVE sprint shows the Complete-sprint entry point instead (4.4.6).
  const isPlanned = sprint.state === 'planned';
  const isActive = sprint.state === 'active';
  const canStart = isPlanned && sprint.issueCount >= 1;

  return (
    <section
      aria-label={t('sprintRegionLabel', {
        name: sprint.name,
        state: stateLabel,
        count: sprint.issueCount,
      })}
      // surface-material hook (glass frost / aurora glow); inert under
      // non-material styles. 7.3.38.
      data-surface="card"
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
          {/* Filtered → "X of Y" (the design's "1 of 5" badge): X is the FILTERED
              total from the sprint read, Y the sprint's full committed count
              (`/api/sprints` metadata, kept unfiltered). Unfiltered → just Y. */}
          {filterActive
            ? t('filteredCount', { matched: state.totalCount, total: sprint.issueCount })
            : sprint.issueCount}
        </span>
        <span className="flex-1" />
        {/* Committed-points roll-up (Subtask 4.3.5; fills the Story-4.2 seam 4.4.9
            stopgapped): the full committed · done · left figure per the design,
            from the shared `useSprintPoints` read. "—" when unestimated. */}
        <SprintPointsBadge points={points} state={sprint.state} />
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
            className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) hover:border-(--el-accent) hover:text-(--el-accent-on-surface) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-(--el-border) disabled:hover:text-(--el-text-secondary)"
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            {t('startSprint')}
          </button>
        ) : null}
        {/* Complete-sprint entry point (self-mounted, Subtask 4.4.6) — the active
            sprint's lifecycle action; opens the carry-over chooser + report. */}
        {isActive ? (
          <button
            type="button"
            onClick={() => setCompleteOpen(true)}
            data-testid={`complete-sprint-${sprint.id}`}
            className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-medium text-(--el-text-secondary) hover:border-(--el-accent) hover:text-(--el-accent-on-surface)"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t('completeSprint')}
          </button>
        ) : null}
        {/* `⋯` sprint actions menu — ENABLED + Delete wired (Subtask 4.2.5 /
            MOTIR-1492); Rename (MOTIR-1493) + Edit-dates (MOTIR-1494) sibling items. */}
        <SprintActionsMenu
          sprint={sprint}
          onRenamed={onRenamed}
          onDeleted={onDeleted}
          onUpdated={onUpdated}
        />
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
            regionOrder={order}
            sprintId={sprint.id}
            createRow={<CreateIssueRow sprintId={sprint.id} />}
            // No create-into-sprint prompt when the empty is filter-driven — the
            // sprint has issues, none match (the design's dashed placeholder).
            createRowOnEmpty={!filterActive}
            emptyState={
              <p className="my-1 rounded-(--radius-card) border border-dashed border-(--el-border) px-(--spacing-control-x) py-4 text-center text-xs text-(--el-text-muted)">
                {filterActive ? t('sprintFilterEmpty') : t('sprintEmpty')}
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

      {isActive ? (
        <CompleteSprintDialog
          open={completeOpen}
          onOpenChange={setCompleteOpen}
          sprint={sprint}
          projectName={projectName}
          plannedSprints={plannedSprints}
          statusByKey={statusByKey}
          onCompleted={onCompleted}
        />
      ) : null}
    </section>
  );
}
