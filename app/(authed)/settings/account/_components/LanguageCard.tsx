'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { setLocale } from '@/lib/i18n/actions';

// The Language preference card inside the account-settings area's Language pane
// (Story 7.8 · Subtask 7.8.12, moved from the flat account page). Behaviour is
// unchanged — it saves the choice on the account and the NEXT_LOCALE cookie via
// the setLocale server action (MOTIR-7747) inside a transition, then router.refresh() re-renders server components in the
// new locale (the same no-full-reload UX as the top-nav toggle). Only the layout
// follows the design (`account-settings.mock.html` Panel 1): a titled Card with
// the SETTINGS-ROW grammar (a label + description on the left, the control on the
// right, hairline-separated) — the pattern that scales as region / timezone /
// date-format rows land later.
//
// A second row shows the ACTIVE organisation's CONTENT language read-only
// (MOTIR-8095 · `org-admin--content-language.mock.html` panel 2): the language
// Motir's planner and agents write that organisation's new work in. It is no
// control here — owners and admins change it on the org General card, and get a
// link there. No active organisation, no row.
export interface LanguageCardProps {
  contentLanguage?: { orgName: string; language: Locale; canChange: boolean } | null;
}

export function LanguageCard({ contentLanguage = null }: LanguageCardProps = {}) {
  const current = useLocale() as Locale;
  const t = useTranslations('settings.language');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const options: ComboboxOption<Locale>[] = locales.map((locale) => ({
    value: locale,
    label: localeLabel[locale],
    lang: locale,
  }));

  function change(next: Locale) {
    if (next === current) return;
    startTransition(async () => {
      // A failed save leaves the language as it was (MOTIR-7747): no refresh,
      // so the control stays on the current language rather than half-changing.
      try {
        await setLocale(next);
      } catch {
        return;
      }
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
      {contentLanguage ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-(--el-border-soft) pt-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="font-sans text-sm font-medium text-(--el-text)">
              {t('contentLanguage.label', { org: contentLanguage.orgName })}
            </div>
            <div className="mt-0.5 max-w-[24rem] font-sans text-xs leading-snug text-(--el-text-muted)">
              {t('contentLanguage.desc', { org: contentLanguage.orgName })}
            </div>
            {contentLanguage.canChange ? (
              <Link
                href="/settings/organization"
                className="mt-1 inline-block font-sans text-xs font-medium text-(--el-link)"
              >
                {t('contentLanguage.changeLink')}
              </Link>
            ) : null}
          </div>
          <div className="w-[12rem] shrink-0 pt-0.5">
            <span lang={contentLanguage.language} className="font-sans text-sm text-(--el-text)">
              {localeLabel[contentLanguage.language]}
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
