// ── The language each proposed text field was WRITTEN in ─────────────────────
// (Story MOTIR-7734 · MOTIR-8743.)
//
// A planner that writes a proposal says, per text field, which language it wrote
// it in (`ProposalLanguages`). That statement is FIXED AT GENERATION: approve
// records it on the created or modified row, and reads the organisation's
// content-language setting only for a field whose proposal names no language. So
// a plan generated in `en` and approved after the setting moved to `ja` still
// records `en`, which is the only true answer.
//
// This module is the plan path's ONE rule for the statement, the
// `validateProposedDifficulty` shape: the append, the deepen and the correction
// validate it here, the `add` merge and the `modify` merge fold it here, and both
// approval paths read it here. PURE: no DB, no `tx`. A malformed statement is an
// `InvalidProposalError` (a 422 `INVALID_PROPOSAL` on the internal door), refused
// where it is written rather than discovered at approve.

import type { ProposalLanguages } from '@/lib/dto/plans';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { InvalidProposalError } from '@/lib/plans/errors';

/** Each language key, and the proposal field whose text it describes. */
const LANGUAGE_FIELDS = {
  title: 'title',
  description: 'descriptionMd',
  explanation: 'explanationMd',
  todos: 'todos',
} as const satisfies Record<keyof ProposalLanguages, string>;

type LanguageKey = keyof typeof LANGUAGE_FIELDS;
const LANGUAGE_KEYS = Object.keys(LANGUAGE_FIELDS) as LanguageKey[];

/**
 * Validate a `languages` statement as it arrived. `undefined` passes (no
 * statement); anything else must be an object whose every key is one of the four
 * and whose every value is one of the eleven locales.
 */
export function validateProposedLanguages(
  languages: unknown,
  label: string,
): ProposalLanguages | undefined {
  if (languages === undefined) return undefined;
  if (typeof languages !== 'object' || languages === null || Array.isArray(languages)) {
    throw new InvalidProposalError(
      `${label}: \`languages\` must be an object naming, per text field, the language it was written in.`,
    );
  }
  for (const [key, value] of Object.entries(languages)) {
    if (!(LANGUAGE_KEYS as string[]).includes(key)) {
      throw new InvalidProposalError(
        `${label}: \`languages.${key}\` is not a text field. A proposal's languages may name only ` +
          `${LANGUAGE_KEYS.map((k) => `\`${k}\``).join(', ')}.`,
      );
    }
    if (typeof value !== 'string' || !isLocale(value)) {
      throw new InvalidProposalError(
        `${label}: \`languages.${key}\` is ${JSON.stringify(value)}, which is not a supported language.`,
      );
    }
  }
  return languages as ProposalLanguages;
}

/**
 * Fold an incoming statement over the one a proposal already holds, PER KEY:
 * a key the incoming statement names replaces that key, and a field the change
 * rewrites WITHOUT naming its language drops that field's key. So a person's edit
 * in the plan review, or a planner that writes text without a statement, cannot
 * leave behind a claim about text that is no longer there. `undefined` when the
 * result is empty.
 */
export function mergeProposalLanguages(
  current: ProposalLanguages | undefined,
  change: object,
  incoming: ProposalLanguages | undefined,
): ProposalLanguages | undefined {
  const next: ProposalLanguages = { ...(current ?? {}) };
  for (const key of LANGUAGE_KEYS) {
    if (incoming?.[key] !== undefined) next[key] = incoming[key];
    else if ((change as Record<string, unknown>)[LANGUAGE_FIELDS[key]] !== undefined) {
      delete next[key];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The language a field's text records at approve: the proposal's, else the org's. */
export function languageFor(
  languages: ProposalLanguages | null | undefined,
  key: LanguageKey,
  orgLanguage: Locale,
): Locale {
  return languages?.[key] ?? orgLanguage;
}
