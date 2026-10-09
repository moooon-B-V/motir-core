import type { IdeaLocaleTextDto, IdeaTranslationDto } from '@/lib/dto/ideas';
import {
  IDEA_TRANSLATABLE_FIELDS,
  IDEA_TRANSLATION_LOCALES,
  isTranslatedFieldPresent,
  type IdeaTranslationFields,
  type IdeaTranslationLocale,
} from './translatableFields';

/**
 * An idea's translations as the STAFF read them (Story MOTIR-7772 · MOTIR-7774)
 * — every locale, field by field, plus the locales that still lack text. One
 * function, so the staff DTO, the integration gate and the console read
 * "missing" the same way.
 *
 * A field is PRESENT in a locale when it has text (`isTranslatedFieldPresent`:
 * a non-empty string, or a list at the English list's length). A field that is
 * not present is ABSENT from the output, never null.
 */

/** The English an idea's translations are measured against. */
export interface StaffTranslationSource extends Omit<IdeaTranslationFields, 'capabilities'> {
  title: string;
  pitch: string;
  capabilities: string[];
  translations: ({ locale: IdeaTranslationLocale } & IdeaTranslationFields)[];
  evidence: { claim: string; translations: { locale: IdeaTranslationLocale; claim: string }[] }[];
  tags: {
    tag: { label: string; translations: { locale: IdeaTranslationLocale; label: string }[] };
  }[];
}

export interface StaffTranslationView {
  translations: Partial<Record<IdeaTranslationLocale, IdeaTranslationDto>>;
  /** Per evidence row, in the row's order. */
  claimTranslations: IdeaLocaleTextDto[];
  /** Per tag assignment, in the assignment's order. */
  labelTranslations: IdeaLocaleTextDto[];
  missingLocales: IdeaTranslationLocale[];
}

/** A tag's label translations, by locale. */
export function tagLabelTranslations(
  translations: { locale: IdeaTranslationLocale; label: string }[],
): IdeaLocaleTextDto {
  return localeText(translations.map((t) => ({ locale: t.locale, text: t.label })));
}

function localeText(rows: { locale: IdeaTranslationLocale; text: string }[]): IdeaLocaleTextDto {
  const out: IdeaLocaleTextDto = {};
  for (const row of rows) if (row.text.length > 0) out[row.locale] = row.text;
  return out;
}

/** Whether the English of a field has text — the only fields a locale can be missing. */
function hasEnglish(
  field: (typeof IDEA_TRANSLATABLE_FIELDS)[number],
  source: StaffTranslationSource,
): boolean {
  if (field === 'capabilities') return source.capabilities.length > 0;
  const value = source[field];
  return typeof value === 'string' && value.length > 0;
}

export function toStaffTranslationView(source: StaffTranslationSource): StaffTranslationView {
  const translations: StaffTranslationView['translations'] = {};
  for (const row of source.translations) {
    const fields: IdeaTranslationDto = {};
    for (const field of IDEA_TRANSLATABLE_FIELDS) {
      if (!isTranslatedFieldPresent(field, row, source)) continue;
      if (field === 'capabilities') fields.capabilities = [...row.capabilities];
      else fields[field] = row[field]!;
    }
    if (Object.keys(fields).length > 0) translations[row.locale] = fields;
  }
  const claimTranslations = source.evidence.map((e) =>
    localeText(e.translations.map((t) => ({ locale: t.locale, text: t.claim }))),
  );
  const labelTranslations = source.tags.map((a) => tagLabelTranslations(a.tag.translations));

  const englishFields = IDEA_TRANSLATABLE_FIELDS.filter((f) => hasEnglish(f, source));
  const missingLocales = IDEA_TRANSLATION_LOCALES.filter((locale) => {
    const own = translations[locale] ?? {};
    if (englishFields.some((f) => own[f] === undefined)) return true;
    if (claimTranslations.some((c) => c[locale] === undefined)) return true;
    return labelTranslations.some((l) => l[locale] === undefined);
  });

  return { translations, claimTranslations, labelTranslations, missingLocales };
}
