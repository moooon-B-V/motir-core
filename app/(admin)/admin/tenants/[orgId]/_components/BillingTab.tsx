import { getFormatter, getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Pill } from '@/components/ui/Pill';
import type { PlatformOrgBillingDTO } from '@/lib/services/platformOrgBillingService';

/**
 * The org page's BILLING & PLANS tab (MOTIR-7289, design D9): the seat line, the AI
 * plan with its allotment, and this month's bill line by line — the tenant's own
 * page, read-only. No Change plan, no Manage payment, no Customer Portal link.
 */
export async function BillingTab({
  data,
  children,
}: {
  data: PlatformOrgBillingDTO;
  children?: React.ReactNode;
}) {
  const t = await getTranslations('platformAdmin.orgBilling');
  const format = await getFormatter();
  if (!data.enabled) {
    return <EmptyState title={t('disabled.title')} description={t('disabled.description')} />;
  }
  const money = (c: number) =>
    format.number(c / 100, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <>
      <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
        <span>{t('readOnly', { name: data.organization.name })}</span>
      </p>
      {!data.status || !data.bill ? (
        <ErrorState title={t('unavailable.title')} description={t('unavailable.description')} />
      ) : (
        <>
          <Card
            header={
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('seats.title')}
              </h2>
            }
          >
            <div
              className="flex flex-wrap items-center justify-between gap-2 font-sans text-sm"
              data-testid="billing-seats"
            >
              <span className="text-(--el-text-secondary)">
                {data.status.motir.scaledTrackerSubscription
                  ? t('seats.scaled', { members: data.memberCount })
                  : t('seats.free', { members: data.memberCount })}
              </span>
              {data.status.motir.scaledTrackerSubscription ? (
                <Pill tone="neutral">
                  {t(`status.${data.status.motir.scaledTrackerSubscription.status}`)}
                </Pill>
              ) : null}
            </div>
          </Card>

          <Card
            header={
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('ai.title')}</h2>
            }
          >
            <dl
              className="grid grid-cols-2 gap-2 font-sans text-sm md:grid-cols-4"
              data-testid="billing-ai"
            >
              <div>
                <dt className="text-xs text-(--el-text-secondary)">{t('ai.plan')}</dt>
                <dd>
                  {data.status.motirAi.subscription.planTier?.name ??
                    data.status.motirAi.tier?.name ??
                    t('ai.none')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-(--el-text-secondary)">{t('ai.allotment')}</dt>
                <dd className="tabular-nums">
                  {data.status.motirAi.tier
                    ? t('ai.perMonth', {
                        credits: format.number(data.status.motirAi.tier.monthlyCreditAllotment),
                      })
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-(--el-text-secondary)">{t('ai.balance')}</dt>
                <dd className="tabular-nums">{format.number(data.status.motirAi.balance)}</dd>
              </div>
              <div>
                <dt className="text-xs text-(--el-text-secondary)">{t('ai.renews')}</dt>
                <dd>
                  {data.status.motirAi.subscription.currentPeriodEnd
                    ? date(data.status.motirAi.subscription.currentPeriodEnd)
                    : '—'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            header={
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('bill.title')}
              </h2>
            }
          >
            <table className="w-full font-sans text-sm" data-testid="billing-bill">
              <thead>
                <tr className="text-left text-xs text-(--el-text-secondary)">
                  <th className="py-1 font-medium">{t('bill.line')}</th>
                  <th className="py-1 font-medium">{t('bill.basis')}</th>
                  <th className="py-1 text-right font-medium">{t('bill.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {data.bill.money.map((l) => (
                  <tr key={l.key} className="border-t border-(--el-border)">
                    <td className="py-1">{t(`bill.lines.${l.key}`)}</td>
                    <td className="py-1 text-(--el-text-secondary)">
                      {l.key === 'seats'
                        ? t(`bill.seatsBasis.${l.basis.cadence}`, {
                            seats: l.basis.seats ?? 0,
                            unit: money(l.basis.unitCents ?? 0),
                          })
                        : t(`bill.aiBasis.${l.basis.cadence}`, {
                            credits: format.number(l.basis.credits ?? 0),
                          })}
                    </td>
                    <td className="py-1 text-right tabular-nums">{money(l.amountCents)}</td>
                  </tr>
                ))}
                {data.bill.credits.map((l) => (
                  <tr key={l.key} className="border-t border-(--el-border)">
                    <td className="py-1">{t(`bill.lines.${l.key}`)}</td>
                    <td className="py-1 text-(--el-text-secondary)">{t('bill.drawnFromPool')}</td>
                    <td className="py-1 text-right tabular-nums">
                      {l.credits === null
                        ? '—'
                        : t('bill.credits', { credits: format.number(l.credits) })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-(--el-border) font-semibold">
                  <td className="py-1">{t('bill.total')}</td>
                  <td className="py-1 text-(--el-text-secondary)">
                    {data.bill.chargeDate
                      ? t('bill.chargedOn', { date: date(data.bill.chargeDate) })
                      : ''}
                  </td>
                  <td className="py-1 text-right tabular-nums" data-testid="billing-total">
                    {money(data.bill.totalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </>
      )}
      {children}
    </>
  );
}
