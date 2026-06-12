import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ReportScopeDto, ReportWidgetResultDto, DistributionDto } from '@/lib/dto/reports';
import {
  BUILTIN_STATISTIC_TYPES,
  customFieldStatisticId,
  isDistributionCfFieldType,
  parseStatisticType,
} from '@/lib/reports/statisticTypes';
import { UnknownStatisticTypeError } from '@/lib/reports/errors';
import { REPORT_DEFAULTS } from '@/lib/reports/reportPageView';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import {
  DistributionReport,
  type DistributionResult,
  type StatisticOption,
} from '../_components/DistributionReport';

// The Status-distribution report page (Story 6.3 · Subtask 6.3.6) — per
// design/reports/dashboard.mock.html panel 7. Server Component: it resolves the
// active project, builds the TOTAL statistic-type picker (the 8 builtins + the
// project's enum-ish custom fields), coerces the URL config (forgiving), calls
// the 6.3.2 group-by read, and hands the envelope to the client donut body. The
// config round-trips through the URL (shareable; reload restores).

/** Coerce a raw `?statistic` to a well-FORMED id (a builtin or `cf:<id>`),
 * defaulting to `status`. Existence of a `cf:` referent is a DATA question the
 * service resolves (→ the stale state), so this only guards the form. */
function coerceStatistic(raw: string | undefined): string {
  if (!raw) return REPORT_DEFAULTS.statistic;
  try {
    parseStatisticType(raw);
    return raw;
  } catch {
    return REPORT_DEFAULTS.statistic;
  }
}

export default async function DistributionPage({
  searchParams,
}: {
  searchParams: Promise<{ savedFilterId?: string; statistic?: string }>;
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
        title={t('distribution.title')}
        subLine=""
      >
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </ReportPageChrome>
    );
  }

  const sp = await searchParams;
  const savedFilterId = sp.savedFilterId ?? null;
  const statistic = coerceStatistic(sp.statistic);
  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const scope: ReportScopeDto = savedFilterId ? { savedFilterId } : { projectId: ctx.projectId };

  // The picker is TOTAL over the registry (mistake #29): the 8 builtins + the
  // project's enum-ish (select/user) custom fields — the same vocabulary the
  // distribution read groups by, so every offered option resolves.
  const [distribution, fields, filtersPage] = await Promise.all([
    reportsService.getDistribution(scope, statistic, accessCtx).catch((err) => {
      // A `cf:<id>` over a non-enum-ish field type is a 422 — only reachable via
      // a hand-edited URL (the picker never offers it); degrade to the stale
      // state rather than 500 the page.
      if (err instanceof UnknownStatisticTypeError) {
        return {
          state: 'stale',
          reason: 'statistic_missing',
        } satisfies ReportWidgetResultDto<DistributionDto>;
      }
      throw err;
    }),
    customFieldsService.listFields({
      key: ctx.project.identifier,
      actorUserId: ctx.userId,
      ctx: accessCtx,
    }),
    savedFiltersService.list(ctx.project.identifier, { view: 'all' }, accessCtx),
  ]);

  const builtinGroup = t('distribution.builtinGroup');
  const customGroup = t('distribution.customGroup');
  const statisticOptions: StatisticOption[] = [
    ...BUILTIN_STATISTIC_TYPES.map((s) => ({
      value: s.id,
      label: t(`statistic.${s.id}`),
      group: builtinGroup,
    })),
    ...fields
      .filter((f) => isDistributionCfFieldType(f.fieldType))
      .map((f) => ({ value: customFieldStatisticId(f.id), label: f.label, group: customGroup })),
  ];

  const statisticLabel =
    statisticOptions.find((o) => o.value === statistic)?.label ??
    t('distribution.unknownStatistic');

  const clientResult: DistributionResult =
    distribution.state === 'ok'
      ? { state: 'ok', data: distribution.data }
      : distribution.state === 'no_access'
        ? { state: 'no_access' }
        : { state: 'stale', reason: distribution.reason };

  const total = distribution.state === 'ok' ? distribution.data.total : null;
  const subLine = [
    ctx.project.name,
    t('distribution.byStatistic', { statistic: statisticLabel }),
    ...(total === null ? [] : [t('distribution.issuesCount', { count: total })]),
  ].join(' · ');

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('distribution.title')}
      subLine={subLine}
    >
      <DistributionReport
        result={clientResult}
        statistic={statistic}
        statisticLabel={statisticLabel}
        statisticOptions={statisticOptions}
        savedFilterId={savedFilterId}
        projectName={ctx.project.name}
        savedFilters={filtersPage.items.map((f) => ({ id: f.id, name: f.name }))}
      />
    </ReportPageChrome>
  );
}
