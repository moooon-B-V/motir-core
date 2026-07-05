import { type ImportedIssue, type ImportSource, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// ImportedIssue repository — single Prisma operations on the `imported_issue`
// idempotency MAP (Story 7.16 · MOTIR-939): one row per imported source issue,
// keyed on the STABLE `(project, source, externalId)` identity (the unique
// index), mapping it to the Motir work item it became. Repository name matches
// the ENTITY (`ImportedIssue` → `importedIssueRepository`), not the call site.
//
// Per CLAUDE.md: writes require `tx`; the idempotency lookup is a read that
// GUARDS the subsequent upsert, so it runs inside the import transaction and
// takes `tx` + `SELECT … FOR UPDATE`. NO business logic, NO transactions here —
// the persist engine (MOTIR-941) owns the tx, the create-vs-update decision, and
// the P2002-race translation.

export interface UpsertImportedIssueInput {
  workspaceId: string;
  projectId: string;
  source: ImportSource;
  externalId: string;
  workItemId: string;
  /** The run that wrote this mapping (provenance). Nullable — the map survives an
   *  import-run delete (SET NULL), so re-runs stay idempotent. */
  importId?: string | null;
  /** Hash of the source issue's mapped fields at this import — lets a later run
   *  detect a source-side change (re-sync) vs an unchanged issue (skip). */
  sourceHash?: string | null;
}

export const importedIssueRepository = {
  /**
   * The idempotency lookup — resolve a source issue's stable
   * `(project, source, externalId)` identity to its existing mapping row, or
   * null on a first-time import. A PURE read (no surrounding write); optional
   * `tx` joins a transaction. For the LOCKED read a concurrent import guards on,
   * use {@link lockBySourceId}.
   */
  async findBySourceId(
    projectId: string,
    source: ImportSource,
    externalId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ImportedIssue | null> {
    const client = tx ?? db;
    return client.importedIssue.findUnique({
      where: { projectId_source_externalId: { projectId, source, externalId } },
    });
  },

  /**
   * Take a row lock on the `(project, source, externalId)` mapping (if it
   * exists) so the read-derived upsert serializes against a concurrent import of
   * the SAME external id (the lock-before-read-derived-update rule). `tx`
   * REQUIRED — it must run inside the import transaction. A no-op when the row
   * does not exist yet (a first-time import); the `@@unique` + the upsert's
   * P2002 catch (MOTIR-941) still converge concurrent first inserts.
   */
  async lockBySourceId(
    projectId: string,
    source: ImportSource,
    externalId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT "id" FROM "imported_issue"
      WHERE "project_id" = ${projectId} AND "source" = ${source}::"import_source" AND "external_id" = ${externalId}
      FOR UPDATE
    `;
  },

  /**
   * Create-or-refresh the mapping row, keyed on the unique
   * `(project, source, externalId)`. On a re-run this UPDATES the existing row
   * (new provenance `importId` + `sourceHash`, and — should a work item have
   * been re-created — its `workItemId`) rather than inserting a duplicate. A
   * write, so `tx` is required.
   */
  async upsert(
    input: UpsertImportedIssueInput,
    tx: Prisma.TransactionClient,
  ): Promise<ImportedIssue> {
    const { projectId, source, externalId, workspaceId, workItemId, importId, sourceHash } = input;
    return tx.importedIssue.upsert({
      where: { projectId_source_externalId: { projectId, source, externalId } },
      create: {
        workspaceId,
        projectId,
        source,
        externalId,
        workItemId,
        importId: importId ?? null,
        sourceHash: sourceHash ?? null,
      },
      update: {
        workItemId,
        importId: importId ?? null,
        sourceHash: sourceHash ?? null,
      },
    });
  },
};
