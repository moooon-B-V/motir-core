import { DEFAULT_SERVER_URL } from './commandCatalog.js';
import { CliError } from './errors.js';
import { findLink } from './config/linkConfig.js';
import { envServerUrl, listServers, normalizeServerUrl } from './config/userConfig.js';

/**
 * The hosted Motir instance — the LAST rung of the ladder below, and the value
 * `motir auth login` offers when it prompts for a server.
 *
 * DECLARED in `commandCatalog.ts` and re-exported here, so this module stays
 * where every caller already looks for it while the value itself lives in a
 * module a Next build can read: `/docs/cli` states the default server, and this
 * file imports both config modules, so the constant had to move rather than be
 * imported where it stood (ADR `docs/decisions/public-api-conventions.md`
 * Amendment 12 Q2). One home, two spellings of the same export — never a copy.
 */
export { DEFAULT_SERVER_URL };

// Resolve WHICH server a command targets, in priority order:
//   1. an explicit `--server` flag,
//   2. `MOTIR_SERVER`,
//   3. the linked project's `.motir.json` serverUrl (walked up from cwd),
//   4. the single configured server, if exactly one token is stored,
//   5. `DEFAULT_SERVER_URL`.
//
// The ladder is ordered most-explicit-first: a flag is scoped to one command, an
// env var to one shell, the link to one directory tree, the store to one
// machine. `MOTIR_SERVER` sits ABOVE the link because a container (or a CI
// runner) has no link to walk up to — env vars are the whole configuration
// surface it has — and the default sits BELOW everything so it can never
// override an intent someone actually expressed.
//
// Several stored servers with no flag, no env, and no link stays AMBIGUOUS
// rather than falling through to the default: logging in to two servers IS an
// expressed intent, and silently picking a third host neither of them names
// would be the "override an explicit intent" the ordering exists to prevent.
// The one exception is when the default host is itself one of them — then it is
// not a guess, it is the same canonical-host default `gh` applies with several
// hosts configured.
export function resolveServerUrl(explicit?: string): string {
  if (explicit) return normalizeServerUrl(explicit);

  const fromEnv = envServerUrl();
  if (fromEnv) return fromEnv;

  const link = findLink();
  if (link) return normalizeServerUrl(link.config.serverUrl);

  const servers = listServers();
  if (servers.length === 1) return servers[0] as string;
  if (servers.length === 0) return DEFAULT_SERVER_URL;
  // EXACT equality against each stored key, never a substring match on a URL:
  // both sides are already normalized (`setCredential` keys by
  // `normalizeServerUrl`), so `https://app.motir.co.evil.test` can never satisfy
  // this. Spelled as an explicit `===` predicate rather than `servers.includes(…)`
  // so neither a reader nor a scanner has to infer which `includes` this is.
  if (servers.some((stored) => stored === DEFAULT_SERVER_URL)) return DEFAULT_SERVER_URL;
  throw new CliError('Multiple servers are configured; pass --server <url> to choose one.', {
    hint: `Configured: ${servers.join(', ')}`,
  });
}
