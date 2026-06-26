import { Prisma, type PlanItem } from '@prisma/client';
import { db } from '@/lib/db';

// PlanItem repository — single Prisma operations on the `plan_item` table
// (Story 7.21 · MOTIR-1336). Writes require `tx`; pure reads use the `db`
// singleton. No business logic, no transactions, no DTO mapping.
export const planItemRepository = {
  async create(
    data: Prisma.PlanItemUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.create({ data });
  },

  /** A plan's proposal items in append order (createdAt asc, id asc). Optional
   *  `tx` joins a surrounding transaction (the materialize read in approve). */
  async findByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<PlanItem[]> {
    const client = tx ?? db;
    return client.planItem.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  async countByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? db;
    return client.planItem.count({ where: { planId } });
  },

  /** Item counts for a set of plans in one grouped query — the list view's
   *  `itemCount` without an N+1. Returns a `planId → count` map. */
  async countByPlanIds(
    planIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (planIds.length === 0) return new Map();
    const client = tx ?? db;
    const rows = await client.planItem.groupBy({
      by: ['planId'],
      where: { planId: { in: planIds } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.planId, r._count._all]));
  },

  /** A single PlanItem by id. Optional `tx` joins a surrounding transaction
   *  (the proposal-edit path re-reads the item under the plan lock). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<PlanItem | null> {
    const client = tx ?? db;
    return client.planItem.findUnique({ where: { id } });
  },

  /** Edit a PlanItem's mutable JSON/columns in place — the proposal-edit path
   *  (7.21.6 · MOTIR-1370) patches an `add`'s `proposedFields` while the plan is
   *  `planned`. A write, so `tx` is required. */
  async update(
    id: string,
    data: Prisma.PlanItemUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data });
  },

  /** Write the materialized work-item id back onto an `add` PlanItem (approve). */
  async setWorkItemId(
    id: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data: { workItemId } });
  },

  /** Drop every PlanItem in a plan — the decline path (the tree was never
   *  touched, so this is a clean no-op on the work-item tree). */
  async deleteByPlan(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planItem.deleteMany({ where: { planId } });
    return r.count;
  },
};
