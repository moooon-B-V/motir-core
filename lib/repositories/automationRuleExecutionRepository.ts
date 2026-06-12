import { Prisma, type AutomationRuleExecution } from '@prisma/client';
import { db } from '@/lib/db';

// Single-op data access for the `automation_rule_execution` audit table (Story
// 6.6 · Subtask 6.6.2), per the 4-layer rule: the engine's writes require `tx`;
// the idempotency probe + the retention sweep run inside their own contexts and
// take `tx`. Business logic (when to write which status, the
// claim-then-execute ordering, the >90d cutoff) lives in
// automationEngineService — this file is leaves only. The paged per-rule READ
// the audit-log UI renders is 6.6.6's addition; this subtask writes + sweeps.

export const automationRuleExecutionRepository = {
  /** True when this (rule, event) pair already has an execution row — the
   * idempotency probe the engine runs before executing a rule's actions, so an
   * Inngest replay / retry of the same event is a no-op. Takes `tx` (it gates
   * the subsequent claim-write in the same transaction). */
  async existsByRuleAndEvent(
    ruleId: string,
    eventId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const row = await (tx ?? db).automationRuleExecution.findFirst({
      where: { ruleId, eventId },
      select: { id: true },
    });
    return row !== null;
  },

  async create(
    data: Prisma.AutomationRuleExecutionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AutomationRuleExecution> {
    return tx.automationRuleExecution.create({ data });
  },

  /** Delete a bounded batch of execution rows older than `cutoff` (the 90-day
   * retention sweep). Returns the number deleted so the system cron can loop
   * until a short batch signals "drained" (the attachment-GC cursor shape) —
   * never an unbounded single DELETE. Runs under withSystemContext (the
   * system-admin RLS branch), so `tx` is required. */
  async deleteOlderThan(
    cutoff: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.$executeRaw`
      DELETE FROM "automation_rule_execution"
      WHERE "id" IN (
        SELECT "id" FROM "automation_rule_execution"
        WHERE "created_at" < ${cutoff}
        ORDER BY "created_at" ASC
        LIMIT ${limit}
      )
    `;
    return r;
  },
};
