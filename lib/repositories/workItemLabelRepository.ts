import { Prisma, type WorkItemLabel } from '@prisma/client';
import { db } from '@/lib/db';

// WorkItemLabel repository — single Prisma operations on the
// `work_item_label` join table (Story 5.4 · Subtask 5.4.1). The persistence
// leaf under labelsService (5.4.2), which owns the transactions (a join
// write always rides the find-or-create / delete-on-last-use transaction),
// the per-issue cap, and the revision diff.
//
// The `@@index([labelId])` this table carries is the Epic-6 by-label filter
// edge (the join-predicate contract — see the model doc in schema.prisma)
// AND what `countByLabel` (the delete-on-last-use guard) walks.

export const workItemLabelRepository = {
  /** Attach one label to one issue. Required `tx` (see header). */
  async create(
    data: Prisma.WorkItemLabelUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemLabel> {
    return tx.workItemLabel.create({ data });
  },

  /**
   * Attach many labels in one statement (5.4.2's `setLabels` bulk add).
   * `skipDuplicates` absorbs the re-add race against the
   * `@@unique([workItemId, labelId])` key. Empty input is a no-op by
   * contract (coverage gate). Returns the inserted count.
   */
  async createMany(
    data: Prisma.WorkItemLabelCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const r = await tx.workItemLabel.createMany({ data, skipDuplicates: true });
    return r.count;
  },

  /**
   * Detach one label from one issue. `deleteMany` (not `delete`) so a
   * concurrent removal is an idempotent 0-count, not a P2025 throw — the
   * service decides what a miss means. Returns the deleted count.
   */
  async remove(workItemId: string, labelId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.workItemLabel.deleteMany({ where: { workItemId, labelId } });
    return r.count;
  },

  /**
   * Detach many labels from one issue in one statement (5.4.2's `setLabels`
   * bulk remove). Empty input is a no-op by contract (coverage gate).
   * Returns the deleted count.
   */
  async removeMany(
    workItemId: string,
    labelIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (labelIds.length === 0) return 0;
    const r = await tx.workItemLabel.deleteMany({
      where: { workItemId, labelId: { in: labelIds } },
    });
    return r.count;
  },

  /**
   * How many issues still carry a label — the delete-on-last-use guard read
   * (5.4.2 calls this AFTER `labelRepository.lockById` in the same
   * transaction, so the count can't go stale under concurrent removal).
   * `tx` REQUIRED: this read gates the label-row delete.
   */
  async countByLabel(labelId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItemLabel.count({ where: { labelId } });
  },

  /**
   * How many labels an issue carries — the per-issue-cap guard read (5.4.2's
   * cap-20 sanity guard, checked inside the add transaction). `tx` REQUIRED:
   * this read gates the join write.
   */
  async countByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItemLabel.count({ where: { workItemId } });
  },

  /**
   * The raw join rows of one issue (the diff base for `setLabels`). Optional
   * `tx` — the service reads this inside the set transaction. Insertion
   * order is irrelevant to callers (the display read is
   * `labelRepository.listByWorkItem`, name-ordered).
   */
  async listByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLabel[]> {
    const client = tx ?? db;
    return client.workItemLabel.findMany({ where: { workItemId } });
  },
};
