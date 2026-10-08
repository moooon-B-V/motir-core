// The browser's language choice (Story MOTIR-7730 · MOTIR-7747): next-intl's
// default cookie name, read by `i18n/request.ts` as step 2 of the resolution
// order. ONE definition, so the Settings action and the sign-in sync can never
// write it with different attributes.

export const LOCALE_COOKIE = 'NEXT_LOCALE';

export const LOCALE_COOKIE_OPTIONS = {
  path: '/',
  maxAge: 60 * 60 * 24 * 365, // one year
  sameSite: 'lax',
} as const;
