import { Prisma, type ImportSource, type ImportSourceIdentity } from '@prisma/client';

// Import-source identity repository — single Prisma operations on the
// `import_source_identity` table (Story 7.16 · MOTIR-1653). The service
// (importSourceIdentityService) owns the OAuth orchestration, token
// encryption/decryption, the transaction, and DTO mapping; this leaf holds none
// of that. Mirrors githubIdentityRepository.
//
// Layer rules (CLAUDE.md): the writes (`upsert` / `deleteByUserSource`) REQUIRE
// `tx` — they run inside the callback's `withUserContext` transaction, so RLS
// binds the row to the acting user. `findByUserSource` guards / feeds a
// decrypt read that also runs under `withUserContext`, so it takes `tx` too
// (RLS narrows it to the owner).

/** The tokens arrive already encrypted — the repo never touches crypto. */
export interface UpsertImportSourceIdentityInput {
  userId: string;
  workspaceId: string;
  source: ImportSource;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
  /** Typed vendor context; null stores DB-NULL (see the DbNull adapter below). */
  metadata: Prisma.InputJsonValue | null;
}

/** Prisma requires an explicit sentinel to write NULL to a nullable Json column. */
function metadataWrite(
  metadata: Prisma.InputJsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return metadata ?? Prisma.DbNull;
}

export const importSourceIdentityRepository = {
  /** The acting user's identity for one source in one workspace, or null when
   *  they haven't connected it. Runs under `withUserContext`, so RLS already
   *  narrows to the owner. */
  async findByUserSource(
    userId: string,
    source: ImportSource,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ImportSourceIdentity | null> {
    return tx.importSourceIdentity.findUnique({
      where: { userId_source_workspaceId: { userId, source, workspaceId } },
    });
  },

  /** Create-or-refresh the acting user's identity for one source (re-connect
   *  updates the tokens / expiry / metadata in place, keyed on the unique
   *  `[userId, source, workspaceId]`). */
  async upsert(
    input: UpsertImportSourceIdentityInput,
    tx: Prisma.TransactionClient,
  ): Promise<ImportSourceIdentity> {
    const { userId, workspaceId, source, ...rest } = input;
    const data = {
      accessTokenEncrypted: rest.accessTokenEncrypted,
      refreshTokenEncrypted: rest.refreshTokenEncrypted,
      expiresAt: rest.expiresAt,
      metadata: metadataWrite(rest.metadata),
    };
    return tx.importSourceIdentity.upsert({
      where: { userId_source_workspaceId: { userId, source, workspaceId } },
      create: { userId, workspaceId, source, ...data },
      update: data,
    });
  },

  /** Remove the acting user's identity for one source (Disconnect). Returns the
   *  delete count (0 when already unbound — idempotent). */
  async deleteByUserSource(
    userId: string,
    source: ImportSource,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.importSourceIdentity.deleteMany({
      where: { userId, source, workspaceId },
    });
    return r.count;
  },
};
