import type { Locale } from '@/lib/i18n/locales';

// The `translate` job's two halves as motir-core states them (Story MOTIR-7735 ·
// Subtask MOTIR-8119) — the request a reader's Translate press sends, and the
// four outcomes the door branches on. PURE: no I/O, no client import, so the
// parser is testable on its own and the door can import the types freely.
//
// ⚠️ THE ANSWER IS RE-VALIDATED HERE, for the reason `parseAuthoredBug` gives
// (lib/ai/authoredBug.ts): motir-ai validates before returning, and that is a
// fact about motir-ai's build, not about this process's input. A version skew or
// a bug on the far side arrives looking exactly like a good answer, so the
// parser PARSES and never casts — and one bad entry refuses the whole reply,
// because a reader shown a half-translated item is told something false.

/** One field text sent for translation, keyed by the caller's own reference. */
export interface TranslateField {
  /** The caller's stable reference for the field (e.g. `description`). */
  fieldRef: string;
  text: string;
}

/** The `context.translate` unit a `translate` job carries. */
export interface TranslateJobInput {
  targetLanguage: Locale;
  fields: TranslateField[];
}

/** One translated text, keyed by the `fieldRef` it was sent under. */
export interface TranslatedField {
  fieldRef: string;
  text: string;
}

/** Why a translation attempt failed — a short machine reason, never upstream text. */
export type TranslateFailureReason =
  | 'invalid_reply'
  | 'job_failed'
  | 'unavailable'
  | 'rejected'
  | 'misconfigured'
  | 'disabled';

/** The ONE result `requestTranslation` returns — never a raw status or a throw. */
export type TranslateResult =
  | { status: 'ok'; translations: TranslatedField[] }
  | { status: 'no_credit' }
  | { status: 'failed'; reason: TranslateFailureReason }
  | { status: 'timeout' };

/** The reply could not be read as one non-empty text per field sent. */
export class InvalidTranslationsError extends Error {
  readonly code = 'INVALID_TRANSLATIONS' as const;
  constructor(readonly detail: string) {
    super(`invalid translations: ${detail}`);
    this.name = 'InvalidTranslationsError';
  }
}

/** Read one reply entry as a `{ fieldRef, text }` with a non-empty text, or throw. */
function readEntry(entry: unknown, index: number): TranslatedField {
  if (typeof entry !== 'object' || entry === null) {
    throw new InvalidTranslationsError(`entry ${index} is not an object`);
  }
  const { fieldRef, text } = entry as Record<string, unknown>;
  if (typeof fieldRef !== 'string' || fieldRef === '') {
    throw new InvalidTranslationsError(`entry ${index} has no fieldRef`);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new InvalidTranslationsError(`entry ${index} (${fieldRef}) has no text`);
  }
  return { fieldRef, text };
}

/**
 * Parse a `translate` job's `result.translations` against the fields SENT:
 * exactly one non-empty text per `fieldRef`, none extra, none missing, none
 * duplicated. Returns them in the order sent; throws
 * {@link InvalidTranslationsError} on anything else.
 */
export function parseTranslations(
  raw: unknown,
  sent: readonly { fieldRef: string }[],
): TranslatedField[] {
  if (!Array.isArray(raw)) throw new InvalidTranslationsError('not an array');
  const expected = new Set(sent.map((f) => f.fieldRef));
  const byRef = new Map<string, TranslatedField>();
  raw.forEach((entry, index) => {
    const field = readEntry(entry, index);
    if (!expected.has(field.fieldRef)) {
      throw new InvalidTranslationsError(`unexpected fieldRef ${field.fieldRef}`);
    }
    if (byRef.has(field.fieldRef)) {
      throw new InvalidTranslationsError(`duplicate fieldRef ${field.fieldRef}`);
    }
    byRef.set(field.fieldRef, field);
  });
  return sent.map(({ fieldRef }) => {
    const field = byRef.get(fieldRef);
    if (!field) throw new InvalidTranslationsError(`missing fieldRef ${fieldRef}`);
    return field;
  });
}
