/**
 * Typed errors for the idea store (Story MOTIR-7662) — the `CLAUDE.md`
 * domain-`errors.ts` convention. The services throw these; the routes map them
 * to a status in one helper (`app/api/platform/ideas/_errors.ts`,
 * `app/api/public/ideas/_errors.ts`).
 *
 * Every one of these is raised AFTER the platform gate has admitted the caller
 * (or on a public read of active content), so — unlike `NotPlatformStaffError`
 * — they may name the slugs involved: there is nothing left to leak.
 */

/** One or more slugs are already in the store, or repeat inside one batch. */
export class IdeaSlugTakenError extends Error {
  readonly code = 'IDEA_SLUG_TAKEN';

  constructor(readonly slugs: string[]) {
    super(`Idea slug(s) already taken: ${slugs.join(', ')}`);
    this.name = 'IdeaSlugTakenError';
  }
}

/** No idea has this slug (or, on a public read, no ACTIVE idea has it). */
export class IdeaNotFoundError extends Error {
  readonly code = 'IDEA_NOT_FOUND';

  constructor(readonly slug: string) {
    super(`No idea with slug "${slug}"`);
    this.name = 'IdeaNotFoundError';
  }
}

/** A retire reached an idea that is already retired. */
export class IdeaNotActiveError extends Error {
  readonly code = 'IDEA_NOT_ACTIVE';

  constructor(readonly slug: string) {
    super(`The idea "${slug}" is not active`);
    this.name = 'IdeaNotActiveError';
  }
}

/** A tag slug is already in the vocabulary. */
export class IdeaTagTakenError extends Error {
  readonly code = 'IDEA_TAG_TAKEN';

  constructor(readonly slug: string) {
    super(`The tag "${slug}" already exists`);
    this.name = 'IdeaTagTakenError';
  }
}

/** A write named tags the vocabulary does not hold. */
export class UnknownIdeaTagError extends Error {
  readonly code = 'UNKNOWN_TAG';

  constructor(readonly tags: string[]) {
    super(`Unknown tag(s): ${tags.join(', ')}`);
    this.name = 'UnknownIdeaTagError';
  }
}

/** A tag slug the vocabulary does not hold, on a route that names one tag. */
export class IdeaTagNotFoundError extends Error {
  readonly code = 'IDEA_TAG_NOT_FOUND';

  constructor(readonly slug: string) {
    super(`No tag with slug "${slug}"`);
    this.name = 'IdeaTagNotFoundError';
  }
}

/**
 * A translation named a locale outside the ten (`en` included — English lives
 * on the idea itself). Story MOTIR-7772 · MOTIR-7774.
 */
export class IdeaUnsupportedLocaleError extends Error {
  readonly code = 'UNSUPPORTED_LOCALE';

  constructor(readonly locales: string[]) {
    super(`Unsupported translation locale(s): ${locales.join(', ')}`);
    this.name = 'IdeaUnsupportedLocaleError';
  }
}

/** A translated `capabilities` list whose length differs from the English list. */
export class IdeaTranslationShapeError extends Error {
  readonly code = 'TRANSLATION_SHAPE_MISMATCH';

  /** Each entry is `<locale>.capabilities`. */
  constructor(readonly fields: string[]) {
    super(`Translated list length differs from the English: ${fields.join(', ')}`);
    this.name = 'IdeaTranslationShapeError';
  }
}

/** A translation of a field whose English is empty after the write. */
export class IdeaTranslationWithoutEnglishError extends Error {
  readonly code = 'TRANSLATION_WITHOUT_ENGLISH';

  /** Each entry is `<locale>.<field>`. */
  constructor(readonly fields: string[]) {
    super(`Translation of a field with no English: ${fields.join(', ')}`);
    this.name = 'IdeaTranslationWithoutEnglishError';
  }
}

/**
 * A translation write's `expectedUpdatedAt` is not the idea's `updatedAt`: the
 * English changed since the translations were made. Re-read, re-translate, retry.
 */
export class IdeaChangedError extends Error {
  readonly code = 'IDEA_CHANGED';

  constructor(
    readonly slug: string,
    readonly updatedAt: string,
  ) {
    super(`The idea "${slug}" changed since it was read (now ${updatedAt})`);
    this.name = 'IdeaChangedError';
  }
}

/** One problem with one field of one idea (or tag, or run). */
export interface IdeaValidationIssue {
  /** The slug the problem belongs to, when there is one. */
  slug: string | null;
  field: string;
  message: string;
}

/** A write's input failed the service's own rules. Names every problem. */
export class InvalidIdeaInputError extends Error {
  readonly code = 'INVALID_IDEA_INPUT';

  constructor(readonly issues: IdeaValidationIssue[]) {
    super(
      `Invalid idea input: ${issues.map((i) => `${i.slug ?? '-'}.${i.field}: ${i.message}`).join('; ')}`,
    );
    this.name = 'InvalidIdeaInputError';
  }
}

/** A public filter named a category or kind outside the closed set. */
export class InvalidIdeaFilterError extends Error {
  readonly code = 'INVALID_IDEA_FILTER';

  constructor(readonly field: 'category' | 'kind') {
    super(`Unknown idea ${field}`);
    this.name = 'InvalidIdeaFilterError';
  }
}

/**
 * The public list reached its row cap. Thrown instead of truncating, so the day
 * the curated store outgrows an unpaginated read it says so (MOTIR-7672).
 */
export class IdeaListCapExceededError extends Error {
  readonly code = 'IDEA_LIST_CAP_EXCEEDED';

  constructor(readonly cap: number) {
    super(`The public idea list reached its cap of ${cap} rows; pagination is now owed`);
    this.name = 'IdeaListCapExceededError';
  }
}
