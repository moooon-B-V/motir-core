import { Prisma, type Dashboard } from '@prisma/client';
import { db } from '@/lib/db';
import type { DashboardWithFacts } from '@/lib/mappers/dashboardMappers';

// Dashboard data access (Story 6.3 · Subtask 6.3.1). Single Prisma ops;
// writes require `tx` (CLAUDE.md). The list read is bounded (finding #57)
// with owner + widget-count facts aggregated IN the query (`_count` + the
// owner select — never a JS count over child rows).

/** The include that decorates a row with owner + widget-count facts. */
const factsInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { widgets: true } },
} satisfies Prisma.DashboardInclude;

export const dashboardRepository = {
  /** A row decorated with owner + widget-count facts (the detail read).
   * Workspace-scoped — a cross-tenant id reads as null (the service's 404),
   * belt-and-braces over RLS. */
  async findByIdWithFacts(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DashboardWithFacts | null> {
    if (!workspaceId || !id) return null;
    const client = tx ?? db;
    return client.dashboard.findFirst({ where: { id, workspaceId }, include: factsInclude });
  },

  /**
   * The bounded home/switcher list: the actor's own dashboards plus the
   * workspace-shared ones (private rows of OTHERS stay invisible — the
   * access rule applied in the predicate, not post-filtered in JS),
   * name-ordered with an id tiebreak (names aren't unique).
   */
  async listVisible(
    workspaceId: string,
    actorUserId: string,
    take: number,
  ): Promise<DashboardWithFacts[]> {
    if (!workspaceId || !actorUserId) return [];
    return db.dashboard.findMany({
      where: { workspaceId, OR: [{ access: 'workspace' }, { ownerId: actorUserId }] },
      include: factsInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
    });
  },

  /**
   * `FOR UPDATE` lock on the row — every read-derived write (update /
   * delete / any widget mutation re-reads the dashboard to decide
   * permissions + the cap + positions, then writes) locks FIRST so
   * concurrent writers serialize (the lock-before-read-derived-update
   * rule). Workspace-scoped like `boardRepository.lockById`.
   */
  async lockById(
    workspaceId: string,
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    if (!workspaceId || !id) return null;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "dashboard" WHERE "id" = ${id} AND "workspace_id" = ${workspaceId} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async create(
    data: Prisma.DashboardUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Dashboard> {
    return tx.dashboard.create({ data });
  },

  async update(
    id: string,
    data: Pick<Prisma.DashboardUncheckedUpdateInput, 'name' | 'access' | 'layout'>,
    tx: Prisma.TransactionClient,
  ): Promise<Dashboard> {
    return tx.dashboard.update({ where: { id }, data });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<Dashboard> {
    return tx.dashboard.delete({ where: { id } });
  },
};
