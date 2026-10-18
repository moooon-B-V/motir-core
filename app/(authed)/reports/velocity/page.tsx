import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { VelocityChart } from '@/app/(authed)/backlog/_components/VelocityChart';
import { pageChart } from '@/components/ui/charts/tokens';
import { coerceVelocityCount } from '@/lib/reports/reportPageView';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import { VelocityRangeControls } from '../_components/VelocityRangeControls';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// The standalone Velocity report page (bug-reports-hub-agile-cards-collapse) —
// the focused, CROSS-SPRINT velocity report Jira's Reports menu lists as its own
// page (mirror-product rung 1). Velocity is project-level history, not a
// per-sprint view, so it had no business hiding behind one sprint's report URL
// (the bug). Composes EXISTING primitives only: the 4.6.6 `VelocityChart` over
// the 4.6.4 `getVelocity` cross-sprint read. Server Component (services-only,
// 4-layer).
//
// Story MOTIR-8919: the reader picks the range — `?endingAt=<completed sprint>`
// and `?count=<n>`; neither set is today's last 7. The controls render from the
// sprint list alone, so they paint ahead of the series, which streams behind an
// in-page `<Suspense>` placed after the page's own gate.

export default async function VelocityReportPage({
  searchParams,
}: {
  searchParams: Promise<{ endingAt?: string; count?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const sp = searchParams ? await searchParams : {};

  // Completed sprints, newest first — the SAME order the read uses
  // (`completedAt desc, sequence desc`), so the picker and the window agree.
  const sprints = await sprintsService.listByProject(ctx.projectId, accessCtx);
  const completed = sprints
    .filter((s) => s.state === 'complete' && s.completedAt)
    .sort(
      (a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!) || b.sequence - a.sequence,
    );

  // A requested end sprint that is not a completed sprint of this project is
  // dropped: the default window renders and the picker shows no stale selection.
  const endIndex = Math.max(
    0,
    completed.findIndex((s) => s.id === sp.endingAt),
  );
  const endingAt = completed.some((s) => s.id === sp.endingAt) ? (sp.endingAt ?? null) : null;
  const count = coerceVelocityCount(sp.count);

  const window = completed.slice(endIndex, endIndex + count);
  const subLine =
    window.length > 1
      ? t('velocity.rangeSubLine', {
          project: ctx.project.name,
          from: window[window.length - 1]!.name,
          to: window[0]!.name,
        })
      : ctx.project.name;

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('velocity.title')}
      subLine={subLine}
      help="velocity"
    >
      <div className="flex flex-col gap-5">
        {completed.length > 0 && (
          <VelocityRangeControls
            sprints={completed.map((s) => ({ id: s.id, name: s.name }))}
            endingAt={endingAt}
            count={count}
          />
        )}
        <Suspense
          fallback={
            <div
              className="nav-pending-frame nav-pending-reveal"
              aria-busy="true"
              data-testid="velocity-skeleton"
            >
              <span className="sr-only">{t('velocity.chartLoading')}</span>
              <div
                className="animate-pulse rounded-(--radius-card) bg-(--el-muted)"
                style={{ height: pageChart.defaultHeight }}
                aria-hidden="true"
              />
            </div>
          }
        >
          <VelocitySeries
            projectId={ctx.projectId}
            accessCtx={accessCtx}
            endSprintId={endingAt ?? undefined}
            count={count}
          />
        </Suspense>
      </div>
    </ReportPageChrome>
  );
}

/** The series itself — an async child so the page can paint the controls first. */
async function VelocitySeries({
  projectId,
  accessCtx,
  endSprintId,
  count,
}: {
  projectId: string;
  accessCtx: { userId: string; workspaceId: string };
  endSprintId?: string;
  count: number;
}) {
  const velocity = await reportsService.getVelocity(
    { projectId, lastN: count, endSprintId },
    accessCtx,
  );
  return <VelocityChart velocity={velocity} />;
}
