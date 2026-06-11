import { Prisma, type Component } from '@prisma/client';
import { db } from '@/lib/db';

// Component repository — single Prisma operations on the `component` table
// (Story 5.4 · Subtask 5.4.1). The persistence leaf under componentsService
// (5.4.3), which owns the admin gate (the 6.4 two-tier check), name
// uniqueness validation, default-assignee scoping, the at-create
// default-assignee rule, the move-or-remove delete flow, and DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx`. Pure read paths use the
// `db` singleton (optional `tx` for guard reads inside a transaction).

/**
 * A component with its in-use count riding along — the shape the admin list
 * + the delete dialog render ("N work items"). One query, no N+1.
 */
export type ComponentWithCount = Prisma.ComponentGetPayload<{
  include: { _count: { select: { workItems: true } } };
}>;

export const componentRepository = {
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Component | null> {
    const client = tx ?? db;
    return client.component.findUnique({ where: { id } });
  },

  /**
   * Bulk id resolution — the same-project validation read behind
   * `setComponents` and `createWorkItem`'s componentIds pre-flight (5.4.3):
   * one query, the service asserts workspace + project per id. Optional
   * `tx`. Empty input is an empty result by contract (coverage gate).
   */
  async findByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<Component[]> {
    if (ids.length === 0) return [];
    const client = tx ?? db;
    return client.component.findMany({ where: { id: { in: ids } } });
  },

  /**
   * The case-insensitive uniqueness probe (5.4.3's create/rename guard —
   * the `@@unique([projectId, nameLower])` key; the constraint backstops
   * the concurrent-create race). Optional `tx` — called inside the
   * create/rename transaction.
   */
  async findByNameLower(
    projectId: string,
    nameLower: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Component | null> {
    const client = tx ?? db;
    return client.component.findUnique({
      where: { projectId_nameLower: { projectId, nameLower } },
    });
  },

  /**
   * A project's components, name-ordered, each carrying its in-use count —
   * the admin page / picker read (5.4.3's `listComponents`). Project-scoped
   * admin data: bounded by the taxonomy's nature (admin-curated, not
   * user-generated), so no pagination by design — the recorded finding-#57
   * call in the story description. Read-only path → `db` singleton.
   */
  async listByProject(projectId: string): Promise<ComponentWithCount[]> {
    return db.component.findMany({
      where: { projectId },
      include: { _count: { select: { workItems: true } } },
      orderBy: { nameLower: 'asc' },
    });
  },

  /**
   * The components riding an issue's detail read (5.4.3 slots this into
   * `getIssueDetail`'s parallel fetch — one bounded query, no N+1).
   * Relation filter, name order.
   */
  async listByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<Component[]> {
    const client = tx ?? db;
    return client.component.findMany({
      where: { workItems: { some: { workItemId } } },
      orderBy: { nameLower: 'asc' },
    });
  },

  /**
   * The at-create default-assignee resolution read (5.4.3, the verified
   * Jira rule): of the given components, the FIRST-ALPHABETICAL one (by
   * `nameLower`) that has a default assignee. One query — the order +
   * filter + take(1) push the rule into the index walk. Optional `tx` —
   * called inside `createWorkItem`'s transaction. Empty input is a
   * no-match by contract (coverage gate).
   */
  async findFirstDefaultAssignee(
    componentIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Component | null> {
    if (componentIds.length === 0) return null;
    const client = tx ?? db;
    return client.component.findFirst({
      where: { id: { in: componentIds }, defaultAssigneeId: { not: null } },
      orderBy: { nameLower: 'asc' },
    });
  },

  /**
   * Lock one component row `FOR UPDATE` inside a transaction — the
   * move-or-remove delete flow's lost-update guard (5.4.3): the delete
   * serializes against a concurrent rename/edit, and the dialog's counts
   * are re-derived inside the same transaction. `tx` REQUIRED. Returns the
   * locked row's id, or null when already gone. Mirrors
   * `workItemRepository.lockById`.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "component" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async create(
    data: Prisma.ComponentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Component> {
    return tx.component.create({ data });
  },

  async update(
    id: string,
    patch: Prisma.ComponentUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Component> {
    return tx.component.update({ where: { id }, data: patch });
  },

  /**
   * Hard-delete one component. The SERVICE must have run the move-or-remove
   * flow first (5.4.3) — any join row still pointing here makes the DB
   * throw on the RESTRICT FK (the deliberate backstop; see the
   * `work_item_component` model doc).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Component> {
    return tx.component.delete({ where: { id } });
  },
};
