import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project Members + Access editor (Subtask 6.4.5's
// /settings/project/members route). Same Card grammar as WorkflowSettingsCard /
// BoardSettingsCard — a single <Link> wrapping the whole row so it's one
// accessible navigation target, no new settings-nav chrome invented.

export async function MembersSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/members"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">{t('access.title')}</p>
          <p className="text-(--el-text-muted) font-sans text-xs">{t('access.cardDescription')}</p>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
