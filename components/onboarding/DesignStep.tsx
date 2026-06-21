'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, RotateCcw, Sliders } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StyleVignette } from '@/components/theme/StyleVignette';
import {
  AxisField,
  AxisNote,
  PalettePicker,
  StylePicker,
  TypePicker,
} from '@/components/theme/AppearancePickers';
import { useTheme } from '@/lib/contexts/theme-context';
import { DEFAULT_STYLE_ID, STYLE_REGISTRY } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID, PALETTE_REGISTRY } from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID, TYPE_REGISTRY } from '@/lib/theme/typography';

// The onboarding DESIGN STEP (Subtask 7.3.27 / MOTIR-1040) — screen H of
// `design/ai-chat/onboarding.mock.html`. The web-only full-page step where the
// user picks their product's look on three axes — Style (shape/feel) × Palette
// (colour) × Type (typography) — and the WHOLE page restyles live, because "the
// page you're looking at IS the example".
//
// It COMPOSES the shipped three-axis runtime (it invents nothing):
//   • `useTheme()` (lib/contexts/theme-context) owns the live `<html>`
//     `data-style` / `data-palette` / `data-type` attributes + localStorage +
//     (signed-in) the debounced cross-device PATCH to /api/appearance-preference.
//     So picking an axis re-skins / re-shapes / re-types Motir instantly — this
//     step included — with NO `router.refresh()` (the page-state rule's "the
//     edited surface is its own confirmation"; the inline-edit-no-refresh
//     contract). This is the same wiring the account-settings `AppearanceCard`
//     uses — Motir dogfooding its own design system, here turned on the user's
//     product look during onboarding.
//   • The 7.3.37 `StyleVignette` (LIVE mode) is the example product slice; it
//     inherits the active `<html>` selection, so it restyles on every pick.
//   • The shared `StylePicker` / `PalettePicker` / `TypePicker` chips.
//
// SCOPE (this card): the three-axis live picker + the step frame. CARVED OUT to
// their own subtasks during planning — the "Fine-tune" tweaks panel
// (density/radius/motion; MOTIR-1246 design + MOTIR-1247 runtime, drawn disabled
// here like the shell draws "Go to plan"), and the conductor auto-advance +
// motir-ai DESIGN.md handoff on "Use this design" (cross-repo; the plan exit is
// MOTIR-1041). Here "Use this design" returns to the hub with the look applied;
// "Skip" resets the three axes to their defaults first.

export interface DesignStepProps {
  /** Leave the design step for the hub, keeping the chosen look applied. */
  onBack: () => void;
  /** Confirm the look and return to the hub (the design is already applied +
   *  persisted via `useTheme()`; the "go to plan" commit is MOTIR-1041). */
  onUseDesign: () => void;
}

export function DesignStep({ onBack, onUseDesign }: DesignStepProps) {
  const t = useTranslations('onboarding.design');
  const { styleId, palette, type, setStyleId, setPalette, setType } = useTheme();

  // Skip = "use the default look": reset all three axes, then leave. The reset
  // flows through the same `useTheme()` setters, so it persists like any pick.
  function skipToDefault() {
    setStyleId(DEFAULT_STYLE_ID);
    setPalette(DEFAULT_PALETTE_ID);
    setType(DEFAULT_TYPE_ID);
    onBack();
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-(--el-surface)" aria-label={t('header')}>
      {/* Step bar — a plain Back + a descriptive header (matches the review gate's
          chrome). It restyles too: it lives under the same re-themed <html>. */}
      <div className="flex items-center gap-3 border-b border-(--el-border) px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ArrowLeft className="size-4" />}
          onClick={onBack}
        >
          {t('back')}
        </Button>
        <span className="grow font-mono text-xs font-semibold uppercase tracking-wide text-(--el-text-faint)">
          {t('header')}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-[64rem]">
          <h1 className="font-serif text-2xl font-bold text-(--el-text)">{t('title')}</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-(--el-text-secondary)">{t('lead')}</p>

          {/* Two-column at the desktop breakpoint — the pickers (the bulk) on the
              flexible track, the live example on a fixed 30rem track; collapses to
              one column below `lg:`. Mirrors the shipped AppearanceCard grid
              (8.8.15 / MOTIR-1198); `minmax(0,…)` is the grid min-w-0. */}
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start">
            <div className="min-w-0">
              <AxisField
                name={t('style.name')}
                help={t('style.help')}
                note={
                  <AxisNote
                    name={STYLE_REGISTRY[styleId].name}
                    tagline={STYLE_REGISTRY[styleId].tagline}
                  />
                }
              >
                <StylePicker value={styleId} onChange={setStyleId} label={t('style.name')} />
              </AxisField>

              <AxisField
                name={t('palette.name')}
                help={t('palette.help')}
                note={
                  <AxisNote
                    name={PALETTE_REGISTRY[palette].name}
                    tagline={PALETTE_REGISTRY[palette].tagline}
                  />
                }
              >
                <PalettePicker value={palette} onChange={setPalette} label={t('palette.name')} />
              </AxisField>

              <AxisField
                name={t('type.name')}
                help={t('type.help')}
                note={
                  <AxisNote name={TYPE_REGISTRY[type].name} tagline={TYPE_REGISTRY[type].tagline} />
                }
              >
                <TypePicker value={type} onChange={setType} label={t('type.name')} />
              </AxisField>

              {/* Fine-tune knobs (density / radius / motion) are MOTIR-1246
                  (design) + MOTIR-1247 (runtime) — drawn disabled here, the same
                  way the shell draws its "Go to plan" exit (MOTIR-1041). */}
              <div className="border-t border-(--el-border-soft) pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Sliders className="size-4" />}
                  disabled
                  title={t('fineTuneSoon')}
                >
                  {t('fineTune')}
                </Button>
              </div>
            </div>

            {/* The example column sticks in view (desktop) while the controls
                scroll. LIVE mode (no axis props) → the specimen inherits the
                active <html> selection, so it re-skins on every pick. */}
            <section className="flex min-w-0 flex-col gap-2.5 lg:sticky lg:top-6">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-(--el-text-faint)">
                {t('example.eyebrow')}
              </p>
              <StyleVignette label={t('example.label')} />
            </section>
          </div>

          {/* Footer — Skip (use default) + Use this design (go on). */}
          <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-5">
            <span className="flex items-center gap-1.5 text-xs text-(--el-text-muted)">
              {t('footerNote')}
            </span>
            <span className="grow" />
            <Button
              variant="ghost"
              leftIcon={<RotateCcw className="size-4" />}
              onClick={skipToDefault}
            >
              {t('skip')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight className="size-4" />}
              onClick={onUseDesign}
            >
              {t('use')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
