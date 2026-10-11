import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { InvalidWorkItemLanguageError } from './errors';

// The language recorded beside a piece of work text (Story MOTIR-7731 ·
// MOTIR-8096). A writer that names a language records it; one that names none
// records the organisation's content language, read in the same transaction as
// the write. A field that is empty records NULL — "no language", which is never
// collapsed to `en` anywhere on the way out.

/** The language a write records: the explicit one if given (validated), else the org's. */
export function resolveWriteLanguage(explicit: unknown, orgContentLanguage: Locale): Locale {
  if (explicit === undefined) return orgContentLanguage;
  if (typeof explicit !== 'string' || !isLocale(explicit)) {
    throw new InvalidWorkItemLanguageError(explicit);
  }
  return explicit;
}

/** Refuse a bad explicit language before any write — `undefined` passes. */
export function assertWriteLanguage(explicit: unknown): void {
  if (explicit !== undefined && (typeof explicit !== 'string' || !isLocale(explicit))) {
    throw new InvalidWorkItemLanguageError(explicit);
  }
}

/** What a stored column reads as: a known locale, or NULL — never a default. */
export function readRecordedLanguage(stored: string | null): Locale | null {
  return stored !== null && isLocale(stored) ? stored : null;
}

/** True when a body field holds text, so a language is recorded for it. */
export function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The org's stored content language as a `Locale`; an unreadable value is `en`. */
export function toOrgContentLanguage(stored: string | null): Locale {
  return stored !== null && isLocale(stored) ? stored : defaultLocale;
}
