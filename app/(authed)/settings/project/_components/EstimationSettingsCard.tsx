import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRight, Hash } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// Navigation card to the per-project Estimation settings editor (Subtask 4.3.6's
// /settings/project/estimation route). Sibling of the Workflow + Board settings
// cards — the same single-<Link>-wrapped Card grammar so the whole row is one
// accessible navigation target. Per design/estimation/estimation-settings.mock.html
// (panel 2) the card carries a leading lavender-tint glyph tile (the hash/points
// marker, hue in the BACKGROUND with --el-text-strong text — AA-safe, finding #35).

export async function EstimationSettingsCard() {
  const t = await getTranslations('settings');
  return (
    <Card className="p-0 transition-shadow hover:shadow-(--shadow-card)">
      <Link
        href="/settings/project/estimation"
        className="focus-visible:ring-(--focus-ring-color) flex items-center justify-between gap-4 rounded-(--radius-card) p-(--spacing-card-padding) focus-visible:outline-none focus-visible:ring-2"
      >
        <div className="flex items-center gap-3">
          <span
            className="bg-(--el-tint-lavender) text-(--el-text-strong) inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control)"
            aria-hidden
          >
            <Hash className="size-[18px]" />
          </span>
          <div>
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {t('estimation.title')}
            </p>
            <p className="text-(--el-text-muted) font-sans text-xs">
              {t('estimation.cardDescription')}
            </p>
          </div>
        </div>
        <ChevronRight className="text-(--el-text-muted) size-5 shrink-0" aria-hidden />
      </Link>
    </Card>
  );
}
