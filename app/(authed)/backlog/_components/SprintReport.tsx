'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Circle,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { IssueType } from '@/lib/issues/parentRules';
import type { SprintDto, SprintReportDto } from '@/lib/dto/sprints';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';
import type { BurndownSeriesDto, VelocityDto } from '@/lib/dto/reports';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { StatusValue } from '../../issues/_components/issueCellPrimitives';
import type { StatusByKey } from './backlogShared';
import { ReportBurndownSection } from './ReportBurndownSection';
import { VelocityChart } from './VelocityChart';

// The sprint report (Story 4.4 · Subtask 4.4.6) — what got done vs. what did not,
// per design/sprints/sprint-lifecycle.mock.html panels 6–7. A PURE presentational
// component (no fetching) so the SAME surface renders in two places: inline as the
// complete-modal success state (`CompleteSprintDialog`) AND as the standalone
// closed-sprint report page (app/(authed)/sprints/[id]/report). The caller owns
// the title + chrome (the Modal / the page header); this renders the body — the
// points rollup, the scope-change line, the completed / not-completed issue lists
// (bounded page + a "View all in Issues" deep-link, finding #57 — never a full
// dump), and the report's analytics: the completed-sprint BURNDOWN (Subtask
// 4.6.5 — the `ReportBurndownSection` slot, server-fed on the page,
// self-fetching in the modal) beside the velocity chart (4.6.6) in the
// Story-4.6 chart seam.
//
// Issue rows reuse the work-items list-row vocabulary (the `IssueTypeIcon` in its
// `--el-type-*` hue, the mono key, the truncating summary, the status `Pill` via
// `StatusValue`) — the design's "reference, don't redraw" rule. Colour via
// `--el-*`, shape via element-semantic tokens; counts + points are text+number,
// never colour alone (finding #35).
//
// `carryOverLabel` (the complete-modal success state only) renders the "→ {dest}"
// chip the mock draws on a carried-over row — the success state is the PRE-MOVE
// snapshot, so the incomplete issues are still listed with where they went. The
// standalone page passes no label (the carry-over already happened, and
// `getSprintReport` reads live membership — see the page).

function formatDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface SprintReportProps {
  report: SprintReportDto;
  /** The sprint being reported on — for the header window / completedAt / goal. */
  sprint: SprintDto;
  /** status key → label/category for the row status pills. */
  statusByKey: StatusByKey;
  /**
   * The carry-over destination label (e.g. "Backlog" or a sprint name) — present
   * only in the complete-modal success state, where the incomplete rows are the
   * pre-move snapshot and show where each issue was carried. Absent on the
   * standalone page.
   */
  carryOverLabel?: string | null;
  /**
   * The cross-sprint velocity read (4.6.4 `getVelocity`) — present on the
   * standalone report page, which fetches it server-side; the report then shows
   * the velocity chart beside the burndown in the Story-4.6 chart seam
   * (design/reports/charts.mock.html panel 5). Absent in the complete-modal
   * success state (the 4.4.1 modal design draws only the burndown section).
   */
  velocity?: VelocityDto;
  /**
   * The completed-sprint burndown read (4.6.3 `getBurndownSeries`) — present on
   * the standalone report page, which fetches it server-side. When absent (the
   * complete-modal success state), the burndown slot fetches it client-side for
   * the just-completed sprint (see `ReportBurndownSection`).
   */
  burndown?: BurndownSeriesDto;
}

