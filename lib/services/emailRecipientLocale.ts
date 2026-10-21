import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { userRepository } from '@/lib/repositories/userRepository';

// Which language an email is written in (Story MOTIR-7732 · MOTIR-8104).
//
// An email belongs to the person who RECEIVES it, never to the person or the
// request that caused it: a Korean watcher reads a comment notice in Korean
// even when a German-speaking teammate wrote the comment. So every sender asks
// this module, at the moment it QUEUES the email, and puts the answer on the
// `email.send` payload's `data.locale` — the template renders the whole email
// in it, and a retried send renders in the same language as the first attempt.
//
// ⚠️ NOTHING HERE MAY READ THE CURRENT REQUEST. The request's language answers
// for whoever is looking at the app right now, which for an email is the wrong
// person, and the guard test (MOTIR-8110) fails any sender that falls back to
// it. A recipient Motir knows nothing about gets English, not a guess.
//
// The order, for one recipient:
//   1. A user id that names a user with a saved language → that language.
//   2. An address that belongs to an account → that account's saved language,
//      else ENGLISH. Once a person has an account, the language recorded when
//      they were address-only is no longer theirs to be read in.
//   3. No account → the language recorded when the address was given to Motir
//      (an email-only follow records the page's language), when it is one of
//      the eleven.
//   4. Otherwise English.

export interface RecipientLocaleInput {
  /** The recipient's account, when the sender knows it. */
  userId?: string | null;
  /** The recipient's address, when the sender knows it (an invite, a follow). */
  email?: string | null;
  /** The language recorded when an address-only recipient gave Motir their
   *  address. Used ONLY when no account holds that address. */
  recordedLocale?: string | null;
}

/** The language to write one recipient's email in. Never throws on a stored
 *  value that is not one of the eleven — it falls through to the next rung. */
export async function resolveRecipientLocale(input: RecipientLocaleInput): Promise<Locale> {
  if (input.userId) {
    // The saved-language read `usersService.getSavedLocale` makes, taken from
    // the repository directly: usersService is itself a sender that imports
    // this module, and going through it would close an import cycle.
    const saved = await userRepository.findLocaleById(input.userId);
    if (isLocale(saved)) return saved;
    // No saved language, or no such user. Without an address there is nothing
    // further to know about this person; with one, the address step decides
    // (and an account found there still resolves English, never the recorded
    // language — rung 2).
    if (!input.email) return defaultLocale;
  }
  if (input.email) {
    const account = await userRepository.findLocaleByEmail(input.email);
    if (account) return isLocale(account.locale) ? account.locale : defaultLocale;
  }
  return isLocale(input.recordedLocale) ? input.recordedLocale : defaultLocale;
}

/** The batch form for a fan-out sender (every watcher, every member): ONE user
 *  query however many ids. Every requested id is a key of the answer — English
 *  when the user saved nothing valid or does not exist — so a caller indexing
 *  it never reads `undefined`. */
export async function resolveRecipientLocales(userIds: string[]): Promise<Map<string, Locale>> {
  const unique = [...new Set(userIds)];
  const stored = await userRepository.findLocalesByIds(unique);
  return new Map(
    unique.map((id) => {
      const value = stored.get(id);
      return [id, isLocale(value) ? value : defaultLocale];
    }),
  );
}
