import type { Prisma, WorkItemRepo } from '@/generated/prisma/client';

// Single Prisma operations on the `work_item_repository` table — a work item's
// repositories as REFERENCES to the project's repository rows (Story MOTIR-2732 ·
// MOTIR-3039, ADR `docs/decisions/work-item-repository-set.md` "Amendment
// 2026-08-18").
//
// Named `workItemRepoRepository` (for the Prisma model `WorkItemRepo`) so it is
// unambiguous next to `workItemRepository`, the data-access leaf for the
// `work_item` table — a different entity. The same collision `projectRepoRepository`
// resolves the same way, and for the same reason: the entity name wins, with the
// clash taken on the model rather than by filing rows under the wrong leaf.
//
// Writes require `tx`, the compile-time guarantee they run in a transaction. So
// do the READS here, which is a deliberate departure from the "reads may use the
// `db` singleton" half of the layer rule: every row of this table is gated by an
// RLS policy on `app.workspace_id`, a GUC that is bound by `withWorkspaceContext`
// on a TRANSACTION and by nothing else. A read through the bare singleton
// therefore does not fail — it returns an EMPTY LIST, which is
// indistinguishable from "this item has no repositories" and is the worse of the
// two failures by a wide margin. Requiring `tx` turns that into a type error at
// the call site. No business logic, no transactions, no DTO mapping — those
// belong in `workItemsService`.

/** A reference row joined to the `project_repository` row it points at — what a
 *  read needs to resolve a NAME without a second round trip. */
export type WorkItemRepoWithRow = Prisma.WorkItemRepoGetPayload<{
  include: { projectRepo: { include: { githubRepo: true } } };
}>;

const WITH_ROW = {
  projectRepo: { include: { githubRepo: true } },
} as const;

export const workItemRepoRepository = {
  /** One item's references, in set order (position ascending; 0 is the primary). */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemRepoWithRow[]> {
    return tx.workItemRepo.findMany({
      where: { workItemId },
      include: WITH_ROW,
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Several items' references in ONE query, in (item, position) order.
   *
   * A batched read rather than N calls to {@link listByWorkItem}, because the
   * surfaces that need this need it for a LIST — a board column, a search page, a
   * container's children. Ordering by `workItemId` first keeps the caller's
   * grouping a single pass.
   */
  async listByWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemRepoWithRow[]> {
    if (workItemIds.length === 0) return [];
    return tx.workItemRepo.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: WITH_ROW,
      orderBy: [{ workItemId: 'asc' }, { position: 'asc' }],
    });
  },

  /** Every reference to one `project_repository` row — the rollup's input when a
   *  row is renamed or removed, and the read a cross-tenant test asserts on. */
  async listByProjectRepo(
    projectRepoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemRepo[]> {
    return tx.workItemRepo.findMany({
      where: { projectRepoId },
      orderBy: [{ workItemId: 'asc' }, { position: 'asc' }],
    });
  },

  /** Drop one item's references. Paired with {@link createMany} by the service:
   *  a repository SET is replaced wholesale, never patched element by element
   *  (which is why `position` is an ordinal and not a fractional index). */
  async deleteByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.workItemRepo.deleteMany({ where: { workItemId } });
    return r.count;
  },

  /** Write one item's references. The caller supplies contiguous positions from
   *  0; `@@unique([workItemId, position])` is what makes a gap a database error
   *  rather than something a reader has to interpret. */
  async createMany(
    data: readonly Prisma.WorkItemRepoCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const r = await tx.workItemRepo.createMany({ data: [...data] });
    return r.count;
  },
};
