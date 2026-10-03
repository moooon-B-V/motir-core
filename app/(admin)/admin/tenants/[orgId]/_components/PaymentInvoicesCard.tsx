import { CreditCard } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { BillingHistorySlot } from '@/lib/services/platformOrgBillingService';

/**
 * PAYMENT & INVOICES (MOTIR-7292, design D9): the org's payment method and its recent
 * invoices, read-only — no Customer Portal link, no Update control, in any state.
 *
 * It renders whatever the billing-history slot holds, which is filled from Stripe
 * through motir-ai (MOTIR-7304).
 */
export function PaymentInvoicesCard({ slot }: { slot: BillingHistorySlot }) {
  const t = useTranslations('platformAdmin.orgBilling.payment');
  const format = useFormatter();

  return (
    <Card
      header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('title')}</h2>}
    >
      <div
        className="flex flex-col gap-3 font-sans text-sm"
        data-testid="payment-invoices"
        data-state={slot.state}
      >
        {slot.state === 'unavailable' ? (
          <p role="status" className="text-(--el-text-secondary)">
            {t('unavailable')}
          </p>
        ) : slot.state === 'none' ? (
          <p className="text-(--el-text-secondary)">{t('none')}</p>
        ) : (
          <Connected slot={slot} t={t} format={format} />
        )}
      </div>
    </Card>
  );
}

function Connected({
  slot,
  t,
  format,
}: {
  slot: Extract<BillingHistorySlot, { state: 'connected' }>;
  t: ReturnType<typeof useTranslations<'platformAdmin.orgBilling.payment'>>;
  format: ReturnType<typeof useFormatter>;
}) {
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const month = (ym: string) =>
    format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const paidUp = slot.invoices.length > 0 && slot.invoices.every((i) => i.status === 'paid');
  const pm = slot.paymentMethod;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3" data-testid="payment-method">
        {pm ? (
          <>
            <CreditCard aria-hidden className="h-5 w-5 text-(--el-text-secondary)" />
            <span className="sr-only">{pm.brand}</span>
            <span className="font-mono tabular-nums text-(--el-text)">•••• {pm.last4}</span>
            <span className="text-xs text-(--el-text-secondary)">
              {t('expires', {
                month: String(pm.expMonth).padStart(2, '0'),
                year: String(pm.expYear % 100).padStart(2, '0'),
              })}
            </span>
          </>
        ) : (
          <span className="text-(--el-text-secondary)">{t('noMethod')}</span>
        )}
        {paidUp ? (
          <span className="ml-auto">
            <Pill severity="success">{t('paidUp')}</Pill>
          </span>
        ) : null}
      </div>
      {slot.invoices.length === 0 ? (
        <p className="text-(--el-text-secondary)">{t('none')}</p>
      ) : (
        <table className="w-full" data-testid="invoices">
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th className="py-1 font-medium">{t('invoice')}</th>
              <th className="py-1 font-medium">{t('status')}</th>
              <th className="py-1 text-right font-medium">{t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            {slot.invoices.map((inv) => (
              <tr key={inv.id} className="border-t border-(--el-border)">
                <td className="py-1">{month(inv.month)}</td>
                <td className="py-1">
                  <Pill
                    severity={
                      inv.status === 'paid' ? 'success' : inv.status === 'open' ? 'warning' : 'info'
                    }
                  >
                    {t.has(`invoiceStatus.${inv.status}`)
                      ? t(`invoiceStatus.${inv.status}` as never)
                      : inv.status}
                  </Pill>
                </td>
                <td className="py-1 text-right tabular-nums">
                  {money(inv.amountCents, inv.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
