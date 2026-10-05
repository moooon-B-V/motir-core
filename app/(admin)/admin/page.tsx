import type { Metadata } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Activity, CloudOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { PlatformActivityItemDTO, PlatformOverviewPeriod } from '@/lib/dto/platform';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformReadService } from '@/lib/services/platformReadService';

/**
 * The estate overview — design `platform-admin/console--estate-usage-drilldown.mock.html`
 * **D1** (and its states, **D2**), MOTIR-731.
 *
 * Four tier counts, each with how many arrived in the PERIOD, and one activity
 * feed that interleaves the tenants created with the planning and hosted runs
 * motir-ai recorded. Everything is one audited read (`platformReadService.getOverview`).
 *
 * A server page, not a client island: the period and the feed's position live in
 * the URL, so a view is linkable and every load is one audit row, not one per click.
 * motir-ai being unreachable is a STATE of the feed (D2), never an error page —
 * the counts and the tenant events are motir-core's own.
 */

export const metadata: Metadata = {
  // No description, and nothing here names what the surface DOES — the console's
  // standing rule: this page is only ever rendered for a principal past the gate.
  title: 'Platform admin',
};

/** Never cached: a tenant created a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

const PERIODS: PlatformOverviewPeriod[] = ['7d', '30d', 'month'];

const COUNT_TINT = {
  organizations: 'bg-(--el-tint-lavender)',
  workspaces: 'bg-(--el-tint-sky)',
  projects: 'bg-(--el-tint-mint)',
  users: 'bg-(--el-tint-rose)',
} as const;

const KIND_TINT: Record<PlatformActivityItemDTO['kind'], string> = {
  new_organization: 'bg-(--el-tint-lavender)',
  new_workspace: 'bg-(--el-tint-sky)',
  new_project: 'bg-(--el-tint-mint)',
  planning_run: 'bg-(--el-tint-mint)',
  coding_run: 'bg-(--el-tint-peach)',
};

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; cursor?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.overview');
  const format = await getFormatter();
  const params = await searchParams;
  const period: PlatformOverviewPeriod = PERIODS.includes(params.period as PlatformOverviewPeriod)
    ? (params.period as PlatformOverviewPeriod)
    : '7d';
  const overview = await platformReadService.getOverview(principal, {
    period,
    cursor: params.cursor ?? null,
  });
  const periodLabel = t(`period.${period}`);
  const estateEmpty = overview.counts.organizations === 0;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('subtitle')}
          </p>
        </div>
        {/* The period switch sits on the RIGHT of the toolbar row (the approved header grammar). */}
        <nav
          aria-label={t('periodLabel')}
          className="inline-flex rounded-(--radius-input) border border-(--el-border) p-0.5"
        >
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/admin?period=${p}`}
              aria-current={p === period ? 'page' : undefined}
              className={
                p === period
                  ? 'rounded-(--radius-input) bg-(--el-page-bg) shadow-(--shadow-subtle) px-3 py-1 font-sans text-sm text-(--el-text)'
                  : 'rounded-(--radius-input) px-3 py-1 font-sans text-sm text-(--el-text-secondary) hover:text-(--el-text)'
              }
            >
              {t(`period.${p}`)}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['organizations', 'workspaces', 'projects', 'users'] as const).map((tier) => (
          <Card key={tier} data-testid={`estate-count-${tier}`}>
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-2 font-sans text-xs text-(--el-text-secondary)">
                <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${COUNT_TINT[tier]}`} />
                {t(`counts.${tier}`)}
              </span>
              <span className="font-sans text-2xl font-semibold tabular-nums text-(--el-text)">
                {format.number(overview.counts[tier])}
              </span>
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t('delta', { count: overview.deltas[tier], period: periodLabel })}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <section aria-labelledby="estate-activity" className="flex flex-col gap-2">
        <h2 id="estate-activity" className="font-sans text-sm font-semibold text-(--el-text)">
          {t('feed.title')}
        </h2>
        {overview.feed.runsUnavailable ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-(--radius-input) bg-(--el-tint-peach) px-3 py-2 font-sans text-sm text-(--el-text-strong)"
          >
            <CloudOff className="h-4 w-4" aria-hidden />
            {t('feed.runsUnavailable')}
          </p>
        ) : null}
        {overview.feed.items.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-12 w-12" aria-hidden />}
            title={estateEmpty ? t('feed.emptyEstateTitle') : t('feed.emptyTitle')}
            description={
              estateEmpty ? t('feed.emptyEstateDescription') : t('feed.emptyDescription')
            }
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full font-sans text-sm">
              <thead>
                <tr className="text-left text-xs text-(--el-text-secondary)">
                  <th className="px-3 py-2 font-medium">{t('feed.when')}</th>
                  <th className="px-3 py-2 font-medium">{t('feed.event')}</th>
                  <th className="px-3 py-2 font-medium">{t('feed.where')}</th>
                  <th className="px-3 py-2 font-medium">{t('feed.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.feed.items.map((item) => (
                  <tr
                    key={`${item.kind}:${item.id}`}
                    data-testid="estate-activity-row"
                    className="border-t border-(--el-border)"
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-(--el-text-secondary)">
                      <time dateTime={item.at}>
                        {format.dateTime(new Date(item.at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong) ${KIND_TINT[item.kind]}`}
                      >
                        {t(`feed.kind.${item.kind}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-(--el-text)">
                      {item.organization ? (
                        <Link
                          href={`/admin/tenants/${encodeURIComponent(item.organization.id)}`}
                          className="hover:underline"
                        >
                          {item.organization.name}
                        </Link>
                      ) : null}
                      {item.workspace ? <span> › {item.workspace.name}</span> : null}
                      {item.project ? <span> › {item.project.name}</span> : null}
                      {item.unattributed && !item.workspace ? (
                        <span className="text-(--el-text-secondary)">
                          {' '}
                          › {t('feed.unattributed')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-(--el-text-secondary)">
                      {item.model || item.credits !== null
                        ? t('feed.runDetail', {
                            model: item.model ?? '—',
                            credits: format.number(item.credits ?? 0),
                          })
                        : (item.detail ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {overview.feed.nextCursor ? (
          <Link
            href={`/admin?period=${period}&cursor=${encodeURIComponent(overview.feed.nextCursor)}`}
            className="self-start font-sans text-sm text-(--el-accent-on-surface) hover:underline"
          >
            {t('feed.older')}
          </Link>
        ) : null}
      </section>
    </div>
  );
}
