// DTOs for OAuth connections (Story MOTIR-6973 · Subtask MOTIR-6983) — what the
// Connected apps list (MOTIR-6986) and the consent page (MOTIR-6985) receive.
// A connection is an `api_token` row, but it has no secret, so there is no
// prefix here and never a hash.

import type { PermissionKey } from '@/lib/permissions/catalog';

/** One app a person has connected, as Settings → Account → Connected apps lists it. */
export interface OAuthConnectionDto {
  id: string;
  /** The registered client, as it named itself at registration. */
  client: { clientId: string; name: string | null; uri: string | null; icon: string | null };
  workspace: { id: string; name: string };
  organization: { id: string; name: string };
  /** The ONE project it acts in, or null for every project the person can open. */
  project: { id: string; name: string } | null;
  /** The resolved grant — the same expansion a PAT's list row shows. */
  permissions: PermissionKey[];
  createdAt: string;
  /** Null = the app has not called the MCP since it connected. */
  lastUsedAt: string | null;
}

/** What approving consent returns: the connection, and where the browser goes
 * next — the client's redirect, carrying the authorization code. */
export interface ApproveConsentResult {
  connectionId: string;
  redirectUrl: string;
}
