import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project custom-fields admin (Subtask 5.3.6's
// /settings/project/fields route). The MembersSettingsCard grammar verbatim
// (the 5.3.4 mockup, panel 0): Card p-0 + a whole-row <Link> + ChevronRight —
// placed after Estimation (field config groups with the issue-config cards).

export async function FieldsSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/fields"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('customFields.cardTitle')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('customFields.cardDescription')}
          </p>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
