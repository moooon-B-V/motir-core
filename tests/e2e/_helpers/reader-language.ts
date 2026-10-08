import type { Page } from '@playwright/test';
import { adminDb } from '@/tests/helpers/adminDb';

/**
 * Switch a SIGNED-IN reader's interface language (Story MOTIR-7730).
 *
 * The saved account language outranks the `NEXT_LOCALE` cookie (MOTIR-7743),
 * and a sign-up through the UI seeds it from the request — English for a
 * Playwright browser. So a cookie alone no longer switches a signed-in reader:
 * write the saved language too, the two things the Settings language control
 * writes, and the next navigation renders in `locale`.
 */
export async function setReaderLanguage(page: Page, email: string, locale: string): Promise<void> {
  await adminDb.user.update({ where: { email }, data: { locale } });
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: locale, url: new URL('/', page.url()).href }]);
}
