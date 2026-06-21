'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StyleVignette } from '@/components/theme/StyleVignette';
import {
  AxisField,
  AxisNote,
  PalettePicker,
  StylePicker,
  ThemeSegmentedControl,
  TypePicker,
} from '@/components/theme/AppearancePickers';
import { DEFAULT_STYLE_ID, STYLE_REGISTRY, type StyleId } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID, PALETTE_REGISTRY, type PaletteId } from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID, TYPE_REGISTRY, type TypeId } from '@/lib/theme/typography';
import type { ThemePattern } from '@/lib/theme/types';

// The onboarding DESIGN STEP (Subtask 7.3.27 / MOTIR-1040) — screen H of
// `design/ai-chat/onboarding.mock.html`. The web-only step where the user designs
// THEIR NEW PROJECT's look on four controls — Theme (light/dark) × Style
// (shape/feel) × Palette (colour) × Type (typography).
//
// ⚠️ This designs the USER'S PROJECT, NOT Motir itself (Yue). So — unlike the
// account-settings Appearance pane, which themes Motir via the global `useTheme()`
// — this step holds its OWN local state and scopes it to THIS PAGE: the
// `data-theme/-style/-palette/-type` attributes sit on the design step's ROOT
// `<section>`, so the WHOLE wizard page restyles (header, pickers, the preview,
// the footer — the page IS the example, screen H), but ONLY this page. Nothing is
// written to `<html>`, so the hub and the rest of Motir stay exactly as they are.
// The page defaults to LIGHT regardless of Motir's own theme — the
// `[data-theme='light']` re-assertion block in globals.css lets the scoped subtree
// force light even when Motir is dark.
//
// The chosen design is local for now; persisting it to the user's project (the
// DESIGN.md starter) is the cross-repo handoff downstream (MOTIR-1041 / motir-ai).
// "Fine-tune" knobs (density/radius/motion) are a separate subtask (MOTIR-1246/47).

export interface DesignStepProps {
  /** Leave the design step for the hub. */
  onBack: () => void;
  /** Confirm the look and return to the hub (persisting the choice to the project
   *  is the downstream cross-repo handoff, MOTIR-1041). */
  onUseDesign: () => void;
}

export function DesignStep({ onBack, onUseDesign }: DesignStepProps) {
  const t = useTranslations('onboarding.design');

  // The PROJECT's design — local to this step, NOT the global Motir theme. Light
  // is the default product look.
  const [pattern, setPattern] = useState<ThemePattern>('light');
  const [styleId, setStyleId] = useState<StyleId>(DEFAULT_STYLE_ID);
  const [palette, setPalette] = useState<PaletteId>(DEFAULT_PALETTE_ID);
  const [type, setType] = useState<TypeId>(DEFAULT_TYPE_ID);

  const themeLabels: Record<ThemePattern, string> = {
    light: t('theme.light'),
    dark: t('theme.dark'),
    system: t('theme.system'),
  };

  function resetToDefault() {
    setPattern('light');
    setStyleId(DEFAULT_STYLE_ID);
    setPalette(DEFAULT_PALETTE_ID);
    setType(DEFAULT_TYPE_ID);
  }

  // The page's scoped axis attributes — applied to the design step's ROOT section
  // ONLY, so the WHOLE wizard page wears the chosen design, never Motir. `system`
  // carries no data-theme (the page then follows the OS like a real app would);
  // light/dark force it (the [data-theme='light'] block re-asserts light under a
  // dark Motir).
  const pageAttrs: Record<string, string> = {
    // `data-appearance-scope` re-emits the --el-* layer locally so the overridden
    // --color-* (from the axes below) actually reaches the tokens components read —
    // see globals.css. Without it, only :root's --el-* (Motir's) would apply.
    'data-appearance-scope': '',
    'data-style': styleId,
    'data-palette': palette,
    'data-type': type,
  };
  if (pattern !== 'system') pageAttrs['data-theme'] = pattern;

  return (
    <section
      {...pageAttrs}
      data-testid="design-page"
      className="flex h-full min-h-0 flex-col bg-(--el-surface)"
      aria-label={t('header')}
    >
      {/* Step bar — Motir's own chrome (NOT scoped). */}
      <div className="flex flex-none items-center gap-3 border-b border-(--el-border) px-4 py-3">
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

      {/* Scrolling body: the controls, then the big scoped preview. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-[72rem]">
          <h1 className="font-serif text-2xl font-bold text-(--el-text)">{t('title')}</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-(--el-text-secondary)">{t('lead')}</p>

          {/* The four controls — Motir's own chrome; they drive the LOCAL project
              design, never the app theme. */}
          <div className="mt-5 flex flex-col">
            <AxisField
              name={t('theme.name')}
              help={t('theme.help')}
              note={t(`theme.note.${pattern}`)}
            >
              <ThemeSegmentedControl
                value={pattern}
                onChange={setPattern}
                label={t('theme.name')}
                labels={themeLabels}
              />
            </AxisField>

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
          </div>

          {/* A concrete product preview INSIDE the already-scoped page — a real
              app surface (the 7.3.37 specimen) framed as an app window, so the user
              sees their PRODUCT UI (not just the wizard chrome) in the chosen
              design. It inherits the section's scoped axes (no own data-*). */}
          <div className="mt-8">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-(--el-text-faint)">
              {t('example.eyebrow')}
            </p>
            <div className="mt-2.5 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg)">
              {/* faux window chrome — three dots + the project's accent bar */}
              <div className="flex items-center gap-2 border-b border-(--el-border) bg-(--el-surface) px-4 py-2.5">
                <span className="size-3 rounded-full bg-(--el-danger)" aria-hidden />
                <span className="size-3 rounded-full bg-(--el-warning)" aria-hidden />
                <span className="size-3 rounded-full bg-(--el-success)" aria-hidden />
                <span
                  className="ml-3 h-4 w-40 rounded-(--radius-badge) bg-(--el-muted)"
                  aria-hidden
                />
              </div>
              <div className="p-6 lg:p-8">
                <StyleVignette label={t('example.label')} className="w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer — pinned (outside the scroll area). Motir's chrome. */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-t border-(--el-border) bg-(--el-surface) px-4 py-3">
        <span className="text-xs text-(--el-text-muted)">{t('footerNote')}</span>
        <span className="grow" />
        <Button
          variant="ghost"
          leftIcon={<RotateCcw className="size-4" />}
          onClick={resetToDefault}
        >
          {t('reset')}
        </Button>
        <Button
          variant="primary"
          rightIcon={<ArrowRight className="size-4" />}
          onClick={onUseDesign}
        >
          {t('use')}
        </Button>
      </div>
    </section>
  );
}
