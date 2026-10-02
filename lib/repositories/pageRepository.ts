import { Prisma } from '@/generated/prisma/client';
import {
  PAGE_RECORD_SELECT,
  type PageLockedRecord,
  type PageRecord,
} from '@/lib/mappers/pageMappers';

// Page repository — single operations on the `page` table (Story MOTIR-5752 ·
// MOTIR-7276). The persistence leaf under the `PageStore` adapter
// (`lib/pages/pageStoreAdapter.ts`); `@motir/pages`' procedures decide what is
// written and in what order, and the page service owns the transaction.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — the `folderRepository`
// reasoning: `page` carries the workspace policy pair and no system or public
// arm, so an UNBOUND read returns nothing and raises nothing, and a project's
// pages would render as a project with none.

/** What `insert` writes — the unchecked create shape, ids rather than relations. */
export type PageCreateInput = Prisma.PageUncheckedCreateInput;

/** What `updateBody` writes: the state, the three derived formats and the stamp. */
export interface PageBodyUpdate {
  bodyState: Uint8Array<ArrayBuffer>;
  bodyJson: Prisma.InputJsonValue;
  bodyMarkdown: string;
  bodyText: string;
  revision: number;
  updatedById: string;
  updatedAt: Date;
}

export const pageRepository = {
  /**
   * Read one page `FOR UPDATE`, body included. `null` when it does not exist or
   * is invisible under RLS.
   *
   * ⚠️ THIS LOCK IS A SAVE'S WHOLE CONCURRENCY GUARANTEE: two saves of one page
   * in two transactions serialise here, and the second merges onto the state
   * the first committed. So it is raw SQL with the lock clause in plain sight.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<PageLockedRecord | null> {
    const rows = await tx.$queryRaw<PageLockedRecord[]>`
      SELECT "id",
             "workspace_id" AS "workspaceId",
             "project_id" AS "projectId",
             "title",
             "parent_page_id" AS "parentPageId",
             "folder_id" AS "folderId",
             "position",
             "ancestor_page_ids" AS "ancestorPageIds",
             "body_state" AS "bodyState",
             "revision",
             "created_by_id" AS "createdById",
             "updated_by_id" AS "updatedById",
             "created_at" AS "createdAt",
             "updated_at" AS "updatedAt"
        FROM "page"
       WHERE "id" = ${id}
         FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Read one page WITH its body state and no lock — the read model's door
   * (`pagesService.getPage`). A reader never blocks a save, and a save never
   * waits on a reader. `null` when absent or invisible.
   */
  async findWithBodyById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageLockedRecord | null> {
    return tx.page.findUnique({
      where: { id },
      select: { ...PAGE_RECORD_SELECT, bodyState: true },
    });
  },

  /** Read one page without its body. `null` when absent or invisible. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<PageRecord | null> {
    return tx.page.findUnique({ where: { id }, select: PAGE_RECORD_SELECT });
  },

  /**
   * Serialise inserts at one project's ROOT for the caller's transaction, so two
   * creates read distinct last positions. An advisory lock rather than row locks
   * because an empty level has no row to lock — `folderRepository.lockStructure`'s
   * precedent.
   */
  async lockRootSiblings(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-root:${projectId}`}, 0))`;
  },

  /**
   * The greatest position among a project's root pages, or `null`. Compared in
   * `COLLATE "C"` — code-unit order, the order fractional keys are minted in —
   * whatever the database's default collation.
   */
  async lastRootPosition(projectId: string, tx: Prisma.TransactionClient): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ position: string }>>`
      SELECT "position" FROM "page"
       WHERE "project_id" = ${projectId}
         AND "parent_page_id" IS NULL
         AND "folder_id" IS NULL
       ORDER BY "position" COLLATE "C" DESC, "id" COLLATE "C" DESC
       LIMIT 1
    `;
    return rows[0]?.position ?? null;
  },

  async insert(data: PageCreateInput, tx: Prisma.TransactionClient): Promise<PageRecord> {
    return tx.page.create({ data, select: PAGE_RECORD_SELECT });
  },

  /** Write the state, the three formats, the revision and the stamp in ONE `UPDATE`. */
  async updateBody(id: string, write: PageBodyUpdate, tx: Prisma.TransactionClient): Promise<void> {
    await tx.page.update({ where: { id }, data: write, select: { id: true } });
  },

  /** Rename. `null` when the page is absent or invisible (Prisma's `P2025`). */
  async updateTitle(
    id: string,
    title: string,
    actorId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageRecord | null> {
    try {
      return await tx.page.update({
        where: { id },
        data: { title, updatedById: actorId },
        select: PAGE_RECORD_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  },
};
