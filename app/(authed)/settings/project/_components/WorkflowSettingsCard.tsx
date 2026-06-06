import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project workflow editor (Subtask 2.2.5's
// /settings/project/workflow route). Resolves finding #47: that route shipped
// without any entry point and was reachable only by typing the URL. This gives
// the project-settings landing page a link to it, reusing the existing Card
// grammar (a single <Link> wrapping the card so the whole row is one
// accessible navigation target — no new settings-nav chrome invented).

export async function WorkflowSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/workflow"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">{t('workflow.title')}</p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('workflow.cardDescription')}
          </p>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
