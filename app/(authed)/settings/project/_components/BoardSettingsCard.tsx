import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight, Columns3 } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project board-configuration editor (Subtask 3.6.3's
// /settings/project/board route — the column manager + status mapping). A SIBLING
// of the WorkflowSettingsCard (finding #47: there is no settings sidebar, so each
// settings surface gets a nav card on the project-settings landing page). Reuses
// the exact Card-as-Link grammar so the whole row is one accessible navigation
// target; the leading icon is the `Columns3` glyph the design uses for the board
// surface (muted, so the card stays a quiet nav row). Workflow owns statuses +
// transitions; Board owns how those statuses map onto columns.

export async function BoardSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/board"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div className="flex items-center gap-3">
          <span className="bg-(--el-surface) text-(--el-text-secondary) inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control)">
            <Columns3 className="size-[18px]" aria-hidden />
          </span>
          <div>
            <p className="font-sans text-sm font-medium text-(--el-text)">{t('board.title')}</p>
            <p className="text-(--el-text-muted) font-sans text-xs">{t('board.cardDescription')}</p>
          </div>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
