import { Prisma, type Folder } from '@/generated/prisma/client';
import {
  CrossProjectFolderError,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
} from '@/lib/folders/errors';

// Folder repository — single operations on the `folder` table (Epic MOTIR-5307
// · Story MOTIR-5308 · MOTIR-5313). The persistence leaf under `foldersService`,
// which owns the transactions, the `work_item:edit` gate, the name rule, the
// cycle rule, the fractional-index arithmetic and the DTO mapping.
//
// ⚠️ EVERY READ HERE TAKES A REQUIRED `tx`, not the usual "read-only paths may
// use the singleton" arm. `folder` carries the `work_item` policy pair and NO
// system or public arm, so an UNBOUND read returns nothing and raises nothing —
// a project's folders would render as a project with none. Making the binding a
// type error is what keeps that silent failure out (the
// `workItemTodoRepository` reasoning, for the same shape of table).
//
// Write errors translate here, at the edge, so the service never inspects a
// Postgres code (the 4-layer rule): the sibling-name unique index's `P2002`, the
// migration's `FOLDER_PARENT_CROSS_*` / `FOLDER_PARENT_CYCLE` trigger markers,
// and `P2025` for a row that vanished.

/** `Folder` scalars the service creates a row from. */
export type FolderCreateInput = Prisma.FolderUncheckedCreateInput;

function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

function translateFolderWriteError(
  err: unknown,
  ctx: { id?: string; name?: string | null },
): never {
  const text = errorText(err);
  if (
    text.includes('FOLDER_PARENT_CROSS_WORKSPACE') ||
    text.includes('FOLDER_PARENT_CROSS_PROJECT')
  ) {
    throw new CrossProjectFolderError(text);
  }
  if (text.includes('FOLDER_PARENT_CYCLE')) throw new FolderCycleError(text);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new FolderNameTakenError(ctx.name ?? null);
    if (err.code === 'P2025') throw new FolderNotFoundError(ctx.id ?? '(unknown)');
  }
  throw err;
}

export const folderRepository = {
  /**
   * Serialize every STRUCTURAL change to one project's folder tree — a move or
   * a delete — for the length of the caller's transaction.
   *
   * ⚠️ WHY NOT ROW LOCKS. A cycle is a property of a CHAIN, not of a row. Two
   * moves that share no row can still close one: "A into C" (C under B) and
   * "B into E" (E under A) lock {A, C} and {B, E}, each reads the other's chain
   * before it commits, and both commit. Locking every ancestor instead works
   * only if the chain read before the locks is still the chain after them. A
   * transaction-scoped advisory lock keyed on the PROJECT closes it outright:
   * folder moves are rare, human-paced writes, and serializing them per project
   * costs nothing a person could notice.
   *
   * Taken BEFORE any folder row lock, on every path that takes both, so the
   * order is always the same and the two cannot deadlock.
   */
  async lockStructure(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`folder-structure:${projectId}`}, 0))`;
  },

  /** Lock one folder row. `null` when it does not exist or is not visible. */
  async lockById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; projectId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; projectId: string }>>`
      SELECT "id", "project_id" AS "projectId" FROM "folder" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async findById(id: string, tx: Prisma.TransactionClient): Promise<Folder | null> {
    return tx.folder.findUnique({ where: { id } });
  },

  async findByIds(ids: string[], tx: Prisma.TransactionClient): Promise<Folder[]> {
    if (ids.length === 0) return [];
    return tx.folder.findMany({ where: { id: { in: ids } } });
  },

  /**
   * A sibling folder already holding `name`, case-insensitively — the same
   * predicate the `folder_sibling_name_key` expression index enforces, so the
   * friendly check and the race backstop can never disagree about what a
   * collision is. `excludeId` leaves a folder out of its own comparison (a
   * rename that only changes case).
   */
  async findSiblingNameConflict(
    args: {
      projectId: string;
      parentFolderId: string | null;
      name: string;
      excludeId?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "folder"
       WHERE "project_id" = ${args.projectId}
         AND COALESCE("parent_folder_id", '') = ${args.parentFolderId ?? ''}
         AND lower("name") = lower(${args.name})
         AND "id" <> ${args.excludeId ?? ''}
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  },

  /** The last position among a level's folders, or `null` when it has none. */
  async lastSiblingPosition(
    projectId: string,
    parentFolderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.folder.findFirst({
      where: { projectId, parentFolderId },
      orderBy: [{ position: 'desc' }, { id: 'desc' }],
      select: { position: true },
    });
    return row?.position ?? null;
  },

  /** A folder's direct child folders, in display order. */
  async findChildFolders(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Folder, 'id' | 'name' | 'position'>>> {
    return tx.folder.findMany({
      where: { parentFolderId: folderId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, position: true },
    });
  },

  /**
   * `folderId` and every folder above it, walking `parent_folder_id` to the
   * root. The cycle check asks whether a move's target is, or sits inside, the
   * folder being moved. Bounded like the database's own cycle backstop.
   */
  async findAncestorIds(folderId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE chain AS (
        SELECT f."id", f."parent_folder_id", 1 AS lvl
          FROM "folder" f
         WHERE f."id" = ${folderId}
        UNION ALL
        SELECT f."id", f."parent_folder_id", c.lvl + 1
          FROM "folder" f
          JOIN chain c ON f."id" = c."parent_folder_id"
         WHERE c.lvl < 1000
      )
      SELECT "id" FROM chain
    `;
    return rows.map((r) => r.id);
  },

  async create(data: FolderCreateInput, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.create({ data });
    } catch (err) {
      throw translateFolderWriteError(err, { name: data.name });
    }
  },

  async rename(id: string, name: string, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.update({ where: { id }, data: { name } });
    } catch (err) {
      throw translateFolderWriteError(err, { id, name });
    }
  },

  /** Set a folder's parent and position — a move, a reorder, or both. */
  async move(
    id: string,
    patch: { parentFolderId: string | null; position: string },
    tx: Prisma.TransactionClient,
  ): Promise<Folder> {
    try {
      return await tx.folder.update({ where: { id }, data: patch });
    } catch (err) {
      throw translateFolderWriteError(err, { id });
    }
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.delete({ where: { id } });
    } catch (err) {
      throw translateFolderWriteError(err, { id });
    }
  },
};
