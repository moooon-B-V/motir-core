import { Prisma, type Page } from '@/generated/prisma/client';
import {
  PAGE_RECORD_SELECT,
  type PageLevelRecord,
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

/**
 * One row of the `/pages` index (MOTIR-7300): the page's identity, title and its
 * last edit — no body columns, which are up to 2 MiB a row.
 */
export type PageListRecord = Pick<Page, 'id' | 'title' | 'updatedAt' | 'updatedById'>;

/**
 * The parent a level read or a placement names — `@motir/pages`' `PagePlacement`,
 * restated here so the repository does not import the package (the import
 * direction `tests/packages/importDirection.test.ts` holds).
 */
export type PageParentRef =
  | { readonly kind: 'root' }
  | { readonly kind: 'folder'; readonly folderId: string }
  | { readonly kind: 'page'; readonly pageId: string };

/** The positions to mint between; `null` is the start (`before`) or end (`after`). */
export interface PageNeighbourPositions {
  before: string | null;
  after: string | null;
}

/** A folder as a placement under it reads it. */
export interface PageFolderRef {
  id: string;
  projectId: string;
}

/** One descendant of a moving page. */
export interface PageSubtreeRecord {
  id: string;
  ancestorPageIds: string[];
}

/** What `updatePlacement` writes. */
export interface PagePlacementUpdate {
  parentPageId: string | null;
  folderId: string | null;
  position: string;
  ancestorPageIds: readonly string[];
  updatedById: string;
}

/**
 * The rows of ONE level, alias `p`: at the root neither column is set; in a
 * folder the folder is (a sub-page never carries one — `page_parent_xor_folder`);
 * under a page the parent is.
 */
function levelPredicate(parent: PageParentRef): Prisma.Sql {
  switch (parent.kind) {
    case 'root':
      return Prisma.sql`p."parent_page_id" IS NULL AND p."folder_id" IS NULL`;
    case 'folder':
      return Prisma.sql`p."folder_id" = ${parent.folderId}`;
    case 'page':
      return Prisma.sql`p."parent_page_id" = ${parent.pageId}`;
  }
}

export const pageRepository = {
  /**
   * Every page of one project, most recently edited first — the `/pages` index
   * (MOTIR-7300). Flat: the tree is MOTIR-5753's. `id` breaks a tie on
   * `updatedAt`, so two pages saved in one millisecond keep a stable order.
   */
  async listByProject(projectId: string, tx: Prisma.TransactionClient): Promise<PageListRecord[]> {
    return tx.page.findMany({
      where: { projectId },
      select: { id: true, title: true, updatedAt: true, updatedById: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  },

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
   * Serialise every PLACEMENT write in one project — a create, a move, a subtree
   * rewrite — for the length of the caller's transaction (MOTIR-7369).
   *
   * ⚠️ ONE LOCK PER PROJECT, NOT PER PARENT. A move changes two sibling sets and
   * a whole subtree, and a cycle is a property of a CHAIN: two moves that share
   * no row ("A under B", "B under A") each pass the cycle check against a tree
   * the other is changing unless they serialise. An advisory lock rather than
   * row locks because an empty level has no row to lock —
   * `folderRepository.lockStructure`'s reasoning.
   *
   * ⚠️ LOCK ORDER: folder-structure, THEN page-structure, wherever both are
   * taken (`foldersService.deleteFolder`), so the two cannot deadlock.
   */
  async lockStructure(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-structure:${projectId}`}, 0))`;
  },

  /**
   * The greatest position among one parent's pages — the root, a folder or a
   * page — or `null` for an empty level. Compared in `COLLATE "C"` — code-unit
   * order, the order fractional keys are minted in — whatever the database's
   * default collation.
   */
  async lastPosition(
    projectId: string,
    parent: PageParentRef,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ position: string }>>`
      SELECT p."position" FROM "page" p
       WHERE p."project_id" = ${projectId}
         AND ${levelPredicate(parent)}
       ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
       LIMIT 1
    `;
    return rows[0]?.position ?? null;
  },

  /**
   * The positions a placement mints between at one parent's level — the port's
   * `siblingNeighbours`. Named ids are children of `parent` (the caller checked).
   * An UNNAMED side is read from the level in `(position, id) COLLATE "C"`
   * order: with only `beforeId`, `after` is the page right after it; with only
   * `afterId`, `before` is the page right before it; with neither, `before` is
   * the level's last page and `after` is `null`. A named id that is not there
   * reads as `null` on its side.
   */
  async neighbourPositions(
    projectId: string,
    parent: PageParentRef,
    beforeId: string | null,
    afterId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<PageNeighbourPositions> {
    let rows: PageNeighbourPositions[];
    if (beforeId !== null && afterId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT (SELECT "position" FROM "page" WHERE "id" = ${beforeId}) AS "before",
               (SELECT "position" FROM "page" WHERE "id" = ${afterId}) AS "after"
      `;
    } else if (beforeId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT b."position" AS "before",
               (SELECT p."position" FROM "page" p
                 WHERE p."project_id" = ${projectId}
                   AND ${levelPredicate(parent)}
                   AND (p."position" COLLATE "C", p."id" COLLATE "C") > (b."position", b."id")
                 ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
                 LIMIT 1) AS "after"
          FROM "page" b
         WHERE b."id" = ${beforeId}
      `;
    } else if (afterId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT (SELECT p."position" FROM "page" p
                 WHERE p."project_id" = ${projectId}
                   AND ${levelPredicate(parent)}
                   AND (p."position" COLLATE "C", p."id" COLLATE "C") < (a."position", a."id")
                 ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
                 LIMIT 1) AS "before",
               a."position" AS "after"
          FROM "page" a
         WHERE a."id" = ${afterId}
      `;
    } else {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT p."position" AS "before", NULL::text AS "after" FROM "page" p
         WHERE p."project_id" = ${projectId}
           AND ${levelPredicate(parent)}
         ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
         LIMIT 1
      `;
    }
    return rows[0] ?? { before: null, after: null };
  },

  /**
   * Read the folder a page is being placed in, `FOR SHARE` — so a concurrent
   * folder delete (which updates the pages it holds and then deletes the row)
   * either commits first and this reads nothing, or waits for this transaction
   * and then sees the page it placed. `null` when the folder does not exist or
   * is invisible under RLS: `folder_project_narrow` hides another project's
   * folder when the context names a project, `folder_active_workspace` another
   * workspace's.
   */
  async findFolderForPlacement(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageFolderRef | null> {
    const rows = await tx.$queryRaw<PageFolderRef[]>`
      SELECT "id", "project_id" AS "projectId" FROM "folder" WHERE "id" = ${folderId} FOR SHARE
    `;
    return rows[0] ?? null;
  },

  /**
   * Every DESCENDANT of a page, at any depth (the page itself excluded): the rows
   * whose ancestor chain contains it.
   */
  async findSubtree(pageId: string, tx: Prisma.TransactionClient): Promise<PageSubtreeRecord[]> {
    return tx.$queryRaw<PageSubtreeRecord[]>`
      SELECT "id", "ancestor_page_ids" AS "ancestorPageIds" FROM "page"
       WHERE "ancestor_page_ids" @> ARRAY[${pageId}]::text[]
    `;
  },

  /** Move one page: its parent, folder, position and ancestors, in ONE `UPDATE`. */
  async updatePlacement(
    id: string,
    write: PagePlacementUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<PageRecord> {
    return tx.page.update({
      where: { id },
      data: {
        parentPageId: write.parentPageId,
        folderId: write.folderId,
        position: write.position,
        ancestorPageIds: [...write.ancestorPageIds],
        updatedById: write.updatedById,
      },
      select: PAGE_RECORD_SELECT,
    });
  },

  /**
   * Rewrite the `ancestor_page_ids` of EVERY descendant of `pageId` in ONE
   * statement: the part of each chain above `pageId` becomes `newPrefix`, and
   * `pageId` and everything below it are kept (`chain[array_position(chain,
   * pageId):]`). One statement, so the depth CHECK and the readers see the whole
   * subtree move at once. Returns the number of rows rewritten.
   */
  async rebaseDescendants(
    pageId: string,
    newPrefix: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "page"
         SET "ancestor_page_ids" = ${[...newPrefix]}::text[]
               || "ancestor_page_ids"[array_position("ancestor_page_ids", ${pageId}::text):]
       WHERE "ancestor_page_ids" @> ARRAY[${pageId}]::text[]
    `;
  },

  /**
   * One KEYSET page of one parent's pages — the root, a folder or a page — for
   * the `/pages` tree level. Ordered by `(position, id)` in `COLLATE "C"`, a
   * TOTAL order, and seeks strictly after `after`, so a page created or moved
   * between two reads never shifts a page boundary. Reads `limit` rows; the
   * caller asks for one more than it serves to learn whether a page follows.
   * `hasChildren` is whether the page holds any sub-page.
   */
  async findLevelAfter(
    projectId: string,
    parent: PageParentRef,
    after: { position: string; id: string } | null,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PageLevelRecord[]> {
    const seek = after
      ? Prisma.sql`AND (p."position" COLLATE "C", p."id" COLLATE "C") > (${after.position}, ${after.id})`
      : Prisma.empty;
    return tx.$queryRaw<PageLevelRecord[]>`
      SELECT p."id",
             p."title",
             p."position",
             p."updated_at" AS "updatedAt",
             EXISTS (SELECT 1 FROM "page" c WHERE c."parent_page_id" = p."id") AS "hasChildren"
        FROM "page" p
       WHERE p."project_id" = ${projectId}
         AND ${levelPredicate(parent)}
         ${seek}
       ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
       LIMIT ${limit}
    `;
  },

  /**
   * The pages FILED in one folder — its top-level pages, the set a folder delete
   * moves up (MOTIR-7371) — in level order, `(position, id) COLLATE "C"`. A
   * sub-page carries no `folder_id` (`page_parent_xor_folder`), so it is never
   * here: it follows its parent wherever the parent goes.
   */
  async findFiledInFolder(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; position: string }>> {
    return tx.$queryRaw<Array<{ id: string; position: string }>>`
      SELECT p."id", p."position" FROM "page" p
       WHERE p."folder_id" = ${folderId}
       ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
    `;
  },

  /** How many pages are filed directly in `folderId` — the set `findFiledInFolder` reads. */
  async countFiledInFolder(folderId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.page.count({ where: { folderId } });
  },

  /**
   * Re-file pages from one folder to another folder, or to the project root
   * (`toFolderId` null), each at the position the caller minted for it, in ONE
   * `UPDATE` (MOTIR-7371 — a folder delete's move-up). Only rows still filed in
   * `fromFolderId` are touched. Their sub-pages are not rows of this write: a
   * sub-page carries no folder, and its ancestor chain names pages only. Returns
   * the number of pages moved.
   */
  async moveFiledPages(
    fromFolderId: string,
    toFolderId: string | null,
    positions: ReadonlyArray<{ id: string; position: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (positions.length === 0) return 0;
    return tx.$executeRaw`
      UPDATE "page" p
         SET "folder_id" = ${toFolderId}::text,
             "position" = v."position"
        FROM unnest(${positions.map((p) => p.id)}::text[], ${positions.map((p) => p.position)}::text[])
             AS v("id", "position")
       WHERE p."id" = v."id"
         AND p."folder_id" = ${fromFolderId}
    `;
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
