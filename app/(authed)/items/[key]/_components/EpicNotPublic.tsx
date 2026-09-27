'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';

// A Visitor's PRIVATE EPIC on the item page (Story MOTIR-6170 · MOTIR-6648;
// design MOTIR-6641 panel 8, `docs/decisions/epic-privacy.md` §4). The epic's
// own page stays — its fields, status and title — with the shipped public
// marker, and the children panel is replaced by the public site's own block:
// no count, no rows. Rendered only when the detail read marked the epic
// `childrenHidden`, which only a Visitor's read does.

/** The "Not public" marker beside the identifier — the neutral chip. */
export function EpicNotPublicPill() {
  const t = useTranslations('publicProjects');
  return (
    <Pill className="shrink-0 border-(--el-chip-border) bg-(--el-chip-bg) text-(--el-text-secondary)">
      <Lock className="size-3" aria-hidden />
      {t('epicNotPublicBadge')}
    </Pill>
  );
}

/** The block the children panel becomes. */
export function EpicNotPublicBlock() {
  const t = useTranslations('publicProjects');
  return (
    <section
      data-testid="epic-not-public"
      className="flex flex-col gap-1 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)"
    >
      <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
        <Lock className="size-4 text-(--el-text-secondary)" aria-hidden />
        {t('epicNotPublicTitle')}
      </h2>
      <p className="text-sm text-(--el-text-secondary)">{t('epicNotPublicBody')}</p>
    </section>
  );
}
