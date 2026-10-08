// Kept apart from `messages.ts` so `i18n/request.ts` can use the merge without
// statically importing every catalogue: the request config loads only the
// request's own catalogue (code-split) plus `en.json` as the base.

export type Messages = Record<string, unknown>;

function isPlainObject(value: unknown): value is Messages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A locale's catalogue (`messages`) laid over English (`base`, `en.json`) —
 * Story MOTIR-7730 · MOTIR-7757. A key the locale lacks keeps its English
 * value, so an untranslated string renders in English and never as its raw
 * key path.
 *
 * A pure recursive merge: the locale's value wins
 * wherever it is present (a string leaf, or an object recursed into). Neither
 * input is mutated.
 *
 * It is a MERGE rather than next-intl's `getMessageFallback` callback because a
 * callback configured in `i18n/request.ts` cannot cross the server/client
 * boundary to `NextIntlClientProvider`, while a merged message object can.
 */
export function withEnglishFallback(messages: Messages, base: Messages): Messages {
  const merged: Messages = {};
  for (const [key, baseValue] of Object.entries(base)) {
    merged[key] =
      key in messages
        ? isPlainObject(baseValue) && isPlainObject(messages[key])
          ? withEnglishFallback(messages[key] as Messages, baseValue)
          : messages[key]
        : baseValue;
  }
  for (const [key, value] of Object.entries(messages)) {
    if (!(key in base)) merged[key] = value;
  }
  return merged;
}
