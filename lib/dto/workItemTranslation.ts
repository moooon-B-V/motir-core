import type { Locale } from '@/lib/i18n/locales';

// The translation DTOs the item page and the translate route share (Story
// MOTIR-7735 · Subtask MOTIR-8121). Keyed by the store's `fieldRef` strings
// (`title`, `description`, `explanation`, `todo:<id>:text`, `todo:<id>:notes`)
// — an OPEN set, one pair per to-do, so never a map over a closed union.
//
// ⚠️ THEY CARRY FIELD REFS, FLAGS, STATUS AND TEXT ONLY. No organisation id, no
// model id, no price, no upstream error detail: the payer and the model are
// motir-ai's business, and an upstream message can name private hosts.

/** One field's offer for the reader. */
export interface TranslationOfferFieldDTO {
  /** Whether the field's text is not in the reader's language (and not empty). */
  needsTranslation: boolean;
  /** Whether a translation of its CURRENT text into the reader's language is kept. */
  kept: boolean;
  /**
   * The language the field is in — the recorded one, else the local detector's
   * guess, else `null` (undecidable). Only set when `needsTranslation`; it is what
   * the mark's "Translated from {language}" names.
   */
  sourceLanguage: Locale | null;
}

/** What the item page knows before any press: whether to offer Translate, and per field. */
export interface TranslationOfferDTO {
  /** The reader's interface language — what a press translates into. */
  targetLanguage: Locale;
  anyNeedsTranslation: boolean;
  fields: Record<string, TranslationOfferFieldDTO>;
}

/** One field's answer to a press. A field that needs no translation is absent. */
export type FieldTranslationDTO =
  | { fieldRef: string; status: 'ready'; text: string }
  | { fieldRef: string; status: 'failed' | 'no_credit' | 'timeout' };

/** `POST /api/work-items/[id]/translate` → 200. */
export interface TranslateResponseDTO {
  targetLanguage: Locale;
  fields: FieldTranslationDTO[];
}
