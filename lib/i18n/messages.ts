import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { defaultLocale, type Locale } from './locales';

// Statically-imported catalogs for OUT-OF-REQUEST translation — chiefly email
// rendering, which happens inside the `email.send` background job where there is
// no cookie/request scope and so `getTranslations()` (which reads the cookie via
// i18n/request.ts) would throw. Pair these with next-intl's synchronous
// `createTranslator({ locale, messages, namespace })`.
const messagesByLocale: Record<Locale, Record<string, unknown>> = { en, zh };

export function getMessagesFor(locale: Locale): Record<string, unknown> {
  return messagesByLocale[locale] ?? messagesByLocale[defaultLocale];
}
