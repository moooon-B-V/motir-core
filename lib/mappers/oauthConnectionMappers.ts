import type { OAuthConnectionWithClient } from '@/lib/repositories/apiTokenRepository';
import type { OAuthConnectionDto } from '@/lib/dto/oauthConnections';
import { expandStoredGrant } from '@/lib/tokens/grant';

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
    },
    workspace: { id: row.workspace.id, name: row.workspace.name },
    organization: { id: row.workspace.organization.id, name: row.workspace.organization.name },
    project: row.project ? { id: row.project.id, name: row.project.name } : null,
    permissions: expandStoredGrant(row.scopes, { projectId: row.projectId }).grant,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
