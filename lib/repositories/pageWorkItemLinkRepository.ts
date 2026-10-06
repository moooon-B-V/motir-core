import type { Prisma } from '@/generated/prisma/client';

// Page ↔ work-item link repository — single operations on `page_work_item_link`
// (Story MOTIR-7565 · MOTIR-7571), `docs/decisions/pages.md` §8.1. The
// persistence leaf under the `PageStore` adapter's `replaceDerivedLinks`; the
// adapter composes the diff, the page service owns the transaction.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — `pageRepository`'s
// reasoning: the table carries the workspace policy pair and no system or public
// arm, so an UNBOUND read returns nothing and raises nothing.
//
// ⚠️ THE DERIVED METHODS NEVER TOUCH A `manual` ROW. Their `where` names the
// derived sources explicitly, so a hand-made link survives every body write.

/** The sources a body write derives; `manual` is not one of them. */
export const DERIVED_PAGE_LINK_SOURCES = ['mention', 'embed'] as const;

export type DerivedPageLinkSourceValue = (typeof DERIVED_PAGE_LINK_SOURCES)[number];

/** One derived row, as the diff reads it. */
export interface DerivedPageLinkRecord {
  id: string;
  workItemId: string;
  source: DerivedPageLinkSourceValue;
  createdById: string | null;
  createdAt: Date;
}

/** A row `createDerived` writes. */
export interface DerivedPageLinkInsert {
  workspaceId: string;
  projectId: string;
  pageId: string;
  workItemId: string;
  source: DerivedPageLinkSourceValue;
  createdById: string;
}

export const pageWorkItemLinkRepository = {
  /** A page's DERIVED rows (`mention` / `embed`), oldest first. */
  async findDerivedByPage(
    pageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DerivedPageLinkRecord[]> {
    const rows = await tx.pageWorkItemLink.findMany({
      where: { pageId, source: { in: [...DERIVED_PAGE_LINK_SOURCES] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, workItemId: true, source: true, createdById: true, createdAt: true },
    });
    return rows as DerivedPageLinkRecord[];
  },

  /** Deletes the named DERIVED rows of one page; a `manual` id is never matched. */
  async deleteDerivedByIds(
    pageId: string,
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.pageWorkItemLink.deleteMany({
      where: { pageId, id: { in: [...ids] }, source: { in: [...DERIVED_PAGE_LINK_SOURCES] } },
    });
    return result.count;
  },

  /**
   * Writes new derived rows. `skipDuplicates`: a row the unique key already
   * holds is left as it is — the save holds the page's lock, so this only
   * guards a caller that passed one twice.
   */
  async createDerived(
    rows: readonly DerivedPageLinkInsert[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.pageWorkItemLink.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
    return result.count;
  },
};
