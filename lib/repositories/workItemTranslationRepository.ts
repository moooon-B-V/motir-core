import { randomUUID } from 'node:crypto';
import type { Prisma, WorkItemTranslation } from '@/generated/prisma/client';

/** One kept translation to store — the row minus what the database fills in. */
export interface WorkItemTranslationInsert {
  organizationId: string;
  workspaceId: string;
  workItemId: string;
  fieldRef: string;
  sourceHash: string;
  targetLanguage: string;
  translatedText: string;
}

// Kept-translation repository — single operations on `work_item_translation`
// (Story MOTIR-7735 · Subtask MOTIR-8114). The persistence leaf under
// `workItemTranslationStoreService`, which owns the transaction, the tenancy
// resolution, the hashing and the empty-text refusal.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included. The table carries ONE
// policy — `work_item_translation_active_workspace`, gating on
// `app.workspace_id` — and no public or system arm, so an UNBOUND read returns
// nothing and raises nothing: a kept translation would silently read as
// "never translated" and be paid for again. The binding is a type error here
// rather than a convention (`workItemTodoRepository`'s reasoning).

export const workItemTranslationRepository = {
  /**
   * The rows still CURRENT for one work item in one language: those whose
   * `(fieldRef, sourceHash)` pair is in `hashesByFieldRef`. A row for older text
   * carries another hash and is never returned — staleness is a property of
   * this lookup, not of any job.
   */
  async findCurrent(
    workItemId: string,
    targetLanguage: string,
    hashesByFieldRef: ReadonlyMap<string, string>,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTranslation[]> {
    if (hashesByFieldRef.size === 0) return [];
    return tx.workItemTranslation.findMany({
      where: {
        workItemId,
        targetLanguage,
        OR: [...hashesByFieldRef].map(([fieldRef, sourceHash]) => ({ fieldRef, sourceHash })),
      },
    });
  },

  /**
   * Store one kept translation, or — when a row already holds the key
   * `(workItemId, fieldRef, sourceHash, targetLanguage)` — leave that row as it
   * is. Either way the WINNING row comes back, so two writers racing on one key
   * leave exactly one row and both read its text.
   *
   * One statement. The conflict arm is a no-op `DO UPDATE` rather than
   * `DO NOTHING` because `DO NOTHING … RETURNING` returns no row to the loser,
   * and a follow-up read would be a second operation. The no-op keeps the first
   * writer's `translated_text`; it only takes the row lock that makes the
   * loser's statement wait for the winner's commit and then return its row.
   */
  async insertIfAbsent(
    row: WorkItemTranslationInsert,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTranslation> {
    const rows = await tx.$queryRaw<WorkItemTranslation[]>`
      INSERT INTO "work_item_translation"
        ("id", "organization_id", "workspace_id", "work_item_id", "field_ref",
         "source_hash", "target_language", "translated_text", "created_at")
      VALUES
        (${randomUUID()}, ${row.organizationId}, ${row.workspaceId}, ${row.workItemId},
         ${row.fieldRef}, ${row.sourceHash}, ${row.targetLanguage}, ${row.translatedText}, NOW())
      ON CONFLICT ("work_item_id", "field_ref", "source_hash", "target_language")
      DO UPDATE SET "translated_text" = "work_item_translation"."translated_text"
      RETURNING
        "id", "organization_id" AS "organizationId", "workspace_id" AS "workspaceId",
        "work_item_id" AS "workItemId", "field_ref" AS "fieldRef",
        "source_hash" AS "sourceHash", "target_language" AS "targetLanguage",
        "translated_text" AS "translatedText", "created_at" AS "createdAt"`;
    return rows[0]!;
  },

  /**
   * Remove one field's kept translations in one language for every revision but
   * `keepHash` — the rows a fresh translation of the same field supersedes.
   * Other fields and other languages are untouched.
   */
  /**
   * Bound how long the NEXT lock wait in this transaction may block, in ms
   * (`SET LOCAL lock_timeout`). A wait past it raises `55P03` and aborts the
   * transaction, which `translationSingleFlight` reads as a timed-out wait.
   * Transaction-local: it ends with the transaction that set it.
   */
  async setLockTimeout(ms: number, tx: Prisma.TransactionClient): Promise<void> {
    const value = `${Math.max(1, Math.ceil(ms))}ms`;
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${value}, true)`;
  },

  /**
   * Take the TRANSACTION-scoped advisory lock for one single-flight key (Subtask
   * MOTIR-8120) — blocking while another transaction holds it, released when this
   * one commits or rolls back. The key is already a digest of the field, its
   * revision and the target language (`translationSingleFlight.fieldLockKey`).
   */
  async lockField(key: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-item-translation:${key}`}, 0))`;
  },

  async deleteSuperseded(
    workItemId: string,
    fieldRef: string,
    targetLanguage: string,
    keepHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.workItemTranslation.deleteMany({
      where: { workItemId, fieldRef, targetLanguage, sourceHash: { not: keepHash } },
    });
    return r.count;
  },
};
