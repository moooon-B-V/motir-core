import { Prisma, type AutomationRule } from '@prisma/client';
import { db } from '@/lib/db';

// Single-op data access for the `automation_rule` table (Story 6.6 · Subtask
// 6.6.1), per the 4-layer rule: writes require `tx`; reads that guard a write
// (the cap count, the lock) take `tx`; the plain list/get reads use the `db`
// singleton. Business logic, transactions, and DTO mapping live in
// automationRulesService — this file is leaves only.

/** A rule joined to the owner fields the DTO needs (id + name). */
export type AutomationRuleWithOwner = Prisma.AutomationRuleGetPayload<{
  include: { owner: { select: { id: true; name: true } } };
}>;

const withOwner = {
  owner: { select: { id: true, name: true } },
} satisfies Prisma.AutomationRuleInclude;

export const automationRuleRepository = {
  /** Read one rule (owner included) scoped to its project — the per-rule gate.
   * A rule in another project / workspace returns null (the 404 is the
   * service's, off this null). */
  async findByIdInProject(
    id: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AutomationRuleWithOwner | null> {
    return (tx ?? db).automationRule.findFirst({
      where: { id, projectId },
      include: withOwner,
    });
  },

  /** List a project's rules (owner included), newest first — bounded by the
   * 100-rule per-project cap (finding #57: the cap IS the bound, no unbounded
   * read possible). */
  async listByProject(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AutomationRuleWithOwner[]> {
    return (tx ?? db).automationRule.findMany({
      where: { projectId },
      include: withOwner,
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Count a project's rules — the create cap guard. Takes `tx` (it gates a
   * subsequent write in the same transaction). */
  async countByProject(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.automationRule.count({ where: { projectId } });
  },

  /** Lock one rule row FOR UPDATE inside a transaction — the update / enable /
   * delete paths take it before the read-derived write (the
   * lock-before-read-derived-update rule), scoped to its project. Returns the
   * id when present, null otherwise. */
  async lockByIdInProject(
    id: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "automation_rule"
      WHERE "id" = ${id} AND "project_id" = ${projectId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async create(
    data: Prisma.AutomationRuleUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AutomationRuleWithOwner> {
    return tx.automationRule.create({ data, include: withOwner });
  },

  async update(
    id: string,
    data: Prisma.AutomationRuleUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AutomationRuleWithOwner> {
    return tx.automationRule.update({ where: { id }, data, include: withOwner });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<AutomationRule> {
    return tx.automationRule.delete({ where: { id } });
  },
};
