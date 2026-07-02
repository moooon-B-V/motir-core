'use client';

import { useTranslations } from 'next-intl';
import { History, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';

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
        <span className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender)">
          <Sparkles className="size-4 text-(--el-accent-on-surface)" aria-hidden="true" />
        </span>
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
      </span>
    </header>
  );
}
