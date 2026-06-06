'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { setLocale } from '@/lib/i18n/actions';

// The Language preference card on the account-settings page. Mirrors the
// workspace-settings cards (Card + a design-system control). Writes the
// NEXT_LOCALE cookie via the setLocale server action inside a transition, then
// router.refresh() re-renders server components in the new locale — the same
// no-full-reload UX as the top-nav toggle.
export function LanguageCard() {
  const current = useLocale() as Locale;
  const t = useTranslations('settings');
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
        <h2 className="font-sans text-base font-semibold text-(--el-text)">
          {t('account.language.heading')}
        </h2>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="max-w-[16rem]">
          <Combobox
            label={t('account.language.label')}
            options={options}
            value={current}
            onChange={change}
            disabled={isPending}
          />
        </div>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('account.language.helper')}</p>
      </div>
    </Card>
  );
}
