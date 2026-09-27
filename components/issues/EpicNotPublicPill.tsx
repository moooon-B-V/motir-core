'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';

// The "Not public" marker a Visitor sees on a PRIVATE epic (Story MOTIR-6170 ·
// MOTIR-6648; design MOTIR-6641, `docs/decisions/epic-privacy.md` §4) — the
// shipped public marker, used wherever the epic's row appears to a Visitor: the
// item page, the list and tree rows and the roadmap node. Rendered only when a
// read marked the epic `childrenHidden`, which only a Visitor's read does.
export function EpicNotPublicPill() {
  const t = useTranslations('publicProjects');
  return (
    <Pill
      data-testid="epic-not-public-pill"
      className="shrink-0 border-(--el-chip-border) bg-(--el-chip-bg) text-(--el-text-secondary)"
    >
      <Lock className="size-3" aria-hidden />
      {t('epicNotPublicBadge')}
    </Pill>
  );
}
