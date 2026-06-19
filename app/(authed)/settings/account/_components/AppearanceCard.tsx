'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { StyleVignette } from '@/components/theme/StyleVignette';
import {
  AxisField,
  AxisNote,
  PalettePicker,
  StylePicker,
  ThemeSegmentedControl,
  TypePicker,
} from '@/components/theme/AppearancePickers';
import { useTheme } from '@/lib/contexts/theme-context';
import { STYLE_REGISTRY } from '@/lib/theme/styles';
import { PALETTE_REGISTRY } from '@/lib/theme/palettes';
import { TYPE_REGISTRY } from '@/lib/theme/typography';
import type { ThemePattern } from '@/lib/theme/types';

/**
 * The Appearance pane's controls + showcase (Story 7.3 · Subtask 7.3.58) — Motir's
 * three-axis design system turned on itself: the signed-in user themes the Motir
 * app, and it re-renders LIVE as they pick. The mock of record is
 * `design/settings/appearance.mock.html` (7.3.57 / MOTIR-1074).
 *
 * A CLIENT island: it reads + writes the 1.0.5 ThemeProvider via `useTheme()`,
 * which owns the live `<html>` `data-*` attributes + localStorage and (Subtask
 * 7.3.62) the cross-device persistence. So picking an axis re-skins the WHOLE app
 * instantly — this page included — with NO `router.refresh()` (the
 * inline-edit-no-refresh preference contract; the page-state rule's "edited
 * surface is its own confirmation"). Because the page itself re-skins, the design
 * has no separate "live preview" widget; the showcase band is a focused product
 * slice (the 7.3.37 `StyleVignette` in LIVE mode) that makes the change legible.
 *
 * Cross-device sync (Subtask 7.3.62, the MOTIR-1076..1080 cluster): each pick is
 * OPTIMISTIC — it flips the UI + localStorage instantly, then the provider fires a
 * debounced PATCH to `/api/appearance-preference` (1077) so the choice follows the
 * user to every device, reconciled from the seq-guarded 200 body. A failed save
 * degrades quietly via the `syncState: 'error'` footer below — the local switch is
 * never lost. The pane opens reflecting the server-seeded preference (7.3.61).
 */
export function AppearanceCard() {
  const t = useTranslations('settings.appearance');
  const {
    pattern,
    styleId,
    palette,
    type,
    setPattern,
    setStyleId,
    setPalette,
    setType,
    syncState,
  } = useTheme();

  const themeLabels: Record<ThemePattern, string> = {
    light: t('theme.light'),
    dark: t('theme.dark'),
    system: t('theme.system'),
  };

  return (
    <div className="flex flex-col gap-6">
      <Card
        header={
          <div>
            <h3 className="font-sans text-base font-semibold text-(--el-text)">
              {t('card.title')}
            </h3>
            <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{t('card.subtitle')}</p>
          </div>
        }
        // Quiet, non-blocking "couldn't sync" affordance (Subtask 7.3.62): the
        // axis change already applied locally (live UI + localStorage); this only
        // says the cross-device save didn't land. Rendered as a soft footer note
        // (role="status", aria-live polite) so it never interrupts picking.
        footer={
          syncState === 'error' ? (
            <p
              role="status"
              className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-muted)"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-(--el-warning)" aria-hidden />
              {t('sync.error')}
            </p>
          ) : undefined
        }
      >
        <div className="flex flex-col">
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
      </Card>

      <section className="flex flex-col gap-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-(--el-text-faint)">
          {t('showcase.eyebrow')}
        </p>
        {/* LIVE mode (no axis props) → inherits the active <html> selection, so the
            specimen re-skins / re-shapes / re-types on every pick. */}
        <StyleVignette label={t('showcase.label')} />
      </section>
    </div>
  );
}
