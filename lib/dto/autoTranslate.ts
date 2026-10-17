import type { Locale } from '@/lib/i18n/locales';

// The reader's translation context (Story MOTIR-7738 · MOTIR-8828): one resolved
// answer to "does auto-translate apply to this reader on this project, into which
// language, and may it be paid for". It carries no organisation id, no price, no
// model and no text, on the same footing as the shipped translation DTOs.

/** `no_credit` — the organisation's AI paywall applies and it cannot pay right now. */
export type AutoTranslateCreditState = 'ok' | 'no_credit';

export interface AutoTranslateContextDTO {
  /** The project's switch, echoed so a surface needs no second read of it. */
  autoTranslateWorkContent: boolean;
  /** The reader's interface language — what the content is translated INTO. */
  targetLanguage: Locale;
  credit: AutoTranslateCreditState;
  /** Whether the no-credit notice may link to adding credit (the `manageBilling` predicate). */
  canAddCredit: boolean;
}
