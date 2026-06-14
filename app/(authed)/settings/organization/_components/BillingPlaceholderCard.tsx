import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';

// The PASSIVE billing placeholder (design/org-admin panel 2). The org IS the
// billing entity (Yue, locked), but 6.10 ships NO billing surface — the org
// usage/credit view is 7.12.5 and checkout is Epic 8. This card exists only so
// the settings layout stays stable when billing lands; it carries a "Coming
// soon" pill + a note, and NO active control.
export async function BillingPlaceholderCard() {
  const t = await getTranslations('orgAdmin');
  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('settings.billing')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-sm">{t('settings.billingSub')}</p>
          </div>
          <Pill tone="neutral" className="shrink-0">
            {t('settings.comingSoon')}
          </Pill>
        </div>
      }
    >
      <div className="border-(--el-border) flex items-start gap-3 rounded-(--radius-card) border border-dashed bg-(--el-surface-soft) px-4 py-3">
        <Sparkles className="text-(--el-text-muted) mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="text-(--el-text-secondary) font-sans text-sm">{t('settings.billingNote')}</p>
      </div>
    </Card>
  );
}
