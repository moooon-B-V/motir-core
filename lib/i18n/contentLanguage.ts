import { topAcceptLanguageTag } from './acceptLanguage';
import { defaultLocale, isLocale, type Locale } from './locales';

// The content language an organisation is CREATED with (Story MOTIR-7731 ·
// MOTIR-8093): Chinese when the creating request's top-ranked `Accept-Language`
// entry is Chinese in any form (`zh`, `zh-CN`, `zh-TW`, `zh-Hant`), English
// otherwise — including a browser whose top entry is another language Motir
// ships (`ja`, `de`, …), one Motir does not (`sv`), and no header at all.
//
// Only the TOP entry counts: `ja, zh;q=0.9` is a Japanese browser and gets
// English. That is why this reads `topAcceptLanguageTag` and not
// `matchAcceptLanguage`, which skips to the best entry it recognises. The
// `NEXT_LOCALE` cookie is not read either: it is the person's DISPLAY language,
// which the organisation's content language never follows.
//
// Pure and Next-free, so the seams that hold a request (the signup hook, the
// workspace middleware, the create-organization action) resolve it and hand a
// `Locale` down; the service and repository layers never see a header.

const CHINESE: string = 'zh';

export function contentLanguageFromAcceptLanguage(header: string | null | undefined): Locale {
  const top = topAcceptLanguageTag(header);
  const base = top?.split('-')[0];
  return base === CHINESE && isLocale(CHINESE) ? CHINESE : defaultLocale;
}
