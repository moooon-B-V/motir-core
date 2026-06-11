import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project Components admin (Subtask 5.4.10's
// /settings/project/components route). The MembersSettingsCard grammar
// verbatim (the 5.4.7 mockup, panel 0): Card p-0 + a whole-row <Link> +
// ChevronRight — placed after Fields (the issue-config cards group together;
// Access & members and Archive stay last).

export async function ComponentsSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/components"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('components.cardTitle')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('components.cardDescription')}
          </p>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
