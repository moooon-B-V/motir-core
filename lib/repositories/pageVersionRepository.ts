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
   * Delete every version of a page but the `keep` highest numbers, in ONE
   * statement — it runs under the page's lock, and a single statement cannot
   * race itself. A restore row whose source goes is kept: the FK sets its
   * `restored_from_version_id` to NULL and `restored_from_number` stays.
   */
  async deleteOldest(pageId: string, keep: number, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "page_version"
       WHERE "page_id" = ${pageId}
         AND "number" NOT IN (
           SELECT "number" FROM "page_version"
            WHERE "page_id" = ${pageId}
            ORDER BY "number" DESC
            LIMIT ${keep}
         )
    `;
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
