import { getFormatter, getTranslations } from 'next-intl/server';
import { Flame, Info, Server } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  OrgIndexStateDTO,
  PlatformOrgIndexCostDTO,
  PoolFiguresDTO,
} from '@/lib/dto/platformOrgIndexCost';

/**
 * INDEX & FLEET COST · THIS PERIOD (MOTIR-5341 · design `platform-admin/design-notes.md`
 * Panel 14 and its Panel 14b states).
 *
 * ⚠️ Motir does not charge for code indexing. Everything on this card is internal
 * accounting, read by platform staff, and nothing on it reaches a customer.
 *
 * ⚠️ THE TWO POOLS ARE DRAWN APART and labelled by who can see them. State (b) —
 * over the allowance and still indexing — is the INFO family, never a warning: it is
 * the normal, absorbed case. A failed read renders unknown and a line that did not
 * run renders absent, in words; neither is ever drawn as a zero.
 */
export async function OrgIndexCostCard({ data }: { data: PlatformOrgIndexCostDTO }) {
  const t = await getTranslations('platformAdmin.orgs.indexCost');

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
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('title')}</h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">{t('subtitle')}</p>
            </div>
          </div>
        </div>
      }
      footer={
        data.meter === 'enabled' ? (
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('foot')}</p>
        ) : undefined
      }
    >
      {data.meter === 'disabled' ? (
        <NothingState icon={<Server className="h-4 w-4" />} title={t('disabled.title')}>
          {t('disabled.body')}
        </NothingState>
      ) : (
        <div className="flex flex-col gap-4">
          <Pools data={data} />
          <Workloads data={data} />
        </div>
      )}
    </Card>
  );
}

async function Pools({ data }: { data: Extract<PlatformOrgIndexCostDTO, { meter: 'enabled' }> }) {
  const t = await getTranslations('platformAdmin.orgs.indexCost');
  const format = await getFormatter();
  const { pools } = data;

  if (pools.state === 'unknown') {
    return (
      <NothingState icon={<Info className="h-4 w-4" />} title={t('unknown.title')}>
        {t('unknown.body')}
      </NothingState>
    );
  }
  if (pools.state === 'absent') {
    return <p className="font-sans text-sm text-(--el-text-secondary)">{t('absent')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2" data-testid="org-index-pools">
        <PoolPanel
          title={t('creditBalance')}
          badge={<Pill severity="success">{t('customerSees')}</Pill>}
          figures={pools.credit}
          barClass="bg-(--el-accent)"
          note={
            data.tokenSpendCredits === null
              ? t('creditNoteUnknownSpend')
              : t('creditNote', { spend: format.number(data.tokenSpendCredits) })
          }
        />
        {pools.index ? (
          <PoolPanel
            title={t('indexAllowance')}
            badge={<Pill tone="neutral">{t('internalOnly')}</Pill>}
            figures={pools.index}
            barClass="bg-(--el-info)"
            note={t('indexNote')}
          />
        ) : (
          <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)">
            <span className="flex items-center justify-between gap-2">
              <strong className="font-sans text-sm text-(--el-text)">{t('indexAllowance')}</strong>
              <Pill tone="neutral">{t('internalOnly')}</Pill>
            </span>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {pools.indexState === 'not_configured' ? t('notConfigured') : t('notGrantedYet')}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 font-sans text-sm">
          <strong className="text-(--el-text)">{t('indexing')}</strong>
          <StatePill state={pools.indexState} />
          {data.pause ? (
            <span className="text-xs text-(--el-text-secondary)">
              {t('pausedSince', { at: format.dateTime(new Date(data.pause.since)) })}
            </span>
          ) : null}
        </span>
        <span className="font-sans text-xs text-(--el-text-secondary)">{t('marginInactive')}</span>
      </div>
      {pools.indexState === 'over_still_indexing' ? (
        <p className="rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
          <strong>{t('absorbedNote')}</strong> {t('absorbedDetail')}
        </p>
      ) : null}
    </div>
  );
}

async function PoolPanel({
  title,
  badge,
  figures,
  barClass,
  note,
}: {
  title: string;
  badge: React.ReactNode;
  figures: PoolFiguresDTO;
  barClass: string;
  note: string;
}) {
  const t = await getTranslations('platformAdmin.orgs.indexCost');
  const format = await getFormatter();
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)">
      <span className="flex items-center justify-between gap-2">
        <strong className="font-sans text-sm text-(--el-text)">{title}</strong>
        {badge}
      </span>
      <span className="font-serif text-2xl text-(--el-text)">
        {format.number(figures.remaining)}{' '}
        <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
          {t('remaining')}
        </span>
      </span>
      {figures.pct !== null ? (
        <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-(--el-surface)">
          <span
            className={`block h-full ${barClass}`}
            style={{ width: `${Math.min(100, figures.pct)}%` }}
          />
        </span>
      ) : null}
      <span className="flex items-center justify-between gap-2 font-sans text-xs text-(--el-text-secondary)">
        <span>
          {t('grantedConsumed', {
            granted: figures.granted === null ? t('unknownFigure') : format.number(figures.granted),
            consumed:
              figures.consumed === null ? t('unknownFigure') : format.number(figures.consumed),
          })}
        </span>
        {figures.pct !== null ? (
          <strong className="tabular-nums text-(--el-text)">
            {format.number(figures.pct / 100, { style: 'percent', maximumFractionDigits: 0 })}
          </strong>
        ) : null}
      </span>
      <p className="font-sans text-xs text-(--el-text-secondary)">{note}</p>
    </div>
  );
}

