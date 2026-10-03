import type { Prisma } from '@/generated/prisma/client';
import {
  PAGE_VERSION_RECORD_SELECT,
  type PageVersionBodyRecord,
  type PageVersionRecord,
} from '@/lib/mappers/pageMappers';

// Page-version repository — single operations on `page_version` (Story
// MOTIR-5754 · MOTIR-7384). The persistence leaf under the `PageStore` adapter's
// version methods; `@motir/pages` decides when a version is extended, started
// or pruned (`versions.ts`), and the page service owns the transaction.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — `pageRepository`'s
// reasoning: `page_version` carries the workspace policy pair and no system or
// public arm, so an UNBOUND read returns nothing and raises nothing.

/** What `insert` writes — the unchecked create shape, ids rather than relations. */
export type PageVersionCreateInput = Prisma.PageVersionUncheckedCreateInput;

/** What `update` writes when a save extends a version. */
export interface PageVersionExtend {
  bodyState: Uint8Array<ArrayBuffer>;
  bodyMarkdown: string;
  savedAt: Date;
}

export const pageVersionRepository = {
  /** The newest version of a page, without its body; `null` when it has none. */
  async findLatest(
    pageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageVersionRecord | null> {
    return tx.pageVersion.findFirst({
      where: { pageId },
      orderBy: { number: 'desc' },
      select: PAGE_VERSION_RECORD_SELECT,
    });
  },

  async insert(
    data: PageVersionCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PageVersionRecord> {
    return tx.pageVersion.create({ data, select: PAGE_VERSION_RECORD_SELECT });
  },

  /** Extend one version: its snapshot and `savedAt`, nothing else. */
  async update(id: string, write: PageVersionExtend, tx: Prisma.TransactionClient): Promise<void> {
    await tx.pageVersion.update({ where: { id }, data: write, select: { id: true } });
  },

  /** Version `number` of THIS page, body included; `null` when the page has no such version. */
  async findByPageAndNumber(
    pageId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<PageVersionBodyRecord | null> {
    return tx.pageVersion.findUnique({
      where: { pageId_number: { pageId, number } },
      select: { ...PAGE_VERSION_RECORD_SELECT, bodyState: true, bodyMarkdown: true },
    });
  },

  async countByPage(pageId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.pageVersion.count({ where: { pageId } });
  },

  /**
   * Delete a page's oldest UNMARKED versions — neither sealed nor frozen — until
   * `keep` versions remain or only marked ones are left (`pages.md` AMENDMENT 3:
   * the cap counts every version and deletes only unmarked ones). ONE
   * statement, under the page's lock. A restore row whose source goes is kept:
   * the FK sets its `restored_from_version_id` to NULL and `restored_from_number`
   * stays.
   */
  async deleteOldestUnmarked(
    pageId: string,
    keep: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "page_version"
       WHERE "id" IN (
         SELECT "id" FROM "page_version"
          WHERE "page_id" = ${pageId}
            AND "sealed_at" IS NULL
            AND "frozen_at" IS NULL
            -- The newest version is the one a save just wrote: never a candidate.
            AND "number" < (SELECT max("number") FROM "page_version" WHERE "page_id" = ${pageId})
          ORDER BY "number" ASC
          LIMIT GREATEST(
            (SELECT count(*) FROM "page_version" WHERE "page_id" = ${pageId}) - ${keep},
            0
          )
       )
    `;
  },

  /**
   * SEAL one version (`pages.md` AMENDMENT 3) — a decision publish. Idempotent:
   * an already-sealed version keeps its first `sealed_at`. Returns whether the
   * version exists.
   */
  async sealVersion(versionId: string, at: Date, tx: Prisma.TransactionClient): Promise<boolean> {
    const found = await tx.pageVersion.updateMany({
      where: { id: versionId, sealedAt: null },
      data: { sealedAt: at },
    });
    if (found.count > 0) return true;
    return (await tx.pageVersion.count({ where: { id: versionId } })) > 0;
  },

  /**
   * FREEZE one version, naming the gate that approved it. The CHECK
   * `page_version_frozen_requires_sealed` refuses an unsealed version — the
   * caller seals at publish, so a violation here is a bug, not a user error.
   * Idempotent on an already-frozen version (its first freeze stands).
   */
  async freezeVersion(
    versionId: string,
    gateId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.pageVersion.updateMany({
      where: { id: versionId, frozenAt: null },
      data: { frozenAt: at, frozenByGateId: gateId },
    });
  },

  /** Whether any version of the page is FROZEN — what blocks its hard delete. */
  async hasFrozenVersion(pageId: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const hit = await tx.pageVersion.findFirst({
      where: { pageId, frozenAt: { not: null } },
      select: { id: true },
    });
    return hit !== null;
  },

  /** Whether any of these pages holds a FROZEN version — the set a delete takes. */
  async anyFrozenVersion(
    pageIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    if (pageIds.length === 0) return null;
    const hit = await tx.pageVersion.findFirst({
      where: { pageId: { in: [...pageIds] }, frozenAt: { not: null } },
      select: { pageId: true },
    });
    return hit?.pageId ?? null;
  },

  /** One version by id, with its marks and its snapshot; `null` when it is gone. */
  async findVersionById(
    versionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageVersionBodyRecord | null> {
    return tx.pageVersion.findUnique({
      where: { id: versionId },
      select: { ...PAGE_VERSION_RECORD_SELECT, bodyState: true, bodyMarkdown: true },
    });
  },

  /**
   * One page of a page's versions, newest first, continuing BELOW `beforeNumber`
   * — the keyset the history list pages on. No body columns: a snapshot is up
   * to 2 MiB.
   */
  async listByPage(
    pageId: string,
    page: { beforeNumber?: number; limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<PageVersionRecord[]> {
    return tx.pageVersion.findMany({
      where: {
        pageId,
        ...(page.beforeNumber !== undefined ? { number: { lt: page.beforeNumber } } : {}),
      },
      orderBy: { number: 'desc' },
      take: page.limit,
      select: PAGE_VERSION_RECORD_SELECT,
    });
  },
};
