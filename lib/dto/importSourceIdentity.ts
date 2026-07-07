import type { ImportSource } from '@prisma/client';

// DTOs for the import-source OAuth identity store (Story 7.16 · MOTIR-1653).
// Two shapes cross two very different boundaries:
//   • ImportSourceIdentityDTO — the token-FREE presence shape a UI can render
//     (which sources a member has connected). Like the GitHub identity DTO, it
//     structurally omits the tokens: they never leave the service layer.
//   • ImportSourceLiveToken — the DECRYPTED token bundle the fetch-and-decrypt
//     read returns. This is server-to-server ONLY (the OAuth refresh flow + the
//     connectors call the vendor with it); it MUST NOT be serialised to a client.

/**
 * Per-connection vendor context stored alongside the tokens (the `metadata` Json
 * column). Every field is optional — it is source-specific:
 *   • Jira (3LO): `cloudId` + `siteUrl` (the accessible-resource the token maps to).
 *   • Plane (self-hosted): `baseUrl` + `workspaceSlug`.
 * Carries NO secret — the tokens live in the encrypted columns.
 */
export interface ImportSourceIdentityMetadata {
  /** Jira Cloud id (the `id` from the accessible-resources response). */
  cloudId?: string;
  /** Jira site base URL (e.g. `https://acme.atlassian.net`). */
  siteUrl?: string;
  /** Plane instance base URL (self-hosted deployments). */
  baseUrl?: string;
  /** Plane workspace slug. */
  workspaceSlug?: string;
}

/** Token-free presence shape — safe to serialise to a client. */
export interface ImportSourceIdentityDTO {
  id: string;
  source: ImportSource;
  metadata: ImportSourceIdentityMetadata | null;
  /** When the access token expires (ISO-8601), or null for a non-expiring token. */
  expiresAt: string | null;
  createdAt: string;
}

/**
 * The decrypted live token bundle — SERVER-SIDE ONLY. Returned by the
 * fetch-and-decrypt read so a connector / refresh flow can call the vendor.
 * Never place this on an API response.
 */
export interface ImportSourceLiveToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  metadata: ImportSourceIdentityMetadata | null;
}
