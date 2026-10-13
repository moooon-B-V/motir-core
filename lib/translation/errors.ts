// Typed errors for the kept-translation store (Story MOTIR-7735 · Subtask
// MOTIR-8114). Services throw them with stable string `code`s; a route maps the
// code to a status.

/** A target language outside the eleven locales in `lib/i18n/locales.ts`. */
export class UnsupportedTargetLanguageError extends Error {
  readonly code = 'UNSUPPORTED_TARGET_LANGUAGE' as const;
  constructor(language: string) {
    super(`"${language}" is not a supported target language.`);
    this.name = 'UnsupportedTargetLanguageError';
  }
}

/**
 * An empty or whitespace-only source or translated text offered to the store.
 * There is nothing to translate and nothing to serve, so nothing is kept.
 */
export class EmptyTranslationTextError extends Error {
  readonly code = 'EMPTY_TRANSLATION_TEXT' as const;
  constructor(fieldRef: string) {
    super(`Field ${fieldRef} has no text to keep a translation for.`);
    this.name = 'EmptyTranslationTextError';
  }
}

/**
 * A translation press waited longer than the single-flight bound for another
 * press's field locks (Subtask MOTIR-8120). Nothing was sent: the door answers
 * `timeout` for those fields rather than paying for a second job.
 */
export class FieldLockTimeoutError extends Error {
  readonly code = 'FIELD_LOCK_TIMEOUT' as const;
  constructor(readonly keyCount: number) {
    super(`Timed out waiting for ${keyCount} translation field lock(s).`);
    this.name = 'FieldLockTimeoutError';
  }
}
