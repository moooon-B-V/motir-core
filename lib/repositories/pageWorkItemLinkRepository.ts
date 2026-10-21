import { Prisma } from '@/generated/prisma/client';

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
//
// ⚠️ TWO DERIVED FAMILIES, AND NEITHER TOUCHES THE OTHER (MOTIR-7696). A PAGE
// body derives `mention` / `embed`, keyed on the page; a WORK ITEM's
// Description / Explanation derives `description` / `explanation`, keyed on the
// item. Each family's methods name only its own sources, so a page save never
// deletes an item-derived row and a work-item save never deletes a page-derived
// one.

/** The sources a PAGE body write derives; `manual` is not one of them. */
export const DERIVED_PAGE_LINK_SOURCES = ['mention', 'embed'] as const;

export type DerivedPageLinkSourceValue = (typeof DERIVED_PAGE_LINK_SOURCES)[number];

/** The sources a WORK ITEM's body write derives (MOTIR-7696). */
export const ITEM_DERIVED_PAGE_LINK_SOURCES = ['description', 'explanation'] as const;

export type ItemDerivedPageLinkSourceValue = (typeof ITEM_DERIVED_PAGE_LINK_SOURCES)[number];

/** Every source a row can carry. */
export type PageLinkSourceValue =
  | DerivedPageLinkSourceValue
  | ItemDerivedPageLinkSourceValue
  | 'manual';

/** One derived row, as the diff reads it. */
export interface DerivedPageLinkRecord {
  id: string;
  workItemId: string;
  source: DerivedPageLinkSourceValue;
  createdById: string | null;
  createdAt: Date;
}

/** One ITEM-derived row, as the work-item save's diff reads it. */
export interface ItemDerivedPageLinkRecord {
  id: string;
  pageId: string;
  source: ItemDerivedPageLinkSourceValue;
  createdById: string | null;
  createdAt: Date;
}

/**
 * One page that links to a work item, live or archived, grouped from its link
 * rows (MOTIR-7573 · MOTIR-9203): every source it links by, sorted, and what its
 * place needs — the folder its topmost page is filed in, and its direct parent's
 * title. `archivedAt` is the page's own archive stamp, `null` while it is live.
 */
export interface WorkItemPageLinkRecord {
  pageId: string;
  title: string;
  updatedAt: Date;
  /** `null` while the page is live; set once it is archived (MOTIR-9203). */
  archivedAt: Date | null;
  sources: PageLinkSourceValue[];
  /** The folder the page's TOPMOST page is filed in (a sub-page carries none). */
  placeFolderId: string | null;
  /** The direct parent page's title; `null` for a top-level page. */
  parentPageTitle: string | null;
}

/**
 * One HAND-MADE row (`source: 'manual'`, MOTIR-9197). Deliberately WITHOUT
 * `source`: the source is fixed by the method, so a derived family cannot be
 * nominated through this door and `manual` cannot be nominated through
 * `createDerived`'s.
 */
export interface ManualPageLinkInsert {
  workspaceId: string;
  projectId: string;
  pageId: string;
  workItemId: string;
  createdById: string;
}

/** The last page a page of the read served — the `(updated_at, id)` it seeks after. */
export interface WorkItemPagesSeek {
  updatedAt: Date;
  id: string;
}

/** The last hand link a page of the page-side read served — the `(created_at, id)` it seeks after. */
export interface PageWorkItemsSeek {
  createdAt: Date;
  id: string;
}

/** One hand link of a page, as the page-side read selects it: the link row alone, no `work_item` join. */
export interface PageManualLinkRecord {
  id: string;
  workItemId: string;
  createdAt: Date;
}

/** A row `createDerived` writes. */
export interface DerivedPageLinkInsert {
  workspaceId: string;
  projectId: string;
  pageId: string;
  workItemId: string;
  source: DerivedPageLinkSourceValue | ItemDerivedPageLinkSourceValue;
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