async function StatePill({ state }: { state: OrgIndexStateDTO }) {
  const t = await getTranslations('platformAdmin.orgs.indexCost');
  const label = t(`state.${state}`);
  if (state === 'under') return <Pill severity="success">{label}</Pill>;
  if (state === 'over_still_indexing') return <Pill severity="info">{label}</Pill>;
  if (state === 'stopped_no_credit' || state === 'stopped_allowance_exhausted')
    return <Pill severity="danger">{label}</Pill>;
  return <Pill tone="neutral">{label}</Pill>;
}

async function Workloads({
  data,
}: {
  data: Extract<PlatformOrgIndexCostDTO, { meter: 'enabled' }>;
}) {
  const t = await getTranslations('platformAdmin.orgs.indexCost');
  const format = await getFormatter();
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[36rem] border-collapse font-sans text-sm"
        data-testid="org-fleet-workloads"
      >
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
              {t('col.workload')}
            </th>
            <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
              {t('col.containers')}
            </th>
            <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
              {t('col.seconds')}
            </th>
            <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
              {t('col.cogs')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.workloads.map((line) => (
            <tr
              key={line.workload}
              data-workload={line.workload}
              className="border-b border-(--el-border-soft)"
            >
              <td className="py-2 pr-4 font-mono text-xs text-(--el-text)">{line.workload}</td>
              {line.containerCount === null ? (
                <td colSpan={3} className="py-2 pr-4 text-right text-xs text-(--el-text-secondary)">
                  {t('absentLine', { workload: line.workload })}
                </td>
              ) : (
                <>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {format.number(line.containerCount)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {format.number(line.containerSeconds ?? 0)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {usdCents(line.costUsd ?? '0')}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A decimal string rounded half-up to cents, WITHOUT a float — the rollup's own
 * digits, never a `Number()` round-trip (the fleet readout's money rule).
 */
const HUNDRED = BigInt(100);
const ONE = BigInt(1);

export function usdCents(decimal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!match) return `$${decimal}`;
  const [, sign, whole, frac = ''] = match;
  const digits = (frac + '000').slice(0, 3);
  let cents = BigInt(whole!) * HUNDRED + BigInt(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) cents += ONE;
  const units = cents / HUNDRED;
  const rest = (cents % HUNDRED).toString().padStart(2, '0');
  return `${sign}$${units.toLocaleString('en-US')}.${rest}`;
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
