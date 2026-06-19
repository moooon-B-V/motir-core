import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ReportScopeDto } from '@/lib/dto/reports';
import { coercePeriod, coerceDaysBack, PERIOD_LABEL_KEY } from '@/lib/reports/reportPageView';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import { AverageAgeReport, type AverageAgeResult } from '../_components/AverageAgeReport';

// The Average-age report page (Story 8.8 · Subtask 8.8.13) — per
// design/reports/more-reports.mock.html panel 2. Server Component: it resolves
// the active project, coerces the URL config (forgiving — a hand-edited/shared
// URL degrades to a valid window, never a 422), calls the 8.8.13 read, and hands
// the envelope to the client body that renders the vertical bar chart + the
// URL-driven controls. The config round-trips through the URL, so a configured
// report is shareable and reloads/restores.

export default async function AverageAgePage({
  searchParams,
}: {
  searchParams: Promise<{ savedFilterId?: string; period?: string; daysBack?: string }>;
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
        title={t('averageAge.title')}
        subLine=""
      >
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </ReportPageChrome>
    );
  }

  const sp = await searchParams;
  const savedFilterId = sp.savedFilterId ?? null;
  const period = coercePeriod(sp.period ?? null);
  const daysBack = coerceDaysBack(period, sp.daysBack ?? null);

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const scope: ReportScopeDto = savedFilterId ? { savedFilterId } : { projectId: ctx.projectId };

  const [result, filtersPage] = await Promise.all([
    reportsService.getAverageAge(scope, { period, daysBack }, accessCtx),
    savedFiltersService.list(ctx.project.identifier, { view: 'all' }, accessCtx),
  ]);

  const clientResult: AverageAgeResult =
    result.state === 'ok'
      ? { state: 'ok', data: result.data }
      : result.state === 'no_access'
        ? { state: 'no_access' }
        : { state: 'stale', reason: result.reason };

  const windowAverage = result.state === 'ok' ? result.data.windowAverage : null;
  const subLine = [
    ctx.project.name,
    t(PERIOD_LABEL_KEY[period]),
    t('averageAge.subWindow', { days: daysBack }),
    windowAverage !== null ? t('averageAge.subAverage', { days: windowAverage }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('averageAge.title')}
      subLine={subLine}
    >
      <AverageAgeReport
        result={clientResult}
        period={period}
        daysBack={daysBack}
        savedFilterId={savedFilterId}
        projectName={ctx.project.name}
        savedFilters={filtersPage.items.map((f) => ({ id: f.id, name: f.name }))}
      />
    </ReportPageChrome>
  );
}
