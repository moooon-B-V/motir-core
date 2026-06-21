'use client';

import { useTranslations } from 'next-intl';
import { CornerUpLeft, LockOpen, RotateCw } from 'lucide-react';
import { TIER_META, type DirectionDocKind } from '@/lib/onboarding/directionDoc';

// The downstream-only cascade BACK-navigation banner (Subtask 7.3.71 / MOTIR-1179,
// design screen G3 — the `.gate-banner.back` peach variant). Shown at the top of
// the review gate when a chat reaction was attributed UPSTREAM: the conductor
// sends the user BACK to re-review the affected (earliest changed) tier, and the
// downstream tiers in the cascade are flagged "will refresh". Nothing is locked —
// going back is always safe (the reassurance line). Cascade arrows point
// downstream only; this banner never implies an upstream rewrite.
//
// Purely presentational. Peach tint via `--el-tint-peach` + `--el-text-strong`
// (AA); every state pairs a glyph + word (never colour-alone, finding #35 a11y).

export interface CascadeBackBannerProps {
  /** The downstream tiers that will re-derive (rendered as "will refresh" chips). */
  willRefresh: DirectionDocKind[];
}

export function CascadeBackBanner({ willRefresh }: CascadeBackBannerProps) {
  const t = useTranslations('onboarding.chat.revisions');

  return (
    <div
      className="mb-6 flex gap-3 rounded-(--radius-card) bg-(--el-tint-peach) p-(--spacing-card-padding)"
      role="status"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-text-strong)"
        aria-hidden="true"
      >
        <CornerUpLeft className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-(--el-text-strong)">{t('cascadeBackTitle')}</p>
        <p className="mt-1 text-sm text-(--el-text-strong)">{t('cascadeBackBody')}</p>

        {willRefresh.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-(--el-text-strong)">
              {t('willRefreshLabel')}:
            </span>
            {willRefresh.map((kind) => (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-secondary)"
              >
                <RotateCw className="size-3.5 text-(--el-text-muted)" aria-hidden="true" />
                {TIER_META[kind].label}
              </span>
            ))}
          </div>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-xs text-(--el-text-strong)">
          <LockOpen className="size-3.5 shrink-0" aria-hidden="true" />
          {t('cascadeNothingLocked')}
        </p>
      </div>
    </div>
  );
}
