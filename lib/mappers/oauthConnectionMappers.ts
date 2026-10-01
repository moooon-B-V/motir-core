import type { OAuthConnectionWithClient } from '@/lib/repositories/apiTokenRepository';
import type { OAuthConnectionDto } from '@/lib/dto/oauthConnections';
import { expandStoredGrant } from '@/lib/tokens/grant';
import { isLoopbackHostname } from '@/lib/oauth/redirectPolicy';
import { discoveredClientHost } from '@/lib/oauth/discoveredClient';

// Prisma → DTO for OAuth connections (Story MOTIR-6973 · Subtask MOTIR-6983). The
// row is an `api_token`; the hash and prefix are never copied, because a
// connection has no secret a person could recognise. The grant is EXPANDED, as
// `toApiTokenDto` does, so a consumer never sees the raw column.

export function toOAuthConnectionDto(row: OAuthConnectionWithClient): OAuthConnectionDto {
  return {
    id: row.id,
    client: {
      clientId: row.oauthClient?.clientId ?? row.oauthClientId ?? '',
      name: row.oauthClient?.name ?? null,
      uri: row.oauthClient?.uri ?? null,
      icon: row.oauthClient?.icon ?? null,
      // A client no Motir user registered is one that registered ITSELF
      // (dynamic registration) — the Unverified label the consent screen shows.
      unverified: (row.oauthClient?.userId ?? null) === null,
      host: redirectHost(row.oauthClient?.redirectUris ?? []),
      discoveredHost: row.oauthClient ? discoveredClientHost(row.oauthClient) : null,
    },
    workspace: { id: row.workspace.id, name: row.workspace.name },
    organization: { id: row.workspace.organization.id, name: row.workspace.organization.name },
    project: row.project ? { id: row.project.id, name: row.project.name } : null,
    permissions: expandStoredGrant(row.scopes, { projectId: row.projectId }).grant,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** The host a connection's tokens go to — its first registered redirect URI's,
 * with a loopback address read as `localhost` (the consent screen's wording). */
function redirectHost(redirectUris: string[]): string | null {
  const first = redirectUris[0];
  if (!first) return null;
  try {
    const url = new URL(first);
    if (isLoopbackHostname(url.hostname)) return 'localhost';
    return url.host || null;
  } catch {
    return null;
  }
}
