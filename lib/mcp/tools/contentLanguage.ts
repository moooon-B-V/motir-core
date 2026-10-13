import { z } from 'zod';
import { locales, type Locale } from '@/lib/i18n/locales';

// The language inputs every MCP work-text writer shares (Story MOTIR-7731 ·
// MOTIR-8098): `language` for every text field the call writes, `languages` per
// field, winning over `language`. The service owns the default (the
// organisation's content language) and the validation; a tool only forwards
// what its caller supplied.

const languageEnum = z.enum(locales);

export const languageInput = languageEnum
  .optional()
  .describe(
    `Optional: the language every text field this call writes is in — one of ${locales.join(', ')}. ` +
      "Omit it to record the organisation's content language.",
  );

/** The per-field `languages` input for the named text fields. */
export function languagesInput<const F extends string>(fields: readonly F[]) {
  const shape = Object.fromEntries(fields.map((f) => [f, languageEnum.optional()])) as {
    [K in F]: z.ZodOptional<typeof languageEnum>;
  };
  return z
    .object(shape)
    .optional()
    .describe(
      `Optional: the language of each text field this call writes (${fields.join(', ')}), ` +
        'winning over `language` for that field.',
    );
}

/** Forward `language` / `languages` into a service input only when supplied. */
export function languageArgs<F extends string>(args: {
  language?: Locale;
  languages?: Partial<Record<F, Locale>>;
}): { language?: Locale; languages?: Partial<Record<F, Locale>> } {
  return {
    ...(args.language !== undefined ? { language: args.language } : {}),
    ...(args.languages !== undefined ? { languages: args.languages } : {}),
  };
}
