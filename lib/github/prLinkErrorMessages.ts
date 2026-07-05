import { GithubNotConnectedError, GithubPullRequestNotFoundError } from '@/lib/github/errors';

// Maps the explicit item→PR link's typed errors (MOTIR-1596) to a
// `github.development.*` catalog key, resolved by the passed-in translator
// (bound to the `github` namespace). Mirrors `linkErrorMessages.ts` for the
// issue-link surface: the service throws the typed error; the Server Action
// turns it into the inline message the picker's rose banner shows. Returns null
// when `err` isn't one of these (the caller rethrows — a genuine 500), so a
// forged current-item id or an unexpected fault is never swallowed as a link
// message.
type GithubTranslator = (key: string, values?: Record<string, string | number>) => string;

export function prLinkErrorMessage(err: unknown, t: GithubTranslator): string | null {
  if (err instanceof GithubNotConnectedError) return t('development.notConnected');
  if (err instanceof GithubPullRequestNotFoundError) return t('development.prNotFound');
  return null;
}
