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
  /**
   * The field's CURRENT revision — `hashFieldText` over its stored text, a hash
   * only, never the text (MOTIR-8123). An open translated view compares it with
   * the revision it translated, so an edit re-translates that one field.
   */
  revision: string;
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

/**
 * The translation half of a page read for a signed-in reader (MOTIR-8122): the
 * offer, and whether the no-credit message may link to adding credit — the
 * viewer can manage the organisation's billing (owner or admin). Both hosts
 * carry it: the item page from `_view.tsx`, the quick view on the peek read.
 */
export interface ReaderTranslationDTO {
  offer: TranslationOfferDTO;
  canAddCredits: boolean;
}

/**
 * One work item's TITLE answer in the many-titles door (MOTIR-8829). Keyed by the
 * item, with the per-item ref the title was sent under; an item whose title needs
 * no translation is absent. Status, text and source language only.
 */
export type TitleTranslationResultDTO =
  | {
      workItemId: string;
      fieldRef: string;
      status: 'ready';
      text: string;
      /** The language the stored title is in, or `null` when it is not known. */
      sourceLanguage: Locale | null;
    }
  | { workItemId: string; fieldRef: string; status: 'failed' | 'no_credit' | 'timeout' };

/** `POST /api/projects/[key]/titles/translate` → 200 (MOTIR-8829). */
export interface TitlesTranslateResponseDTO {
  targetLanguage: Locale;
  /** False when the project's auto-translate switch is off: nothing was read or spent. */
  enabled: boolean;
  /** True when more titles were asked for than one request answers; the first ones were. */
  truncated: boolean;
  titles: TitleTranslationResultDTO[];
}
