import { getTranslations } from 'next-intl/server';
import { createTranslator } from 'next-intl';
import { getMessagesFor } from './messages';
import { defaultLocale } from './locales';

// A translator bound to the `errors` namespace that works in BOTH a request
// (real locale, via next-intl's getTranslations) AND outside one. Server Actions
// resolve their user-facing error strings through this; the unit suite calls
// those actions DIRECTLY (no Next request scope), where getTranslations throws
// ("not supported in Client Components" — next-intl resolves to its client build
// without the react-server condition). There we fall back to a synchronous
// createTranslator pinned to the base locale, so error strings stay byte-
// identical in tests while still localizing for real users.
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

export async function getErrorsTranslator(): Promise<ErrorTranslator> {
  try {
    return (await getTranslations('errors')) as unknown as ErrorTranslator;
  } catch {
    return createTranslator({
      locale: defaultLocale,
      messages: getMessagesFor(defaultLocale),
      namespace: 'errors',
    }) as unknown as ErrorTranslator;
  }
}
