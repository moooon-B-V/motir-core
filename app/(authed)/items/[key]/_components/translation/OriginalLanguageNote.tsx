'use client';

import { useLocale, useTranslations } from 'next-intl';
import { languageDisplayName } from './TranslationProvider';

// THE EDITORS' ORIGINAL-LANGUAGE NOTE (Story MOTIR-7738 · MOTIR-8832; design
// MOTIR-8837 § *The four cases, and their copy*). An editor always opens the
// STORED text — never the translation — and this line says which language that
// text is recorded in, so a reader whose page shows a translation is not
// surprised by what they are about to change.
//
//   recorded            → "Original in Korean"  (also when it is the reader's own)
//   not recorded (NULL) → "Original language not recorded" — never guessed
//   no text at all      → no note: nothing to edit, so nothing to name
//
// The language is named in the reader's INTERFACE language by the platform's
// display-name lookup. It is an interface string: never translated by the lane,
// never billed.

/** The note's text, or `null` where there is nothing to name (an empty field). */
export function useOriginalLanguageNote(
  language: string | null | undefined,
  hasText: boolean,
): string | null {
  const t = useTranslations('itemTranslation');
  const uiLocale = useLocale();
  if (!hasText) return null;
  return language
    ? t('originalIn', { language: languageDisplayName(language, uiLocale) })
    : t('originalNotRecorded');
}

/**
 * The note as a label accessory, introduced by an em dash exactly as the
 * Explanation's gloss is (`--el-text-secondary`, `font-normal` — AA on the
 * surface the label sits on). Renders nothing for an empty field.
 */
export function OriginalLanguageAccessory({
  language,
  hasText,
}: {
  language: string | null | undefined;
  hasText: boolean;
}) {
  const note = useOriginalLanguageNote(language, hasText);
  if (!note) return null;
  return (
    <span className="text-(--el-text-secondary) font-normal" data-original-language-note>
      — {note}
    </span>
  );
}
