import type { Locale } from '@/lib/i18n/locales';
import { hashFieldText } from '@/lib/translation/fieldRevision';
import { classifyFields, sourceLanguageOf } from '@/lib/translation/needsTranslation';

// Per-TITLE classification over a bounded set of work items (Story MOTIR-7738 ·
// MOTIR-8828). The shipped offer is keyed by `fieldRef` and expresses one item's
// fields; this is keyed by work item id and expresses N titles. Pure: no store
// read, no model call, no database — it only says what is DUE.

export interface TitleCandidate {
  id: string;
  title: string;
  /** The title's recorded content language, or `null` when none was recorded. */
  language: string | null;
}

export interface TitleVerdict {
  id: string;
  needsTranslation: boolean;
  /** The language a differing title is in; `null` when it needs nothing or is unknown. */
  sourceLanguage: Locale | null;
  /** The store's own revision hash over this title text. */
  revision: string;
}

/** One verdict per candidate, keyed by id — total over the set handed in. */
export function classifyTitles(
  candidates: readonly TitleCandidate[],
  readerLocale: Locale,
): Record<string, TitleVerdict> {
  const verdicts = classifyFields(
    candidates.map((c) => ({ id: c.id, text: c.title, language: c.language })),
    readerLocale,
  );
  const out: Record<string, TitleVerdict> = {};
  candidates.forEach((c, i) => {
    const verdict = verdicts[i]!;
    out[c.id] = {
      id: c.id,
      needsTranslation: verdict.needsTranslation,
      sourceLanguage: verdict.needsTranslation
        ? sourceLanguageOf({ text: c.title, language: c.language }, verdict)
        : null,
      revision: hashFieldText(c.title),
    };
  });
  return out;
}
