'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/Tooltip';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { setLocale } from '@/lib/i18n/actions';

/**
 * LocaleToggle — a single control in the top nav that cycles the UI language,
 * mirroring the ThemeToggle affordance exactly (icon button + Tooltip, same
 * sizing/tokens). With two shipped locales it toggles en ⇄ zh; it cycles
 * through `locales` in order, so adding more languages needs no change here.
 *
 * Writes the NEXT_LOCALE cookie via the setLocale server action inside a
 * transition, then router.refresh() re-renders server components in the new
 * locale — the same no-full-reload UX as the theme toggle.
 */
export function LocaleToggle() {
  const current = useLocale() as Locale;
  const t = useTranslations('localeToggle');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function cycle() {
    const next = locales[(locales.indexOf(current) + 1) % locales.length]!;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  const announced = `${t('label')}: ${localeLabel[current]}`;

  return (
    <Tooltip content={announced}>
      <button
        type="button"
        onClick={cycle}
        disabled={isPending}
        aria-label={`${announced}. ${t('activate')}`}
        className="text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) inline-flex h-9 w-9 items-center justify-center rounded-(--radius-sm) transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
      >
        <Languages className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}
