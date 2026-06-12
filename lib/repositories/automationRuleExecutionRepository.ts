import {
  Prisma,
  type AutomationRuleExecution,
  type AutomationExecutionStatus,
} from '@prisma/client';
import { db } from '@/lib/db';

/** A rule execution joined to the triggering item's key + title (the audit-log
 * read shape). `workItem` is null when the item was deleted after the run
 * (`work_item_id` is `SetNull` on delete). */
export type AutomationRuleExecutionWithItem = Prisma.AutomationRuleExecutionGetPayload<{
  include: { workItem: { select: { identifier: true; title: true } } };
}>;

/** The latest-execution row per rule (the list's last-run glyph) — just the
 * status + time, keyed by rule. */
export interface LatestExecutionRow {
  ruleId: string;
  status: AutomationExecutionStatus;
  createdAt: Date;
}

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

  /** One bounded page of a rule's execution log, newest-first, with the
   * triggering item's identifier + title joined (null when the item was
   * deleted). Read-only (the audit-log UI read, 6.6.6) so it uses the `db`
   * singleton; rides the `[ruleId, createdAt]` index. The service has already
   * resolved + admin-gated the rule, so this takes a plain `ruleId`. */
  async listByRule(
    ruleId: string,
    opts: { skip: number; take: number },
  ): Promise<AutomationRuleExecutionWithItem[]> {
    return db.automationRuleExecution.findMany({
      where: { ruleId },
      orderBy: { createdAt: 'desc' },
      skip: opts.skip,
      take: opts.take,
      include: { workItem: { select: { identifier: true, title: true } } },
    });
  },

  /** Total execution rows for a rule — the audit-log pager's `total`. Read-only
   * (uses the `db` singleton). */
  async countByRule(ruleId: string): Promise<number> {
    return db.automationRuleExecution.count({ where: { ruleId } });
  },

  /** The latest execution per rule across a set of rule ids — the list's
   * last-run glyph (6.6.6). One row per rule via `DISTINCT ON (rule_id)`
   * ordered newest-first, served by the `[ruleId, createdAt]` index. Empty
   * input short-circuits to `[]` (no SQL). Read-only (the `db` singleton);
   * the caller has already admin-gated the project whose rules these are. */
  async findLatestByRuleIds(ruleIds: string[]): Promise<LatestExecutionRow[]> {
    if (ruleIds.length === 0) return [];
    return db.$queryRaw<LatestExecutionRow[]>`
      SELECT DISTINCT ON ("rule_id")
        "rule_id" AS "ruleId", "status", "created_at" AS "createdAt"
      FROM "automation_rule_execution"
      WHERE "rule_id" IN (${Prisma.join(ruleIds)})
      ORDER BY "rule_id", "created_at" DESC
    `;
  },
};