  /** A work item's ITEM-derived rows (`description` / `explanation`), oldest first. */
  async findItemDerivedByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ItemDerivedPageLinkRecord[]> {
    const rows = await tx.pageWorkItemLink.findMany({
      where: { workItemId, source: { in: [...ITEM_DERIVED_PAGE_LINK_SOURCES] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, pageId: true, source: true, createdById: true, createdAt: true },
    });
    return rows as ItemDerivedPageLinkRecord[];
  },

  /**
   * Deletes the named ITEM-derived rows of one work item; a page-derived or
   * `manual` id is never matched.
   */
  async deleteItemDerivedByIds(
    workItemId: string,
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.pageWorkItemLink.deleteMany({
      where: {
        workItemId,
        id: { in: [...ids] },
        source: { in: [...ITEM_DERIVED_PAGE_LINK_SOURCES] },
      },
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

  /**
   * Writes the hand link of one pair (MOTIR-9197). The table's key is
   * `(page_id, work_item_id, source)`, so a pair that is also mentioned or
   * embedded does not suppress it; `skipDuplicates` turns a second `manual`
   * row into a count of 0 — the caller's "already linked" — rather than a unique
   * violation, which would abort the enclosing transaction and take the
   * revision row with it.
   */
  async createManual(input: ManualPageLinkInsert, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.pageWorkItemLink.createMany({
      data: [{ ...input, source: 'manual' }],
      skipDuplicates: true,
    });
    return result.count;
  },

  /**
   * A page's HAND links (`source = 'manual'`), newest first on `(created_at, id)`
   * (MOTIR-9198). It selects link rows alone — never joining `work_item` — so a
   * row whose item cannot be summarised still comes back. `take` is the caller's
   * page size plus its look-ahead.
   */
  async listManualByPage(
    pageId: string,
    after: PageWorkItemsSeek | null,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<PageManualLinkRecord[]> {
    return tx.pageWorkItemLink.findMany({
      where: {
        pageId,
        source: 'manual',
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, workItemId: true, createdAt: true },
    });
  },

  /**
   * Deletes the hand link of one pair (MOTIR-9197). Its `where` names
   * `manual`, so a mention, an embed or an item-derived row of the same pair is
   * never matched.
   */
  async deleteManual(
    pageId: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.pageWorkItemLink.deleteMany({
      where: { pageId, workItemId, source: 'manual' },
    });
    return result.count;
  },

  /**
   * The pages linking to one work item, ONE row per page however many link rows
   * it has (MOTIR-7573), newest edit first and keyset-paged on
   * `(updated_at, id)` descending. One statement: the link rows grouped by page,
   * joined to the page, and its topmost and parent page for its place. An
   * archived page is served, flagged by `archivedAt`, in the same window and
   * order (MOTIR-9203); a deleted one has no rows (the FK cascade). `take` is
   * the caller's page size plus its look-ahead.
   */
  async listPagesForWorkItem(
    workItemId: string,
    after: WorkItemPagesSeek | null,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemPageLinkRecord[]> {
    const seek = after
      ? Prisma.sql`AND (p."updated_at", p."id") < (${after.updatedAt}::timestamptz, ${after.id})`
      : Prisma.empty;
    return tx.$queryRaw<WorkItemPageLinkRecord[]>`
      SELECT p."id" AS "pageId",
             p."title",
             p."updated_at" AS "updatedAt",
             p."archived_at" AS "archivedAt",
             array_agg(DISTINCT l."source"::text ORDER BY l."source"::text) AS "sources",
             COALESCE(top."folder_id", p."folder_id") AS "placeFolderId",
             parent."title" AS "parentPageTitle"
        FROM "page_work_item_link" l
        JOIN "page" p ON p."id" = l."page_id"
        LEFT JOIN "page" top ON top."id" = p."ancestor_page_ids"[1]
        LEFT JOIN "page" parent
          ON parent."id" = p."ancestor_page_ids"[cardinality(p."ancestor_page_ids")]
       WHERE l."work_item_id" = ${workItemId}
         ${seek}
       GROUP BY p."id", top."folder_id", parent."title"
       ORDER BY p."updated_at" DESC, p."id" DESC
       LIMIT ${take}`;
  },
};