export function SprintReport({
  report,
  sprint,
  statusByKey,
  carryOverLabel,
  velocity,
  burndown,
}: SprintReportProps) {
  const t = useTranslations('backlog');
  const locale = useLocale();

  // A wholly-unestimated sprint (started with no story points) shows "—" for all
  // three point figures — the DTO stays total (0/null), the UI owns the dash (the
  // 4.5.2 pattern). A partially-estimated sprint shows the real numbers.
  const unestimated = report.points.committed === null;
  const dash = t('sprintReport.pointDash');
  const pointCell = (value: number | null) =>
    unestimated || value === null ? dash : String(value);

  const meta: string[] = [];
  if (sprint.startDate && sprint.endDate) {
    meta.push(
      t('sprintReport.metaWindow', {
        start: formatDay(sprint.startDate, locale),
        end: formatDay(sprint.endDate, locale),
      }),
    );
  }
  if (sprint.completedAt) {
    meta.push(t('sprintReport.metaCompleted', { date: formatDay(sprint.completedAt, locale) }));
  }
  if (sprint.goal) meta.push(t('sprintReport.metaGoal', { goal: sprint.goal }));

  return (
    <div className="flex flex-col gap-4">
      {meta.length > 0 ? (
        <p className="text-sm text-(--el-text-muted)">{meta.join(' · ')}</p>
      ) : null}

      {/* 3-up points rollup — committed (baseline) / completed / not-completed. */}
      <div className="grid grid-cols-3 gap-2">
        <PointStat
          label={t('sprintReport.pointsCommitted')}
          value={pointCell(report.points.committed)}
        />
        <PointStat
          label={t('sprintReport.pointsCompleted')}
          value={pointCell(report.points.completed)}
          done
        />
        <PointStat
          label={t('sprintReport.pointsNotCompleted')}
          value={pointCell(report.points.notCompleted)}
        />
      </div>

      {report.addedAfterStart > 0 ? (
        <p className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
          <TriangleAlert className="h-4 w-4 shrink-0 text-(--el-warning)" aria-hidden />
          <span>{t('sprintReport.scopeChange', { count: report.addedAfterStart })}</span>
        </p>
      ) : null}

      <ReportSection
        title={t('sprintReport.sectionCompleted')}
        count={report.completed.totalCount}
        page={report.completed}
        sprintId={report.sprintId}
        statusByKey={statusByKey}
        emptyLabel={t('sprintReport.emptyCompleted')}
        viewAllLabel={t('sprintReport.viewAllInIssues')}
        dash={dash}
        done
      />

      <ReportSection
        title={t('sprintReport.sectionNotCompleted')}
        count={report.incomplete.totalCount}
        page={report.incomplete}
        sprintId={report.sprintId}
        statusByKey={statusByKey}
        emptyLabel={t('sprintReport.emptyIncomplete')}
        viewAllLabel={t('sprintReport.viewAllInIssues')}
        dash={dash}
        carryOverLabel={carryOverLabel}
      />

      {/* The report's analytics — the Story-4.6 charts, side by side per
          design/reports/charts.mock.html panel 5. The burndown slot (4.6.5)
          fills the seam 4.4.6 reserved — server-fed on the standalone page,
          self-fetching in the complete-modal success state; the velocity chart
          (4.6.6) renders when the host passes the 4.6.4 read (the page). */}
      <div className="flex flex-wrap gap-4">
        <section className="flex min-w-0 flex-1 basis-[300px] flex-col gap-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
            <TrendingUp className="h-4 w-4 shrink-0 text-(--el-warning)" aria-hidden />
            {t('sprintReport.burndown')}
          </span>
          <ReportBurndownSection sprintId={report.sprintId} burndown={burndown} />
        </section>

        {velocity ? (
          <section className="flex min-w-0 flex-1 basis-[300px] flex-col gap-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
              <BarChart3 className="h-4 w-4 shrink-0 text-(--el-success)" aria-hidden />
              {t('sprintReport.velocity')}
            </span>
            <VelocityChart velocity={velocity} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function PointStat({
  label,
  value,
  done = false,
}: {
  label: string;
  value: string;
  done?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3">
      <span
        className={`font-serif text-2xl font-semibold ${done ? 'text-(--el-success)' : 'text-(--el-text-strong)'}`}
      >
        {value}
      </span>
      <span className="text-xs text-(--el-text-muted)">{label}</span>
    </div>
  );
}

function ReportSection({
  title,
  count,
  page,
  sprintId,
  statusByKey,
  emptyLabel,
  viewAllLabel,
  dash,
  done = false,
  carryOverLabel,
}: {
  title: string;
  count: number;
  page: RankedIssuePageDto;
  sprintId: string;
  statusByKey: StatusByKey;
  emptyLabel: string;
  viewAllLabel: string;
  dash: string;
  done?: boolean;
  carryOverLabel?: string | null;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
          {done ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-(--el-success)" aria-hidden />
          ) : (
            <Circle className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
          )}
          {title}
          <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)">
            {count}
          </span>
        </span>
        {count > 0 ? (
          // Deep-link to the /issues navigator filtered to this sprint (Story 2.5).
          // The ?sprint= param is forward-compatible — see PRODECT_FINDINGS (the
          // navigator does not honour it yet); the link still lands on /issues.
          <Link
            href={`/issues?sprint=${sprintId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {viewAllLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-(--radius-card) border border-dashed border-(--el-border) px-(--spacing-control-x) py-4 text-center text-xs text-(--el-text-muted)">
          {emptyLabel}
        </p>
      ) : (
        <div className="flex flex-col gap-1" role="list">
          {page.items.map((item) => (
            <ReportIssueRow
              key={item.id}
              item={item}
              statusByKey={statusByKey}
              dash={dash}
              carryOverLabel={carryOverLabel}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReportIssueRow({
  item,
  statusByKey,
  dash,
  carryOverLabel,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  dash: string;
  carryOverLabel?: string | null;
}) {
  const t = useTranslations('backlog');
  const status = statusByKey.get(item.status);

  return (
    <div
      role="listitem"
      data-testid={`report-row-${item.identifier}`}
      className="flex items-center gap-2 rounded-(--radius-control) border border-transparent px-(--spacing-control-x) py-(--spacing-control-y) hover:border-(--el-border-soft) hover:bg-(--el-surface-soft)"
    >
      <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4 shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">{item.title}</span>
      <span className="shrink-0">
        {status ? (
          <StatusValue category={status.category} label={status.label} />
        ) : (
          <StatusValue category={null} label={item.status} />
        )}
      </span>
      {carryOverLabel ? (
        // A carried-over row shows where it went (mock panel 6 "→ Backlog").
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-(--el-text-muted)">
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          {t('sprintReport.carriedTo', { destination: carryOverLabel })}
        </span>
      ) : (
        <span className="w-8 shrink-0 text-right text-xs font-semibold text-(--el-text-secondary)">
          {item.storyPoints ?? dash}
        </span>
      )}
    </div>
  );
}
