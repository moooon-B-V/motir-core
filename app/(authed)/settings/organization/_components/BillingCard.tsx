import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CreditCard } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { buttonVariants } from '@/components/ui/Button';

// The LIVE billing "door" in the org-settings stack (Story 8.1.7, design/billing
// panel 1) — it REPLACES the passive `BillingPlaceholderCard`. Cloud-only: the
// settings page renders it only when `isCloudBilling()` (off-cloud there is no
// billing at all). A lightweight link card by design — the live plan summary +
// every control lives on the dedicated `/settings/organization/billing` surface
// (one click away), so the settings page never depends on a motir-ai round-trip
// to render. The org-menu "Billing & plans" row is the other access path.
export async function BillingCard() {
  const t = await getTranslations('billing');
  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
              <CreditCard className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('card.title')}
              </h2>
              <p className="font-sans text-sm text-(--el-text-muted)">{t('card.subtitle')}</p>
            </div>
          </div>
          <Link
            href="/settings/organization/billing"
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            {t('card.open')}
          </Link>
        </div>
      }
    />
  );
}
