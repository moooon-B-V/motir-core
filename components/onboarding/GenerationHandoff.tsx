'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { STYLE_REGISTRY, type StyleId } from '@/lib/theme/styles';
import { PALETTE_REGISTRY, type PaletteId } from '@/lib/theme/palettes';
import { TYPE_REGISTRY, type TypeId } from '@/lib/theme/typography';
import type { DesignChoiceDTO } from '@/lib/dto/aiPreplan';

// The pre-plan → generation HAND-OFF (Subtask 7.3.28 / MOTIR-1041) — the LAST
// affordance of the 7.3 start-fresh onboarding. The "Plan → your project" exit on
// the hub (DiscoveryOnboarding) opens this full-screen view once every pre-plan
// tier is complete. It marks the boundary where the pre-plan (discovery) phase
// ENDS and generation (7.4 / MOTIR-805) BEGINS.
//
// ⚠️ Scope boundary (Yue, 2026-06-22): 7.3 ENDS here. This view does NOT generate
// or persist the work-item tree, and does NOT submit a job — that is 7.4
// (generation → review → approve: the `generate_tree` handler MOTIR-844, the
// generate-and-persist API MOTIR-846, the review/approve UI MOTIR-843/847). This
// card hands OFF to that entry: it presents the FROZEN baseline (the already-
// persisted `tiers_complete` snapshot — the 4 tier docs + folded catalog + the
// design choice, all owned by motir-ai) as the fixed, known input generation will
// run against, and offers one-click re-entry (Back) into the pre-plan loop. The
// baseline is REVISABLE, not locked: nothing is written here, so going back simply
// re-opens the conductor loop. 7.4's generation surface mounts into this same view.

export interface GenerationHandoffProps {
  /** One-click re-entry into the pre-plan loop (the hub). The frozen baseline is
   *  revisable, not locked — going back re-opens the conductor loop unchanged. */
  onBack: () => void;
  /** Trigger generation (Subtask 7.4.9 / MOTIR-1396) — the 7.4 generation entry
   *  mounting INTO this hand-off view: it submits the `generate_tree` job and
   *  reveals the proposed PlanItems live. This is the boundary the 7.3 hand-off
   *  always anticipated ("7.4's generation surface mounts into this same view"). */
  onGenerate: () => void;
  /** How many pre-plan tiers were produced + reviewed (the snapshot's docs). */
  reviewedCount: number;
  /** The persisted design-step choice frozen into the baseline, or null when the
   *  design step was skipped / gated out (mobile/other) → the default look. */
  designChoice: DesignChoiceDTO | null;
  /** Whether the (web-only) design step applied to this project — drives whether
   *  the design line reads as a chosen look or the default starter. */
  designApplied: boolean;
}

export function GenerationHandoff({
  onBack,
  onGenerate,
  reviewedCount,
  designChoice,
  designApplied,
}: GenerationHandoffProps) {
  const t = useTranslations('onboarding.generation');

  const designSummary =
    designApplied && designChoice
      ? [
          STYLE_REGISTRY[designChoice.styleId as StyleId]?.name,
          PALETTE_REGISTRY[designChoice.paletteId as PaletteId]?.name,
          TYPE_REGISTRY[designChoice.typeId as TypeId]?.name,
        ]
          .filter(Boolean)
          .join(' · ')
      : t('designDefault');

  return (
    <section
      data-testid="generation-handoff"
      className="flex h-full min-h-0 flex-col bg-(--el-surface)"
      aria-label={t('title')}
    >
      {/* Step bar — Motir's own chrome. Back is the one-click re-entry into the
          pre-plan loop (the baseline stays revisable). */}
      <div className="flex flex-none items-center gap-3 border-b border-(--el-border) px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ArrowLeft className="size-4" />}
          onClick={onBack}
        >
          {t('back')}
        </Button>
        <h1 className="grow font-serif text-base font-semibold text-(--el-text)">{t('title')}</h1>
      </div>

      {/* Body — the hand-off state. A centred write-up: the direction is set, the
          frozen baseline it will plan from, and the note that nothing is locked. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-[34rem]">
          <span className="inline-flex size-11 items-center justify-center rounded-(--radius-card) bg-(--el-tint-mint) text-(--el-text-strong)">
            <Sparkles className="size-5" aria-hidden />
          </span>
          <h2 className="mt-5 font-serif text-2xl font-semibold text-(--el-text)">
            {t('heading')}
          </h2>
          <p className="mt-2 text-sm text-(--el-text-secondary)">{t('lead')}</p>

          {/* The frozen baseline — what generation runs against (a revisable
              snapshot, captured at tiers-complete). */}
          <div className="mt-6 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-5">
            <p className="text-xs font-medium tracking-wide text-(--el-text-muted) uppercase">
              {t('baselineTitle')}
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              <li className="flex items-center gap-2 text-sm text-(--el-text)">
                <Check className="size-4 text-(--el-success)" aria-hidden />
                {t('stepsReviewed', { count: reviewedCount })}
              </li>
              <li className="flex items-center gap-2 text-sm text-(--el-text)">
                <Check className="size-4 text-(--el-success)" aria-hidden />
                <span>
                  <span className="text-(--el-text-secondary)">{t('designLabel')}: </span>
                  {designSummary}
                </span>
              </li>
            </ul>
          </div>

          {/* The 7.4 generation TRIGGER (MOTIR-1396) — clicking starts the
              `generate_tree` job + the live reveal mounted into this view. */}
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Sparkles className="size-4" />}
            onClick={onGenerate}
            className="mt-6"
          >
            {t('generateCta')}
          </Button>

          <p className="mt-5 text-sm text-(--el-text-muted)">{t('revisableNote')}</p>
        </div>
      </div>
    </section>
  );
}
