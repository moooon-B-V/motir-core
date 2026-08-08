'use client';

import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/contexts/theme-context';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import type { ThemePattern } from '@/lib/theme/types';

/**
 * ThemeToggle — a single tri-state control in the top nav that cycles the
 * color pattern light → dark → system → light.
 *
 * It reads + writes the 1.0.5 ThemeProvider via `useTheme()`; the provider
 * owns persistence + the data-theme attribute, so this component is purely the
 * affordance. The icon reflects the *chosen* pattern (sun / moon / monitor),
 * while the tooltip + accessible label also announce the currently *resolved*
 * pattern — relevant when the choice is `system`, where the active theme isn't
 * obvious from the icon alone.
 *
 * `placement` is WHERE it renders, and that decides its display utility
 * (MOTIR-2373 · design/shell design-notes.md § *Every control's disposition
 * below `md`*). The theme toggle is DISPLACED from the below-`md` bar — a
 * preference, changed rarely, with two working second doors (⌘K `acct-theme`
 * and /settings/account/appearance) — so in the bar it is `hidden md:inline-flex`
 * and in the drawer's utility strip it is a plain `inline-flex`. The display
 * utility is SELECTED, never appended: `.hidden` and `.inline-flex` have equal
 * specificity and the winner would be whichever Tailwind emits last.
 */
const CYCLE: ThemePattern[] = ['light', 'dark', 'system'];

const META: Record<ThemePattern, { Icon: typeof Sun }> = {
  light: { Icon: Sun },
  dark: { Icon: Moon },
  system: { Icon: Monitor },
};

export function ThemeToggle({ placement = 'bar' }: { placement?: 'bar' | 'drawer' } = {}) {
  const t = useTranslations('shell');
  const { pattern, resolvedPattern, setPattern } = useTheme();
  const { Icon } = META[pattern];

  // "System (dark)" when following the OS; plain "Light" / "Dark" otherwise.
  const announced =
    pattern === 'system'
      ? t('theme.systemResolved', { resolved: resolvedPattern })
      : t(`theme.${pattern}`);

  function cycle() {
    const next = CYCLE[(CYCLE.indexOf(pattern) + 1) % CYCLE.length]!;
    setPattern(next);
  }

  return (
    <Tooltip content={t('theme.tooltip', { state: announced })}>
      <button
        type="button"
        onClick={cycle}
        aria-label={t('theme.ariaLabel', { state: announced })}
        className={cn(
          'text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) transition-colors focus-visible:outline-none focus-visible:ring-2',
          placement === 'bar' ? 'hidden md:inline-flex' : 'inline-flex',
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}
