import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import ja from '@/messages/ja.json';
import ko from '@/messages/ko.json';
import de from '@/messages/de.json';
import fr from '@/messages/fr.json';
import es from '@/messages/es.json';
import it from '@/messages/it.json';
import nl from '@/messages/nl.json';
import pl from '@/messages/pl.json';
import pt from '@/messages/pt.json';
import { withEnglishFallback, type Messages } from './englishFallback';
import { defaultLocale, type Locale } from './locales';

export { withEnglishFallback };

// Statically-imported catalogs for OUT-OF-REQUEST translation — chiefly email
// rendering, which happens inside the `email.send` background job where there is
// no cookie/request scope and so `getTranslations()` (which reads the cookie via
// i18n/request.ts) would throw. Pair these with next-intl's synchronous
// `createTranslator({ locale, messages, namespace })`.
const messagesByLocale: Record<Locale, Messages> = { en, zh, ja, ko, de, fr, es, it, nl, pl, pt };

const merged = new Map<Locale, Messages>();

export function getMessagesFor(locale: Locale): Messages {
  const known = locale in messagesByLocale ? locale : defaultLocale;
  if (known === defaultLocale) return messagesByLocale[defaultLocale];
  let messages = merged.get(known);
  if (!messages) {
    messages = withEnglishFallback(messagesByLocale[known], en);
    merged.set(known, messages);
  }
  return messages;
}
