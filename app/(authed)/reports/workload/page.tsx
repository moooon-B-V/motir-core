import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ReportScopeDto } from '@/lib/dto/reports';
import { coerceMeasure } from '@/lib/reports/reportPageView';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import { WorkloadReport, type WorkloadResult } from '../_components/WorkloadReport';

// The Workload report page (Story 8.8 · Subtask 8.8.13) — per
// design/reports/more-reports.mock.html panel 4. Server Component: it resolves
// the active project, coerces the URL measure (forgiving — a hand-edited/shared
// URL degrades to the default measure, never a 422), calls the 8.8.13 read, and
// hands the envelope to the client body that renders the horizontal ranked bar
// chart + the URL-driven Measure toggle. The config round-trips through the URL,
// so a configured report is shareable and reloads/restores.

export default async function WorkloadPage({
  searchParams,
}: {
  searchParams: Promise<{ savedFilterId?: string; measure?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <ReportPageChrome
        backLabel={t('backToReports')}
        crumb={t('hub.title')}
        title={t('workload.title')}
        subLine=""
      >
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </ReportPageChrome>
    );
  }

  const sp = await searchParams;
  const savedFilterId = sp.savedFilterId ?? null;
  const measure = coerceMeasure(sp.measure ?? null);

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const scope: ReportScopeDto = savedFilterId ? { savedFilterId } : { projectId: ctx.projectId };

  const [result, filtersPage] = await Promise.all([
    reportsService.getWorkload(scope, { measure }, accessCtx),
    savedFiltersService.list(ctx.project.identifier, { view: 'all' }, accessCtx),
  ]);

  const clientResult: WorkloadResult =
    result.state === 'ok'
      ? { state: 'ok', data: result.data }
      : result.state === 'no_access'
        ? { state: 'no_access' }
        : { state: 'stale', reason: result.reason };

  const subLine =
    result.state === 'ok'
      ? [
          ctx.project.name,
          measure === 'issue_count'
            ? t('workload.subCount', { count: result.data.totalCount })
            : t('workload.subPoints', {
                points: result.data.totalPoints,
                count: result.data.totalCount,
              }),
        ].join(' · ')
      : ctx.project.name;

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('workload.title')}
      subLine={subLine}
    >
      <WorkloadReport
        result={clientResult}
        measure={measure}
        savedFilterId={savedFilterId}
        projectName={ctx.project.name}
        savedFilters={filtersPage.items.map((f) => ({ id: f.id, name: f.name }))}
      />
    </ReportPageChrome>
  );
}
