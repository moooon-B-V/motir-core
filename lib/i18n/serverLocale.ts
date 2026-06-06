import { getLocale } from 'next-intl/server';
import { defaultLocale, isLocale, type Locale } from './locales';

// Best-effort current-request locale for non-UI server code that needs to record
// the active locale for LATER use — chiefly building an email payload whose
// rendering happens off the request (in the email.send job). Falls back to the
// default when there is no request scope (background jobs, unit tests), so
// callers never throw.
export async function currentLocale(): Promise<Locale> {
  try {
    const locale = await getLocale();
    return isLocale(locale) ? locale : defaultLocale;
  } catch {
    return defaultLocale;
  }
}
