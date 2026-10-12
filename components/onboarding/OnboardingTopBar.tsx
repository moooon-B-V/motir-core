'use client';

import { useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { BrandMark } from '@/components/brand/BrandMark';
import { Button } from '@/components/ui/Button';
import { AuthLanguageControl } from '@/components/i18n/AuthLanguageControl';

// The onboarding window's persistent top bar (MOTIR-1488) — the `wz-bar` from
// `design/ai-chat/onboarding.mock.html`, present on EVERY step of the full-page
// onboarding route. Onboarding sits OUTSIDE the app shell (no nav to leave
// through), so this bar carries its own exit: a ghost "Save & exit" that returns
// the user to the app. Progress is already persisted server-side (motir-ai
// `PreplanSession`), so exiting loses nothing — it is the full-page-route
// exception to the planning overlay's ✕/Esc/discard-guard chrome
// (`design/ai-chat/design-notes.md` §"Opening & exiting").
//
// Presentational: the shell (`DiscoveryOnboarding`) owns the exit action + the
// step label; the labeled "Resume onboarding" re-entry door is MOTIR-1533.
//
// The brand is the real Motir lockup (MOTIR-8252, built to the Pattern panel of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`):
// `BrandMark` lockup, default tone — it replaced a lavender tile holding a
// lucide `Sparkles`. MOTIR-8255 sets it to the discovery bar's own spec
// (design/ai-chat/design-notes.md § 2026-10-12, F6): 22 px, since the 52 px bar
// is denser than the hero bar's 28, then a 1 px `--el-border` divider, which keeps
// the fallback label from reading "Motir New project". It is NOT a link here:
// this bar's one way out is "Save & exit", and a home link beside it would be a
// second exit that skips the save.
// The glyph is `aria-hidden` and the visible wordmark is the text, so it carries
// no `aria-label` (design/brand §8).
//
// The language control (MOTIR-8286) closes the trailing end, after Save & exit
// (design/ai-chat § 2026-10-12, Panel 3): the shared `AuthLanguageControl`,
// mounted as is — a refresh, never a navigation, so the canvas and the chat keep
// their state across a switch.

export interface OnboardingTopBarProps {
  /** The active project's human-readable name (shown left, beside the brand). */
  projectName?: string | null;
  /** The contextual step caption shown right of centre (building vs revisiting). */
  stepLabel: string;
  /** Fired when the user clicks "Save & exit" — the shell handles navigation. */
  onExit: () => void;
}

export function OnboardingTopBar({ projectName, stepLabel, onExit }: OnboardingTopBarProps) {
  const t = useTranslations('onboarding.chat');
  return (
    <header
      aria-label={t('topbarLabel')}
      className="flex h-[3.25rem] shrink-0 items-center justify-between gap-4 border-b border-(--el-border) bg-(--el-page-bg) px-4"
    >
      <span className="inline-flex min-w-0 items-center gap-3">
        <BrandMark variant="lockup" tone="default" size={22} className="shrink-0" />
        <span aria-hidden="true" className="block h-5 w-px flex-none bg-(--el-border)" />
        <span className="truncate text-sm font-semibold text-(--el-text)">
          {projectName ? t('topbarProject', { project: projectName }) : t('topbarProjectFallback')}
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-3">
        <span className="hidden font-mono text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--el-accent-on-surface) sm:inline">
          {stepLabel}
        </span>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<History className="size-4" aria-hidden="true" />}
          onClick={onExit}
        >
          {t('saveExit')}
        </Button>
        <AuthLanguageControl />
      </span>
    </header>
  );
}
