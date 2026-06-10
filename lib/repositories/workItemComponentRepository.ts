import { Prisma, type WorkItemComponent } from '@prisma/client';
import { db } from '@/lib/db';

// WorkItemComponent repository — single Prisma operations on the
// `work_item_component` join table (Story 5.4 · Subtask 5.4.1). The
// persistence leaf under componentsService (5.4.3), which owns the
// transactions, the same-project validation, the move-or-remove delete
// flow, and the revision diff.
//
// The `@@index([componentId])` is the Epic-6 by-component filter edge (the
// join-predicate contract — see the model doc in schema.prisma); it also
// serves `countByComponent` (the delete dialog) and `reassignItems` (the
// move branch). `componentId` is RESTRICT at the DB — the move-or-remove
// flow must empty the joins before `componentRepository.delete` succeeds.

export const workItemComponentRepository = {
  /** Attach one component to one issue. Required `tx`. */
  async create(
    data: Prisma.WorkItemComponentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemComponent> {
    return tx.workItemComponent.create({ data });
  },

  /**
   * Attach many components in one statement (5.4.3's `setComponents` bulk
   * add — also the create-issue path, which persists the picker's selection
   * inside `createWorkItem`'s transaction). `skipDuplicates` absorbs the
   * re-add race against the `@@unique([workItemId, componentId])` key.
   * Empty input is a no-op by contract (coverage gate). Returns the
   * inserted count.
   */
  async createMany(
    data: Prisma.WorkItemComponentCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const r = await tx.workItemComponent.createMany({ data, skipDuplicates: true });
    return r.count;
  },

  /**
   * Detach one component from one issue. `deleteMany` so a concurrent
   * removal is an idempotent 0-count, not a P2025 throw. Returns the
   * deleted count.
   */
  async remove(
    workItemId: string,
    componentId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.workItemComponent.deleteMany({ where: { workItemId, componentId } });
    return r.count;
  },

  /**
   * Detach many components from one issue in one statement (5.4.3's
   * `setComponents` bulk remove). Empty input is a no-op by contract
   * (coverage gate). Returns the deleted count.
   */
  async removeMany(
    workItemId: string,
    componentIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (componentIds.length === 0) return 0;
    const r = await tx.workItemComponent.deleteMany({
      where: { workItemId, componentId: { in: componentIds } },
    });
    return r.count;
  },

  /**
   * How many issues carry a component — the admin list / delete dialog
   * count and the in-use check. Optional `tx`: the delete flow re-derives
   * it inside the transaction (after `componentRepository.lockById`), the
   * admin list reads it bare.
   */
  async countByComponent(componentId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? db;
    return client.workItemComponent.count({ where: { componentId } });
  },

  /**
   * The MOVE branch of the move-or-remove delete (5.4.3, the verified Jira
   * flow): repoint every join row from `fromId` to `toId` in ONE statement,
   * SKIPPING issues that already carry the target (the duplicate-join skip
   * — repointing those would violate the `@@unique([workItemId,
   * componentId])` key; the service drops the leftovers via
   * `deleteByComponent` in the same transaction). Single `$executeRaw`
   * UPDATE (one Prisma op — the repository rule allows raw single
   * statements; `updateMany` can't express the NOT EXISTS skip). Returns
   * the moved count. `tx` REQUIRED.
   */
  async reassignItems(fromId: string, toId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      UPDATE "work_item_component" wic
      SET "component_id" = ${toId}
      WHERE wic."component_id" = ${fromId}
        AND NOT EXISTS (
          SELECT 1 FROM "work_item_component" t
          WHERE t."work_item_id" = wic."work_item_id"
            AND t."component_id" = ${toId}
        )
    `;
  },

  /**
   * Drop every join row still pointing at a component — the REMOVE branch
   * of move-or-remove, and the move branch's duplicate-leftover sweep
   * (issues untouched either way; only the association goes). Returns the
   * deleted count. `tx` REQUIRED.
   */
  async deleteByComponent(componentId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.workItemComponent.deleteMany({ where: { componentId } });
    return r.count;
  },

  /**
   * The raw join rows of one issue (the diff base for `setComponents`).
   * Optional `tx` — the service reads this inside the set transaction.
   */
  async listByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemComponent[]> {
    const client = tx ?? db;
    return client.workItemComponent.findMany({ where: { workItemId } });
  },
};
