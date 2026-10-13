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
