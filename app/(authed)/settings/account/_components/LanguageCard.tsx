'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { setLocale } from '@/lib/i18n/actions';

// The Language preference card inside the account-settings area's Language pane
// (Story 7.8 · Subtask 7.8.12, moved from the flat account page). Behaviour is
// unchanged — it writes the NEXT_LOCALE cookie via the setLocale server action
// inside a transition, then router.refresh() re-renders server components in the
// new locale (the same no-full-reload UX as the top-nav toggle). Only the layout
// follows the design (`account-settings.mock.html` Panel 1): a titled Card with
// the SETTINGS-ROW grammar (a label + description on the left, the control on the
// right, hairline-separated) — the pattern that scales as region / timezone /
// date-format rows land later.
export function LanguageCard() {
  const current = useLocale() as Locale;
  const t = useTranslations('settings.language');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const options: ComboboxOption<Locale>[] = locales.map((locale) => ({
    value: locale,
    label: localeLabel[locale],
  }));

  function change(next: Locale) {
    if (next === current) return;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <Card
      header={
        <div>
          <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('card.title')}</h3>
          <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{t('card.subtitle')}</p>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-sans text-sm font-medium text-(--el-text)">
            {t('displayLanguage.label')}
          </div>
          <div className="mt-0.5 font-sans text-xs leading-snug text-(--el-text-muted)">
            {t('displayLanguage.desc')}
          </div>
        </div>
        <div className="w-[12rem] shrink-0">
          <Combobox
            label={t('displayLanguage.label')}
            options={options}
            value={current}
            onChange={change}
            disabled={isPending}
          />
        </div>
      </div>
    </Card>
  );
}
