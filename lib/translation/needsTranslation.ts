import { isLocale, type Locale } from '@/lib/i18n/locales';
import { detectLocale } from '@/lib/translation/detectLanguage';

// The per-field needs-translation classifier (Story MOTIR-7735 · Subtask
// MOTIR-8115). Pure: no database, no network, no AI call — so deciding whether
// to show Translate never costs credit, and the door service and the page DTO
// above it can both call it without an upward import.
//
// Per field:
//   1. empty or whitespace-only text never needs translating            → 'empty'
//   2. a RECORDED language is compared to the reader's (primary subtag,
//      case-insensitive); the detector is not consulted                 → 'recorded'
//   3. no record: the local detector reads the prose                    → 'detected'
//      and when it cannot tell, the field counts as NOT the reader's,
//      so the reader can still ask                                      → 'undecidable'
//
// It deliberately does not read the organisation's content language: a field
// with no record is judged by its text, not by a guess at who wrote it.

export interface ClassifiableField {
  /** A caller-chosen id — the DTO uses the `fieldRef` forms (`title`, `todo:<id>:text`, …). */
  id: string;
  text: string;
  /** The field's recorded content language, or `null` when none was recorded. */
  language: string | null;
}

export type NeedsTranslationBasis = 'recorded' | 'detected' | 'undecidable' | 'empty';

export interface FieldClassification {
  id: string;
  needsTranslation: boolean;
  basis: NeedsTranslationBasis;
}

function primarySubtag(tag: string): string {
  return tag.trim().split(/[-_]/)[0]!.toLowerCase();
}

function classifyField(field: ClassifiableField, reader: string): FieldClassification {
  if (field.text.trim().length === 0) {
    return { id: field.id, needsTranslation: false, basis: 'empty' };
  }
  if (field.language != null && field.language.trim().length > 0) {
    return {
      id: field.id,
      needsTranslation: primarySubtag(field.language) !== reader,
      basis: 'recorded',
    };
  }
  const detected = detectLocale(field.text);
  if (detected == null) return { id: field.id, needsTranslation: true, basis: 'undecidable' };
  return { id: field.id, needsTranslation: detected !== reader, basis: 'detected' };
}

/** Whether each field needs translating for a reader whose locale is `readerLocale`. */
export function classifyFields(
  fields: readonly ClassifiableField[],
  readerLocale: string,
): FieldClassification[] {
  const reader = primarySubtag(readerLocale);
  return fields.map((field) => classifyField(field, reader));
}

/** Whether any field needs translating — i.e. whether to offer Translate at all. */
export function anyNeedsTranslation(results: readonly FieldClassification[]): boolean {
  return results.some((r) => r.needsTranslation);
}

/**
 * The language a field that DIFFERS from the reader's is in: the recorded one, else
 * the local detector's reading, else `null` (unknown or not a supported locale).
 * The one place a differing field's language is named, shared by the page offer and
 * the many-titles door.
 */
export function sourceLanguageOf(
  field: Pick<ClassifiableField, 'text' | 'language'>,
  verdict: FieldClassification,
): Locale | null {
  if (verdict.basis === 'recorded') {
    const primary = primarySubtag(field.language!);
    return isLocale(primary) ? primary : null;
  }
  return verdict.basis === 'detected' ? detectLocale(field.text) : null;
}
