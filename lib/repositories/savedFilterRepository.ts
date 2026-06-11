import { Prisma, type SavedFilter, type SavedFilterVisibility } from '@prisma/client';
import { db } from '@/lib/db';
import type { SavedFilterWithStars } from '@/lib/mappers/savedFilterMappers';

// Saved-filter data access (Story 6.2 · Subtask 6.2.1). Single Prisma ops;
// writes require `tx` (CLAUDE.md). List reads are bounded + cursor-paged +
// server-searched (finding #57 — a project with 500 filters never ships them
// all to a dropdown), with star facts aggregated IN the query (`_count` +
// the actor's own star row), never in JS over all rows.

/** The include that decorates a row with owner + star facts for the DTO. */
function starsInclude(actorUserId: string) {
  return {
    owner: { select: { id: true, name: true } },
    _count: { select: { stars: true } },
    stars: { where: { userId: actorUserId }, select: { userId: true } },
  } satisfies Prisma.SavedFilterInclude;
}

/** Which slice of the project's filters a list read returns. The VISIBILITY
 * predicate is the same for every view: project-shared rows, plus the
 * actor's own, plus (for the admin tier) other users' private rows. */
export type SavedFilterListView = 'all' | 'mine' | 'project' | 'starred';

export interface SavedFilterListArgs {
  projectId: string;
  actorUserId: string;
  /** Whether the actor sits in the saved-filter admin tier (sees private
   * rows of others — the service computes this from the 6.4 inputs). */
  actorIsAdmin: boolean;
  view: SavedFilterListView;
  /** Case-insensitive name substring (the directory/dropdown search). */
  q?: string;
  cursor?: string;
  take: number;
}

function listWhere(args: SavedFilterListArgs): Prisma.SavedFilterWhereInput {
  const visibility: Prisma.SavedFilterWhereInput = args.actorIsAdmin
    ? {}
    : { OR: [{ visibility: 'project' }, { ownerId: args.actorUserId }] };
  const view: Prisma.SavedFilterWhereInput =
    args.view === 'mine'
      ? { ownerId: args.actorUserId }
      : args.view === 'project'
        ? { visibility: 'project' }
        : args.view === 'starred'
          ? { stars: { some: { userId: args.actorUserId } } }
          : {};
  const q = args.q?.trim().toLowerCase();
  return {
    projectId: args.projectId,
    ...visibility,
    ...view,
    ...(q ? { nameLower: { contains: q } } : {}),
  };
}

export const savedFilterRepository = {
  /** A row decorated with owner + star facts (the detail/resolve read). */
  async findByIdWithStars(
    id: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterWithStars | null> {
    const client = tx ?? db;
    return client.savedFilter.findUnique({
      where: { id },
      include: starsInclude(actorUserId),
    });
  },

  /** The uniqueness pre-check — a validation read that gates a write, so it
   * runs inside the write's transaction (required `tx`, CLAUDE.md). */
  async findByNameLower(
    projectId: string,
    nameLower: string,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilter | null> {
    return tx.savedFilter.findUnique({
      where: { projectId_nameLower: { projectId, nameLower } },
    });
  },

  /**
   * One page of the view, name-ordered (nameLower is unique per project, so
   * the order is total and the id cursor is stable), `take + 1` row-peek for
   * `nextCursor`, star facts aggregated in the same query.
   */
  async listPage(args: SavedFilterListArgs): Promise<SavedFilterWithStars[]> {
    return db.savedFilter.findMany({
      where: listWhere(args),
      include: starsInclude(args.actorUserId),
      orderBy: { nameLower: 'asc' },
      take: args.take,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
  },

  /** The view's total (the directory's count header), same predicate. */
  async countVisible(args: Omit<SavedFilterListArgs, 'cursor' | 'take'>): Promise<number> {
    return db.savedFilter.count({ where: listWhere({ ...args, take: 0 }) });
  },

  /**
   * `FOR UPDATE` lock on the row — every read-derived write (update / delete
   * / change-owner re-reads the row to decide permissions, then writes) locks
   * FIRST so concurrent writers serialize (the lock-before-read-derived-
   * update rule).
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "saved_filter" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async create(
    data: Prisma.SavedFilterUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilter> {
    return tx.savedFilter.create({ data });
  },

  async update(
    id: string,
    data: Pick<
      Prisma.SavedFilterUncheckedUpdateInput,
      'name' | 'nameLower' | 'description' | 'visibility' | 'astEnvelope' | 'ownerId'
    >,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilter> {
    return tx.savedFilter.update({ where: { id }, data });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<SavedFilter> {
    return tx.savedFilter.delete({ where: { id } });
  },
};

export type { SavedFilterVisibility };
