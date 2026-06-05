import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import enMessages from '@/messages/en.json';
import { defaultLocale } from '@/lib/i18n/locales';

// Wraps a unit-rendered component in a NextIntlClientProvider seeded with the
// real `en` catalog, so any component that calls useTranslations() renders the
// exact production English strings. Use this in place of @testing-library's
// `render` for components that read translations — assertions on English text
// stay byte-identical to the catalog. Pass `messages`/`locale` to override (e.g.
// to assert a zh render).
export function renderWithIntl(
  ui: ReactElement,
  {
    locale = defaultLocale,
    messages = enMessages,
    ...options
  }: Omit<RenderOptions, 'wrapper'> & {
    locale?: string;
    messages?: Record<string, unknown>;
  } = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export { enMessages };
