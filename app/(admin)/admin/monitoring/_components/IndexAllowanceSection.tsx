import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  ArrowDown,
  Ban,
  ChevronLeft,
  ChevronRight,
  Flame,
  Info,
  Search,
  Server,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  IndexTierReading,
  PlatformIndexAllowanceDTO,
  StoppedOrgsDTO,
} from '@/lib/dto/platformIndexAllowance';
import { StoppedReasonFilter } from './StoppedReasonFilter';

/**
 * MONITORING · INDEX ALLOWANCE (MOTIR-4595 · design `platform-admin/design-notes.md`
 * Panel 13, revision 2, and its Panel 14b nothing-states).
 *
 * ⚠️ Motir does not charge for code indexing. Everything here is internal accounting,
 * read by platform staff, and nothing reaches a customer.
 *
 * ⚠️ THE TIER TABLE'S "EXHAUSTED" AND THE LIST'S "STOPPED" ARE DIFFERENT FACTS from
 * different databases (see `platformIndexAllowanceService`), and are labelled apart.
 * ⚠️ A FAILED READ RENDERS UNKNOWN, IN WORDS — never a row of zeros.
 */
export async function IndexAllowanceSection({ data }: { data: PlatformIndexAllowanceDTO }) {
  const t = await getTranslations('platformAdmin.monitoring');

  if (data.meter === 'disabled') {
    return (
      <Card>
        <NothingState
          icon={<Server className="h-4 w-4" />}
          title={t('indexAllowance.disabled.title')}
        >
          {t('indexAllowance.disabled.body')}
        </NothingState>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <TierCard data={data} />
      <StoppedCard stopped={data.stopped} />
    </div>
  );
}

async function TierCard({
  data,
}: {
  data: Extract<PlatformIndexAllowanceDTO, { meter: 'enabled' }>;
}) {
  const t = await getTranslations('platformAdmin.monitoring');
  const format = await getFormatter();
  const { summary, threshold } = data;
  const pct = (n: number) => format.number(n / 100, { style: 'percent', maximumFractionDigits: 1 });

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              <Flame className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('indexAllowance.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('indexAllowance.subtitle')}
              </p>
            </div>
          </div>
          <Pill tone="neutral">{t('indexAllowance.internal')}</Pill>
        </div>
      }
      footer={
        <p className="font-sans text-xs text-(--el-text-secondary)">
          <strong>{t('indexAllowance.foot')}</strong>{' '}
          {threshold.provisional
            ? t('indexAllowance.thresholdProvisional', { pct: threshold.pct })
            : null}
        </p>
      }
    >
      {summary.state === 'unknown' ? (
        <NothingState icon={<Info className="h-4 w-4" />} title={t('indexAllowance.unknown.title')}>
          {t('indexAllowance.unknown.body')}
        </NothingState>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <MiniStat
              value={t('indexAllowance.stat.overThresholdValue', {
                n: summary.tiersOverThreshold,
                total: summary.softGatedTiers,
              })}
              label={t('indexAllowance.stat.overThreshold')}
            />
            <MiniStat
              value={pct(threshold.pct)}
              label={
                threshold.provisional
                  ? t('indexAllowance.stat.thresholdProvisional')
                  : t('indexAllowance.stat.threshold')
              }
            />
            <MiniStat
              value={format.number(summary.oneTimeExhausted)}
              label={t('indexAllowance.stat.freeExhausted')}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('indexAllowance.col.tier')}</Th>
                  <Th numeric>{t('indexAllowance.col.orgs')}</Th>
                  <Th numeric>{t('indexAllowance.col.crossed')}</Th>
                  <Th>{t('indexAllowance.col.rate')}</Th>
                  <Th>{t('indexAllowance.col.reading')}</Th>
                  <Th numeric>{t('indexAllowance.col.basis')}</Th>
                </tr>
              </thead>
              <tbody>
                {summary.tiers.map((tier) => (
                  <tr
                    key={tier.tierKey}
                    data-tier={tier.tierKey}
                    className="border-b border-(--el-border-soft)"
                  >
                    <Td>
                      <span className="flex flex-col">
                        <strong className="font-medium text-(--el-text)">{tier.tierName}</strong>
                        <span className="text-xs text-(--el-text-secondary)">
                          {t(`indexAllowance.cadence.${tier.cadence}`)}
                        </span>
                      </span>
                    </Td>
                    <Td numeric>{format.number(tier.orgs)}</Td>
                    <Td numeric>
                      {tier.cadence === 'one_time'
                        ? t('indexAllowance.exhaustedCount', { n: tier.exhausted ?? 0 })
                        : t('indexAllowance.crossedCount', { n: tier.crossed ?? 0 })}
                    </Td>
                    <Td>
                      {tier.cadence === 'one_time' || tier.reading === 'unconfigured' ? (
                        <span className="text-xs text-(--el-text-secondary)">
                          {tier.cadence === 'one_time' && tier.ratePct !== null
                            ? t('indexAllowance.rate.noSoftGateAtLimit', { pct: pct(tier.ratePct) })
                            : t('indexAllowance.rate.none')}
                        </span>
                      ) : tier.ratePct === null ? (
                        <span className="text-xs text-(--el-text-secondary)">
                          {t('indexAllowance.rate.noOrgs')}
                        </span>
                      ) : (
                        <span className="flex min-w-[9rem] items-center gap-2">
                          <span
                            aria-hidden
                            className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--el-surface)"
                          >
                            <span
                              className="block h-full bg-(--el-info)"
                              style={{ width: `${Math.min(100, tier.ratePct)}%` }}
                            />
                          </span>
                          <strong className="tabular-nums text-(--el-text)">
                            {pct(tier.ratePct)}
                          </strong>
                        </span>
                      )}
                    </Td>
                    <Td>
                      <ReadingPill reading={tier.reading} thresholdPct={threshold.pct} />
                    </Td>
                    <Td numeric>
                      {tier.grantedCreditsPerOrg === null ? (
                        <span className="text-xs text-(--el-text-secondary)">
                          {t('indexAllowance.basis.unset')}
                        </span>
                      ) : (
                        t(`indexAllowance.basis.${tier.cadence}`, {
                          credits: format.number(tier.allotmentCredits),
                          index: format.number(tier.grantedCreditsPerOrg),
                        })
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

async function ReadingPill({
  reading,
  thresholdPct,
}: {
  reading: IndexTierReading;
  thresholdPct: number;
}) {
  const t = await getTranslations('platformAdmin.monitoring');
  if (reading === 'holds')
    return <Pill severity="success">{t('indexAllowance.reading.holds')}</Pill>;
  if (reading === 'recalculate')
    return (
      <Pill severity="warning">
        {t('indexAllowance.reading.recalc', { threshold: thresholdPct })}
      </Pill>
    );
  if (reading === 'hard_stop')
    return <Pill tone="neutral">{t('indexAllowance.reading.free')}</Pill>;
  return <Pill tone="neutral">{t('indexAllowance.reading.unconfigured')}</Pill>;
}

async function StoppedCard({ stopped }: { stopped: StoppedOrgsDTO }) {
  const t = await getTranslations('platformAdmin.monitoring');
  const now = new Date();
  const from = stopped.total === 0 ? 0 : (stopped.page - 1) * stopped.pageSize + 1;
  const to = Math.min(stopped.total, stopped.page * stopped.pageSize);

  const hrefFor = (page: number) => {
    const query = new URLSearchParams();
    if (stopped.filter !== 'all') query.set('reason', stopped.filter);
    if (stopped.search) query.set('q', stopped.search);
    if (page > 1) query.set('page', String(page));
    const qs = query.toString();
    return qs ? `?${qs}` : '?';
  };

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              <Ban className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('stopped.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('stopped.subtitle')}
              </p>
            </div>
          </div>
          <Pill severity={stopped.counts.all > 0 ? 'danger' : 'success'}>
            {t('stopped.total', { count: stopped.counts.all })}
          </Pill>
        </div>
      }
      footer={
        stopped.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('stopped.foot', { from, to, total: stopped.total })}
            </p>
            <nav
              aria-label={t('stopped.pagerLabel')}
              className="flex items-center gap-2 font-sans text-sm"
            >
              <PagerLink href={hrefFor(stopped.page - 1)} disabled={stopped.page <= 1}>
                <ChevronLeft aria-hidden className="h-4 w-4" />
                {t('stopped.prev')}
              </PagerLink>
              <span className="text-(--el-text-secondary)">
                {t('stopped.pageOf', { page: stopped.page, pages: stopped.pageCount })}
              </span>
              <PagerLink
                href={hrefFor(stopped.page + 1)}
                disabled={stopped.page >= stopped.pageCount}
              >
                {t('stopped.next')}
                <ChevronRight aria-hidden className="h-4 w-4" />
              </PagerLink>
            </nav>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StoppedReasonFilter
            value={stopped.filter}
            counts={stopped.counts}
            labels={{
              group: t('stopped.filter.label'),
              all: t('stopped.filter.all'),
              noCredit: t('stopped.filter.noCredit'),
              allowanceExhausted: t('stopped.filter.freeUsed'),
              margin: t('stopped.filter.margin'),
              marginInactive: t('stopped.filter.marginInactive'),
              marginInactiveHint: t('stopped.filter.marginInactiveHint'),
            }}
          />
          <form method="GET" role="search" className="flex min-w-0 items-center">
            {stopped.filter !== 'all' ? (
              <input type="hidden" name="reason" value={stopped.filter} />
            ) : null}
            <label className="flex h-(--height-input) w-64 max-w-full items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
              <Search aria-hidden className="h-4 w-4 shrink-0 text-(--el-text-secondary)" />
              <span className="sr-only">{t('stopped.searchLabel')}</span>
              <input
                type="search"
                name="q"
                defaultValue={stopped.search ?? ''}
                placeholder={t('stopped.search')}
                className="min-w-0 flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none placeholder:text-(--el-text-secondary)"
              />
            </label>
          </form>
        </div>

        {stopped.counts.all === 0 ? (
          <NothingState icon={<Info className="h-4 w-4" />} title={t('stopped.empty')}>
            {t('stopped.emptyBody')}
          </NothingState>
        ) : stopped.rows.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('stopped.noMatch')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('stopped.col.org')}</Th>
                  <Th>{t('stopped.col.tier')}</Th>
                  <Th>{t('stopped.col.reason')}</Th>
                  <Th numeric sorted>
                    {t('stopped.col.stoppedFor')}
                    <ArrowDown aria-hidden className="ml-1 inline h-3 w-3" />
                  </Th>
                  <Th numeric>{t('stopped.col.graphBehind')}</Th>
                  <Th>{t('stopped.col.resumes')}</Th>
                </tr>
              </thead>
              <tbody>
                {stopped.rows.map((row) => (
                  <tr
                    key={row.organizationId}
                    data-org={row.organizationId}
                    className="border-b border-(--el-border-soft)"
                  >
                    <Td>
                      <Link
                        href={`/admin/tenants/${row.organizationId}`}
                        className="font-medium text-(--el-text) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                      >
                        {row.organizationName}
                      </Link>
                    </Td>
                    <Td className="text-(--el-text-secondary)">
                      {row.tierKey === 'unknown'
                        ? t('stopped.tierUnknown')
                        : row.tierKey === null
                          ? t('stopped.tierNone')
                          : row.tierKey}
                    </Td>
                    <Td>
                      <Pill severity="danger">
                        {row.reason === 'no_credit' || row.reason === 'allowance_exhausted'
                          ? t(`stopped.reason.${row.reason}`)
                          : t('stopped.reason.other', { reason: row.reason })}
                      </Pill>
                    </Td>
                    <Td numeric className="tabular-nums">
                      {stoppedFor(t, new Date(row.stoppedSince), now)}
                    </Td>
                    <Td numeric className="tabular-nums">
                      {row.graphBehind === null
                        ? t('stopped.behindUnknown')
                        : t('stopped.behind', { n: row.graphBehind })}
                    </Td>
                    <Td className="text-(--el-text-secondary)">
                      {row.reason === 'allowance_exhausted'
                        ? t('stopped.resumes.upgrade')
                        : row.reason === 'no_credit'
                          ? t('stopped.resumes.topUp')
                          : t('stopped.resumes.gateLifts')}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

/** How long an org has been stopped, in the list's grain: hours under a day, days
 *  after. A duration rather than a relative time ("3 days", not "3 days ago"),
 *  because the column header already says "stopped for". */
function stoppedFor(
  t: Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring'>>>,
  since: Date,
  now: Date,
): string {
  const hours = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
  return hours < 24
    ? t('stopped.duration.hours', { n: hours })
    : t('stopped.duration.days', { n: Math.floor(hours / 24) });
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) p-3">
      <span className="font-serif text-xl text-(--el-text)">{value}</span>
      <span className="font-sans text-xs text-(--el-text-secondary)">{label}</span>
    </div>
  );
}

function NothingState({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <span
        aria-hidden
        className="inline-flex h-10 w-10 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-text-secondary)"
      >
        {icon}
      </span>
      <h3 className="font-serif text-base text-(--el-text)">{title}</h3>
      <p className="max-w-prose font-sans text-xs text-(--el-text-secondary)">{children}</p>
    </div>
  );
}

function PagerLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const className =
    'inline-flex h-(--height-btn-sm) items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) text-(--el-text)';
  return disabled ? (
    <span
      aria-disabled="true"
      className={`${className} cursor-not-allowed text-(--el-text-secondary)`}
    >
      {children}
    </span>
  ) : (
    <Link
      href={href}
      scroll={false}
      className={`${className} hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)`}
    >
      {children}
    </Link>
  );
}

function Th({
  children,
  numeric,
  sorted,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  sorted?: boolean;
}) {
  return (
    <th
      aria-sort={sorted ? 'descending' : undefined}
      className={`py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide ${numeric ? 'text-right' : ''} ${sorted ? 'text-(--el-text-strong)' : 'text-(--el-text-secondary)'}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  numeric,
  className = '',
}: {
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={`py-2 pr-4 align-top ${numeric ? 'text-right' : ''} ${className}`}>
      {children}
    </td>
  );
}
