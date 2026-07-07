import type { ImportSource, Prisma } from '@prisma/client';
import { withUserContext } from '@/lib/workspaces/context';
import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';
import { importSourceIdentityRepository } from '@/lib/repositories/importSourceIdentityRepository';
import { toImportSourceIdentityDTO } from '@/lib/mappers/importSourceIdentityMappers';
import type {
  ImportSourceIdentityDTO,
  ImportSourceIdentityMetadata,
  ImportSourceLiveToken,
} from '@/lib/dto/importSourceIdentity';

// Import-source OAuth identity service (Story 7.16 · MOTIR-1653) — the "Model A"
// substrate the per-vendor connect flows (7.16.11–13) and the import routes
// (MOTIR-941) read/write through so the live connectors authenticate with a
// STORED, encrypted token instead of a pasted credential. Owns token
// encryption/decryption, the `withUserContext` transaction that binds the
// identity to the acting member (RLS keys on `app.user_id`), and DTO mapping.
// Mirrors githubIdentityService. No routes here — 4-layer.
//
// Encryption reuses the generic AES-256-GCM crypto keyed on
// IMPORT_TOKEN_ENCRYPTION_KEY, falling back to GITHUB_TOKEN_ENCRYPTION_KEY so an
// existing deployment (and the test env) encrypts with zero new operator config;
// set the dedicated var to isolate import tokens from the GitHub key. The key is
// resolved at call time, so a deployment that never imports doesn't need it.
const tokenCrypto = createTokenCrypto([
  'IMPORT_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);

export interface UpsertImportSourceIdentityArgs {
  userId: string;
  workspaceId: string;
  source: ImportSource;
  /** The plaintext vendor access token — encrypted before it is persisted. */
  accessToken: string;
  /** The plaintext refresh token, when the OAuth flow issues one. */
  refreshToken?: string | null;
  /** Access-token expiry, when the vendor returns one. */
  expiresAt?: Date | null;
  /** Per-connection vendor context (Jira cloud id/site, Plane base URL/slug). */
  metadata?: ImportSourceIdentityMetadata | null;
}

export interface ImportSourceIdentityLookup {
  userId: string;
  workspaceId: string;
  source: ImportSource;
}

export const importSourceIdentityService = {
  /**
   * Create-or-refresh the acting member's identity for one source: encrypt the
   * access (and refresh) token and upsert under `withUserContext`, so RLS binds
   * the row to the member. Returns the token-free DTO.
   */
  async upsertIdentity(args: UpsertImportSourceIdentityArgs): Promise<ImportSourceIdentityDTO> {
    const accessTokenEncrypted = tokenCrypto.encryptToken(args.accessToken);
    const refreshTokenEncrypted =
      args.refreshToken != null ? tokenCrypto.encryptToken(args.refreshToken) : null;

    const row = await withUserContext(args.userId, (tx) =>
      importSourceIdentityRepository.upsert(
        {
          userId: args.userId,
          workspaceId: args.workspaceId,
          source: args.source,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          expiresAt: args.expiresAt ?? null,
          // The typed metadata (optional string fields) is a JSON-safe object;
          // cast to Prisma's JSON input, which does not model optional props.
          metadata: (args.metadata ?? null) as Prisma.InputJsonValue | null,
        },
        tx,
      ),
    );

    return toImportSourceIdentityDTO(row);
  },

  /**
   * Fetch-and-decrypt the acting member's live token for one source — the
   * server-to-server read the connectors + the OAuth refresh flow use. Returns
   * null when the member hasn't connected the source. The decrypted bundle is
   * SERVER-SIDE ONLY — never serialise it to a client.
   */
  async getLiveToken(lookup: ImportSourceIdentityLookup): Promise<ImportSourceLiveToken | null> {
    const row = await withUserContext(lookup.userId, (tx) =>
      importSourceIdentityRepository.findByUserSource(
        lookup.userId,
        lookup.source,
        lookup.workspaceId,
        tx,
      ),
    );
    if (!row) return null;

    return {
      accessToken: tokenCrypto.decryptToken(row.accessTokenEncrypted),
      refreshToken: row.refreshTokenEncrypted
        ? tokenCrypto.decryptToken(row.refreshTokenEncrypted)
        : null,
      expiresAt: row.expiresAt,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as ImportSourceIdentityMetadata)
          : null,
    };
  },

  /**
   * The acting member's token-free identity for one source, or null when
   * unbound — the read a "connected sources" surface uses. A null result is a
   * valid state, NOT an error.
   */
  async getIdentity(lookup: ImportSourceIdentityLookup): Promise<ImportSourceIdentityDTO | null> {
    const row = await withUserContext(lookup.userId, (tx) =>
      importSourceIdentityRepository.findByUserSource(
        lookup.userId,
        lookup.source,
        lookup.workspaceId,
        tx,
      ),
    );
    return row ? toImportSourceIdentityDTO(row) : null;
  },

  /**
   * Disconnect the acting member's identity for one source (idempotent — a
   * no-op when already unbound). Runs under `withUserContext` so RLS narrows the
   * delete to the owner's row.
   */
  async disconnect(lookup: ImportSourceIdentityLookup): Promise<void> {
    await withUserContext(lookup.userId, (tx) =>
      importSourceIdentityRepository.deleteByUserSource(
        lookup.userId,
        lookup.source,
        lookup.workspaceId,
        tx,
      ),
    );
  },
};
