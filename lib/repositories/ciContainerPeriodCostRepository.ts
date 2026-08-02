import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

// Data access for the per-period FLEET-COST rollup (Story MOTIR-1916 ·
// MOTIR-1924) — the table that answers "what did this org's CI cost Motir in
// this period?" in one indexed read rather than a scan-and-sum over every
// container ever booted.
//
// It is `ciPeriodUsageRepository` one meter over, deliberately: same key, same
// upsert shape, same reasoning. Pairing the two by (organizationId, periodStart)
// is what makes margin a stored-value subtraction rather than a log analysis.

/** The deltas one torn-down container contributes to its period's rollup. */
export interface CiContainerPeriodCostDelta {
  workspaceId: string;
  organizationId: string;
  periodStart: Date;
  billableSeconds: number;
  /** Decimal STRING — never a float. See the model's `cost_usd` comment. */
  costUsd: string;
}

/** An org's fleet cost for one period — the margin readout's input. */
export interface OrgPeriodContainerCost {
  organizationId: string;
  periodStart: Date;
  containerSeconds: number;
  /** Decimal string, carried un-narrowed so no caller silently floats it. */
  costUsd: string;
  containerCount: number;
}

export const ciContainerPeriodCostRepository = {
  /**
   * Add one container's cost to its (workspace, period) rollup, creating the row
   * on first use.
   *
   * ONE atomic `INSERT … ON CONFLICT DO UPDATE`, for exactly the reasons
   * `ciPeriodUsageRepository.incrementForPeriod` gives: teardowns for the same
   * workspace and month are genuinely concurrent (a 31-job matrix tears down 31
   * containers at once), and both a read-then-write and a Prisma `upsert` race
   * on the unique index. `ON CONFLICT` resolves it inside the statement, and the
   * increment reads the row as it stands at write time, so no update can clobber
   * another's addition.
   *
   * No `SELECT … FOR UPDATE` is needed (the lock-before-read-derived-write rule)
   * precisely BECAUSE nothing here is read-derived: it is a blind increment, not
   * a decision made from a value that must not change under it. Nothing in this
   * card ever makes such a decision — no refusal, no debit, no balance.
   *
   * Two things raw SQL bypasses, both supplied explicitly: `@updatedAt` (hence
   * the `NOW()` assignments) and `@default(cuid())` — Prisma generates ids
   * client-side, so the INSERT binds one. UUID rather than cuid because no cuid
   * generator ships in this app's dependency set; the column is an opaque PK
   * nothing joins on by shape.
   */
  async incrementForPeriod(
    delta: CiContainerPeriodCostDelta,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "ci_container_period_cost" (
        "id", "workspace_id", "organization_id", "period_start",
        "container_seconds", "cost_usd", "container_count",
        "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()},
        ${delta.workspaceId},
        ${delta.organizationId},
        ${delta.periodStart},
        ${delta.billableSeconds},
        ${new Prisma.Decimal(delta.costUsd)},
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT ("workspace_id", "period_start") DO UPDATE SET
        "container_seconds" =
          "ci_container_period_cost"."container_seconds" + EXCLUDED."container_seconds",
        "cost_usd" = "ci_container_period_cost"."cost_usd" + EXCLUDED."cost_usd",
        "container_count" = "ci_container_period_cost"."container_count" + 1,
        "updated_at" = NOW()
    `;
  },

  /**
   * An ORG's fleet cost for one period — the single indexed read the margin
   * readout consumes.
   *
   * The rollup is keyed by workspace (the shipped tenancy contract) but the
   * question is org-level, so this SUMs the org's rows for that ONE period —
   * bounded by the org's workspace count and served entirely by
   * `ci_container_period_cost_organization_id_period_start_idx`.
   *
   * `periodStart` is bound as a JS `Date` rather than derived in SQL: the period
   * is computed in application code from the container's own stop instant, and
   * letting the DB derive it would reintroduce server-vs-database clock skew.
   *
   * `tx` is REQUIRED, unlike `ciPeriodUsageRepository.sumForOrgPeriod`'s optional
   * one — every caller of this read is inside a `withSystemContext`, because the
   * rows are RLS-gated and there is no session workspace to read them under.
   * An optional client would be an untested path that could only ever return
   * nothing in production.
   */
  async sumForOrgPeriod(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<OrgPeriodContainerCost> {
    const rows = await tx.$queryRaw<
      Array<{
        containerSeconds: bigint | number;
        costUsd: Prisma.Decimal;
        containerCount: bigint | number;
      }>
    >`
      SELECT
        COALESCE(SUM("container_seconds"), 0) AS "containerSeconds",
        COALESCE(SUM("cost_usd"), 0)          AS "costUsd",
        COALESCE(SUM("container_count"), 0)   AS "containerCount"
      FROM "ci_container_period_cost"
      WHERE "organization_id" = ${organizationId}
        AND "period_start" = ${periodStart}
    `;
    // A COALESCE'd aggregate with no GROUP BY always returns EXACTLY one row —
    // zeros when nothing matched — so this index is total and the method can
    // promise a cost figure rather than a nullable one.
    const row = rows[0]!;
    return {
      organizationId,
      periodStart,
      containerSeconds: Number(row.containerSeconds),
      costUsd: new Prisma.Decimal(row.costUsd).toFixed(),
      containerCount: Number(row.containerCount),
    };
  },
};
