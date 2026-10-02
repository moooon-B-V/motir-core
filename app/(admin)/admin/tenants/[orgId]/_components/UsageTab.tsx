import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/ErrorState';
import type { PlatformOrgUsageTabDTO } from '@/lib/dto/platform';
import { buildSpendSheet, recentMonths } from '@/lib/platform/spend';
import { SpendPeriodSwitch } from '../../../_components/SpendPeriodSwitch';
import { formatMicroUsd } from '../../../_components/spendFormat';
import { CategoryModelSheet } from './CategoryModelSheet';
import { ScopePicker } from './ScopePicker';

/**
 * The org page's USAGE & COST tab (MOTIR-7288, design D8 / D11): the scope picker on
 * the left and the period switch on the right of the toolbar row; four figures;
 * the category-and-model sheet. The two list tables beneath it are MOTIR-7293's.
 */
export async function UsageTab({
  data,
  children,
}: {
  data: PlatformOrgUsageTabDTO;
  children?: React.ReactNode;
}) {
  const t = await getTranslations('platformAdmin.orgUsage');
  const tu = await getTranslations('platformAdmin.usage');
  const format = await getFormatter();
  const monthLabel = (ym: string) =>
    format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const scopeValue =
    data.scope.level === 'organization' ? 'organization' : `${data.scope.level}:${data.scope.id}`;
  const scopeLabel =
    data.scope.level === 'organization'
      ? data.organization.name
      : data.scope.level === 'workspace'
        ? data.scope.name
        : `${data.scope.workspace.name} › ${data.scope.name}`;
  const periodLabel = data.period === 'all' ? tu('period.allTime') : monthLabel(data.period);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopePicker
          value={scopeValue}
          scopes={data.scopes}
          labels={{
            scope: t('scope'),
            organization: t('wholeOrg', { name: data.organization.name }),
          }}
        />
        <SpendPeriodSwitch
          period={data.period}
          months={recentMonths().map((value) => ({ value, label: monthLabel(value) }))}
          labels={{
            month: tu('period.month'),
            allTime: tu('period.allTime'),
            group: tu('period.label'),
          }}
        />
      </div>
      <p className="font-sans text-sm text-(--el-text-secondary)" aria-live="polite">
        {t('showing', { scope: scopeLabel, period: periodLabel })}
      </p>

      {!data.usage ? (
        <ErrorState title={t('unavailable.title')} description={t('unavailable.description')} />
      ) : (
        <UsageBody data={data} t={t} />
      )}
      {children}
    </>
  );
}

async function UsageBody({
  data,
  t,
}: {
  data: PlatformOrgUsageTabDTO;
  t: Awaited<ReturnType<typeof getTranslations<'platformAdmin.orgUsage'>>>;
}) {
  const format = await getFormatter();
  const usage = data.usage!;
  const sheet = buildSpendSheet(usage.categories);
  const seconds = (c: string) => usage.categories.find((x) => x.category === c)?.usageQuantity ?? 0;
  const minutes = (s: number) => format.number(s / 60, { maximumFractionDigits: 0 });
  const split = [
    ['agentRun', seconds('agent_machine')],
    ['instances', seconds('agent_instance')],
    ['ci', seconds('ci')],
    ['indexing', seconds('indexing')],
  ] as const;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card data-testid="org-usage-figure-charged">
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('figures.charged')}
          </span>
          <span className="block font-sans text-xl font-semibold tabular-nums">
            {format.number(sheet.chargedCredits)}
          </span>
        </Card>
        <Card data-testid="org-usage-figure-cost">
          <span className="font-sans text-xs text-(--el-text-secondary)">{t('figures.cost')}</span>
          <span className="block font-sans text-xl font-semibold tabular-nums">
            {formatMicroUsd(format, sheet.costMicroUsdInclIndexing)}
          </span>
        </Card>
        <Card data-testid="org-usage-figure-machine">
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('figures.machine')}
          </span>
          <span className="block font-sans text-xl font-semibold tabular-nums">
            {minutes(usage.spend.machineSeconds)}
          </span>
          <span className="block font-sans text-xs text-(--el-text-secondary)">
            {split.map(([k, s]) => t(`figures.split.${k}`, { minutes: minutes(s) })).join(' · ')}
          </span>
        </Card>
        <Card data-testid="org-usage-figure-balance">
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('figures.balance')}
          </span>
          <span className="block font-sans text-xl font-semibold tabular-nums">
            {data.balance === null ? '—' : format.number(data.balance)}
          </span>
        </Card>
      </div>
      <Card
        className="overflow-x-auto p-0"
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('sheet.title')}</h2>
        }
      >
        <CategoryModelSheet
          categories={usage.categories}
          models={usage.models}
          belowOrg={data.scope.level === 'organization' ? null : data.scope.level}
        />
      </Card>
    </>
  );
}
