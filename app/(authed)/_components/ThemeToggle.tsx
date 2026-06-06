'use client';

import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/contexts/theme-context';
import { Tooltip } from '@/components/ui/Tooltip';
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
 */
const CYCLE: ThemePattern[] = ['light', 'dark', 'system'];

const META: Record<ThemePattern, { Icon: typeof Sun }> = {
  light: { Icon: Sun },
  dark: { Icon: Moon },
  system: { Icon: Monitor },
};

export function ThemeToggle() {
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
        className="text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) inline-flex h-9 w-9 items-center justify-center rounded-(--radius-sm) transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}
