import { CliError } from './errors.js';
import { findLink } from './config/linkConfig.js';
import { listServers, normalizeServerUrl } from './config/userConfig.js';

// Resolve WHICH server a non-login command targets, in priority order:
//   1. an explicit `--server` flag,
//   2. the linked project's `.motir.json` serverUrl (walked up from cwd),
//   3. the single configured server, if exactly one token is stored.
// Zero or many stored servers with no link and no flag is ambiguous → error
// with guidance. (`auth login` does NOT use this — it's establishing a new
// server, so it takes the URL directly.)
export function resolveServerUrl(explicit?: string): string {
  if (explicit) return normalizeServerUrl(explicit);

  const link = findLink();
  if (link) return normalizeServerUrl(link.config.serverUrl);

  const servers = listServers();
  if (servers.length === 1) return servers[0] as string;
  if (servers.length === 0) {
    throw new CliError('No Motir server configured.', { hint: 'Run `motir auth login` first.' });
  }
  throw new CliError('Multiple servers are configured; pass --server <url> to choose one.', {
    hint: `Configured: ${servers.join(', ')}`,
  });
}
