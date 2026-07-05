import { getTranslations } from 'next-intl/server';
import { createTranslator } from 'next-intl';
import { getMessagesFor } from './messages';
import { defaultLocale } from './locales';

// A translator bound to the `github` namespace that works in BOTH a request
// (real locale, via next-intl's getTranslations) AND outside one — the same
// dual-mode shape as `getErrorsTranslator`. The explicit item→PR link Server
// Action (MOTIR-1596) resolves its typed-error messages (`development.notConnected`
// / `development.prNotFound`) through this; a direct unit call (no Next request
// scope, where getTranslations throws) falls back to a synchronous translator
// pinned to the base locale so the strings stay byte-identical in tests.
type GithubTranslator = (key: string, values?: Record<string, string | number>) => string;

export async function getGithubTranslator(): Promise<GithubTranslator> {
  try {
    return (await getTranslations('github')) as unknown as GithubTranslator;
  } catch {
    return createTranslator({
      locale: defaultLocale,
      messages: getMessagesFor(defaultLocale),
      namespace: 'github',
    }) as unknown as GithubTranslator;
  }
}
