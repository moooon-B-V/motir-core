import { Prisma, type AutomationRule, type AutomationTriggerType } from '@prisma/client';
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

  /** The engine's hot read (Subtask 6.6.2): a project's ENABLED rules for one
   * trigger type, owner included, oldest first so a project's rules fire in a
   * stable, author-order sequence. Rides the `[projectId, triggerType, enabled]`
   * index. Bounded by the per-project rule cap. */
  async listEnabledByProjectAndTrigger(
    projectId: string,
    triggerType: AutomationTriggerType,
    tx?: Prisma.TransactionClient,
  ): Promise<AutomationRuleWithOwner[]> {
    return (tx ?? db).automationRule.findMany({
      where: { projectId, triggerType, enabled: true },
      include: withOwner,
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Count a project's rules — the create cap guard. Takes `tx` (it gates a
   * subsequent write in the same transaction). */
  async countByProject(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.automationRule.count({ where: { projectId } });
  },

  /** Lock one rule's failure state FOR UPDATE inside a transaction (Subtask
   * 6.6.2) — the engine reads the current counter + enabled flag under the lock
   * before deriving the next values (the lock-before-read-derived-update rule),
   * so two concurrent runs of the same rule can't lose an increment. Returns
   * null when the rule was deleted between the run and the audit write. */
  async lockFailureState(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ consecutiveFailureCount: number; enabled: boolean } | null> {
    const rows = await tx.$queryRaw<Array<{ consecutiveFailureCount: number; enabled: boolean }>>`
      SELECT "consecutive_failure_count" AS "consecutiveFailureCount", "enabled"
      FROM "automation_rule"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
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
