'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CircleAlert, Languages, RotateCcw } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { setLocale } from '@/lib/i18n/actions';

/**
 * The language control on the signed-out frame (Story MOTIR-7730 · MOTIR-7758),
 * built to `design/auth/auth-frame--language-control.mock.html` and
 * `design/auth/design-notes.md` § _The language control on the signed-out frame_.
 * `app/(auth)/layout.tsx` mounts it ONCE, in the page's top-right corner on the
 * wash, so every `(auth)` route inherits it the way it inherits the lockup.
 *
 * A choice runs `setLocale` inside a transition and then `router.refresh()` — the
 * shape `LanguageCard` ships in Settings. Signed out, `setLocale` writes this
 * browser's `NEXT_LOCALE` cookie (which sign-up seeds the new account from);
 * signed in, it saves the account language first. The control does not read the
 * session and does not branch on it.
 *
 * ⚠️ A REFRESH, NEVER A NAVIGATION. `router.refresh()` re-renders the server
 * components in the new language and keeps every client component mounted, so
 * what the person typed, the step they are on and every query parameter
 * (`?next=`, `?draft=`, the device `user_code`) survive the switch. A push, a
 * replace or a reload would drop them.
 *
 * Pending: the trigger is `aria-busy` with a spinner in the chevron's slot, and a
 * visually hidden polite status says what is happening. Nothing is disabled and
 * nothing moves (design flag 4). A second choice before the first lands
 * supersedes it: each choice is stamped with a sequence number and only the
 * newest may refresh or show a failure.
 *
 * Failed: no refresh, so the page stays in its current language (the MOTIR-7747
 * rule `LanguageCard` follows too), and a quiet line under the trigger offers
 * **Try again**, which repeats the same choice.
 */
export function AuthLanguageControl() {
  const current = useLocale() as Locale;
  const t = useTranslations('auth.language');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The language a switch in flight is heading to (the pending status names it).
  const [target, setTarget] = useState<Locale | null>(null);
  // The choice that last failed — the failed line shows while it is set, and
  // Try again repeats it.
  const [failed, setFailed] = useState<Locale | null>(null);
  const seq = useRef(0);

  const options: ComboboxOption<Locale>[] = locales.map((locale) => ({
    value: locale,
    label: localeLabel[locale],
    lang: locale,
  }));

  function choose(next: Locale) {
    // Choosing what is already shown (or already on its way) changes nothing.
    if (next === (isPending ? target : current)) {
      if (!isPending) setFailed(null);
      return;
    }
    const mine = ++seq.current;
    setFailed(null);
    setTarget(next);
    startTransition(async () => {
      try {
        await setLocale(next);
      } catch {
        // A failed save leaves the language as it was: no refresh.
        if (seq.current === mine) setFailed(next);
        return;
      }
      // A newer choice superseded this one; let that one settle the page.
      if (seq.current !== mine) return;
      router.refresh();
    });
  }

  return (
    <div className="relative">
      <Combobox
        label={t('label', { language: localeLabel[current] })}
        options={options}
        value={current}
        onChange={choose}
        className="w-auto"
        align="end"
        busy={isPending}
        triggerIcon={<Languages className="h-4 w-4 text-(--el-text-secondary)" />}
      />
      {/* The pending status: visually hidden, polite. Always mounted so a reader
          is told when its text appears. */}
      <span role="status" className="sr-only">
        {isPending && target
          ? withEndonym(t('switching', { language: ENDONYM_SLOT }), target)
          : null}
      </span>
      {/* The failed line: polite, not an alert — the form still works. The live
          region is always mounted; the visible line is drawn only on failure. */}
      <div role="status" className="absolute top-full right-0 mt-1">
        {failed ? (
          <p className="flex w-max max-w-[calc(100vw-3rem)] flex-wrap items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs text-(--el-text) shadow-(--shadow-subtle) sm:flex-nowrap sm:whitespace-nowrap">
            <CircleAlert
              className="h-3.5 w-3.5 shrink-0 text-(--el-danger-on-surface)"
              aria-hidden
            />
            <span>{t('failed')}</span>
            <button
              type="button"
              onClick={() => choose(failed)}
              className="inline-flex items-center gap-1 rounded-(--radius-control) font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('retry')}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

// A private-use character the catalogue never contains, passed as `{language}`
// so the formatted sentence can be split around it and the endonym put back
// inside a span carrying its own `lang` — a translation argument is a string, so
// the span cannot be passed through the message itself.
const ENDONYM_SLOT = '';

function withEndonym(text: string, locale: Locale): ReactNode {
  const [before, ...rest] = text.split(ENDONYM_SLOT);
  if (rest.length === 0) return text;
  return (
    <>
      {before}
      <span lang={locale}>{localeLabel[locale]}</span>
      {rest.join(localeLabel[locale])}
    </>
  );
}
