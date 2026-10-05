import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/ErrorState';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { parseSpendPeriod, recentMonths } from '@/lib/platform/spend';
import { parseTenantSort, platformUsageService } from '@/lib/services/platformUsageService';
import { SpendPeriodSwitch } from '../_components/SpendPeriodSwitch';
import { TenantSpendTable } from './_components/TenantSpendTable';

/**
 * Tenants — the LIST FIRST (design `console--estate-usage-drilldown.mock.html` **D10**,
 * MOTIR-7287). It replaces the search-first org lookup that was empty until you
 * typed: every organization's spend for the period is on arrival, the estate total
 * over ALL organizations first, sorted by Motir cost, every column sortable, Show
 * more on a keyset.
 *
 * Filter (`q`), period and sort live in the URL — a list is linkable, survives a
 * reload, and is what the org page's ← Tenants returns to. The figures are
 * motir-ai's platform rollup; the names are motir-core's; one audited `estate.read`
 * per view (`platformUsageService.listTenants`).
 */

export const metadata: Metadata = {
  // No description — the console's standing rule (see the landing page).
  title: 'Tenants',
};

/** Never cached: this month's spend moves with every charge. */
export const dynamic = 'force-dynamic';

export default async function AdminTenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; period?: string; sort?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.tenants');
  const tu = await getTranslations('platformAdmin.usage');
  // TWO chips, TWO labels — the operator's one vocabulary for the two flags
  // (`internal-billing-classification.md` §1), never one collapsed "Internal".
  const tp = await getTranslations('platformAdmin');
  const chips = {
    isMeta: tp('orgs.chip.isMeta'),
    internalBilling: tp('orgs.chip.internalBilling'),
  };
  const format = await getFormatter();
  const params = await searchParams;
  const period = parseSpendPeriod(params.period);
  const sort = parseTenantSort(params.sort);
  const list = await platformUsageService.listTenants(principal, {
    period,
    sort,
    filter: params.q ?? '',
  });

  const monthLabel = (ym: string) =>
    format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const listQuery = new URLSearchParams({ period, sort });
  if (list.filter) listQuery.set('q', list.filter);
  const listHref = `/admin/tenants?${listQuery.toString()}`;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>

      {/* The toolbar row: the filter on the LEFT, the period switch on the RIGHT. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form method="GET" role="search" className="flex min-w-0 flex-1 items-center gap-2">
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="sort" value={sort} />
          <label className="flex h-(--height-input) min-w-0 max-w-[24rem] flex-1 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
            <Search className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span className="sr-only">{t('filterLabel')}</span>
            <input
              type="search"
              name="q"
              defaultValue={list.filter}
              placeholder={t('filterPlaceholder')}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none"
            />
          </label>
        </form>
        <SpendPeriodSwitch
          period={period}
          months={recentMonths().map((value) => ({ value, label: monthLabel(value) }))}
          labels={{
            month: tu('period.month'),
            allTime: tu('period.allTime'),
            group: tu('period.label'),
          }}
        />
      </div>

      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('listTitle')}</h2>
            <span className="font-sans text-xs text-(--el-text-secondary)" aria-live="polite">
              {period === 'all' ? tu('period.allTime') : monthLabel(period)}
            </span>
          </div>
        }
        footer={
          list.filterCapped ? (
            <p className="font-sans text-xs text-(--el-text-secondary)">{t('filterCapped')}</p>
          ) : undefined
        }
      >
        {list.unavailable || !list.estate ? (
          <ErrorState title={t('unavailable.title')} description={t('unavailable.description')} />
        ) : (
          <TenantSpendTable
            key={listHref}
            estate={list.estate}
            initialRows={list.rows}
            initialCursor={list.nextCursor}
            query={{ period, sort, filter: list.filter }}
            listHref={listHref}
            chips={chips}
          />
        )}
      </Card>
    </div>
  );
}
