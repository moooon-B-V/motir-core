import type { Locale } from '@/lib/i18n/locales';
import type { McpSummaryTranslations } from './types';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { de } from './de';
import { fr } from './fr';
import { es } from './es';
import { it } from './it';
import { nl } from './nl';
import { pl } from './pl';
import { pt } from './pt';

// Typed over every non-English locale, so an eleventh locale added to
// `lib/i18n/locales.ts` fails typecheck here until it has a file.
export const MCP_SUMMARY_TRANSLATIONS: Record<Exclude<Locale, 'en'>, McpSummaryTranslations> = {
  zh,
  ja,
  ko,
  de,
  fr,
  es,
  it,
  nl,
  pl,
  pt,
};
