import { randomUUID } from 'node:crypto';
import { Prisma, type CiPeriodUsage } from '@/lib/generated/prisma/client';
import { db } from '@/lib/db';

// Data access for the per-period CI-consumption ROLLUP (Story MOTIR-1775 ·
// MOTIR-1896) — the table the allowance sibling (MOTIR-1901) reads to answer
// "how many Linux-equivalent minutes has org X used this period?" in one indexed
// query rather than a scan-and-sum over all metered history.

/** The deltas one metered run contributes to its period's rollup. */
export interface CiPeriodUsageDelta {
  workspaceId: string;
  organizationId: string;
  periodStart: Date;
  billableMinutes: number;
  rawWallClockSeconds: number;
  linearEquivalentMinutes: number;
}

/** An org's consumption for one period — the meter's whole public surface to
 *  the allowance sibling (`ci-minutes-allowance.md` §Consequences: "the seam
 *  between them is one read"). */
export interface OrgPeriodConsumption {
  organizationId: string;
  periodStart: Date;
  linearEquivalentMinutes: number;
  billableMinutes: number;
  runCount: number;
}

export const ciPeriodUsageRepository = {
  /**
   * Add one run's usage to its (workspace, period) rollup, creating the row on
   * first use.
   *
   * ONE atomic `INSERT … ON CONFLICT DO UPDATE`, deliberately, rather than a
   * read-then-write or a Prisma `upsert`. Deliveries for the same workspace and
   * month are genuinely CONCURRENT — several repos, several PRs, GitHub's own
   * retries — and both alternatives race: a Prisma `upsert` issues a SELECT then
   * an INSERT, so two callers can both miss the row and one loses on the unique
   * index. `ON CONFLICT` resolves that inside the statement, and the increment
   * reads `ci_period_usage.<col> + EXCLUDED.<col>` from the row as it stands at
   * write time, so no update can clobber another's addition.
   *
   * This needs no `SELECT … FOR UPDATE` (the shipped lock-before-read-derived-
   * write rule) precisely BECAUSE nothing here is read-derived: it is a blind
   * increment, not a decision made from a value that must not change under it.
   * The decision that IS read-derived — "is this org over its pool?" — belongs to
   * MOTIR-1901, and the ADR requires it to lock and re-read inside its own
   * transaction.
   *
   * Two things raw SQL bypasses, both supplied explicitly here: `@updatedAt`
   * (hence the `NOW()` assignments) and `@default(cuid())` — Prisma generates
   * ids client-side, so the INSERT binds one. It is a UUID rather than a cuid
   * because no cuid generator ships in this app's dependency set; the column is
   * an opaque PK nothing joins on by shape, and the model keeps its `cuid()`
   * default for any future Prisma-path insert.
   */
  async incrementForPeriod(
    delta: CiPeriodUsageDelta,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "ci_period_usage" (
        "id", "workspace_id", "organization_id", "period_start",
        "linear_equivalent_minutes", "billable_minutes", "raw_wall_clock_seconds",
        "run_count", "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()},
        ${delta.workspaceId},
        ${delta.organizationId},
        ${delta.periodStart},
        ${new Prisma.Decimal(delta.linearEquivalentMinutes)},
        ${delta.billableMinutes},
        ${new Prisma.Decimal(delta.rawWallClockSeconds)},
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT ("workspace_id", "period_start") DO UPDATE SET
        "linear_equivalent_minutes" =
          "ci_period_usage"."linear_equivalent_minutes" + EXCLUDED."linear_equivalent_minutes",
        "billable_minutes" =
          "ci_period_usage"."billable_minutes" + EXCLUDED."billable_minutes",
        "raw_wall_clock_seconds" =
          "ci_period_usage"."raw_wall_clock_seconds" + EXCLUDED."raw_wall_clock_seconds",
        "run_count" = "ci_period_usage"."run_count" + 1,
        "updated_at" = NOW()
    `;
  },

  /** One workspace's rollup row for a period, or null before its first run. */
  async findByWorkspaceAndPeriod(
    workspaceId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<CiPeriodUsage | null> {
    return tx.ciPeriodUsage.findUnique({
      where: { workspaceId_periodStart: { workspaceId, periodStart } },
    });
  },

  /**
   * An ORG's consumption for one period — the single indexed read MOTIR-1901
   * consumes.
   *
   * The pool is org-level (§4.1) but the rollup is keyed by workspace (the
   * shipped tenancy contract), so this SUMs the org's rows for that ONE period.
   * That is bounded by the org's workspace count and served entirely by
   * `ci_period_usage_organization_id_period_start_idx` — still a single indexed
   * query, never a history scan, which is exactly what the acceptance asks for.
   *
   * `periodStart` is bound as a JS `Date` rather than compared against SQL
   * `NOW()`/`date_trunc`: the period is computed in application code from the
   * run's own timestamp (§4.5), and letting the DB derive it would reintroduce
   * the server-vs-database clock skew that binding a Date avoids.
   */
  async sumForOrgPeriod(
    organizationId: string,
    periodStart: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<OrgPeriodConsumption> {
    const client = tx ?? db;
    const rows = await client.$queryRaw<
      Array<{
        linearEquivalentMinutes: Prisma.Decimal;
        billableMinutes: bigint | number;
        runCount: bigint | number;
      }>
    >`
      SELECT
        COALESCE(SUM("linear_equivalent_minutes"), 0) AS "linearEquivalentMinutes",
        COALESCE(SUM("billable_minutes"), 0)          AS "billableMinutes",
        COALESCE(SUM("run_count"), 0)                 AS "runCount"
      FROM "ci_period_usage"
      WHERE "organization_id" = ${organizationId}
        AND "period_start" = ${periodStart}
    `;
    // A COALESCE'd aggregate with no GROUP BY always returns EXACTLY one row —
    // zeros when nothing matched — so this index is total and needs no empty
    // case. That is also why the method can promise a consumption figure rather
    // than a nullable one: MOTIR-1901 never has to handle "no row yet".
    const row = rows[0]!;
    return {
      organizationId,
      periodStart,
      linearEquivalentMinutes: Number(row.linearEquivalentMinutes),
      billableMinutes: Number(row.billableMinutes),
      runCount: Number(row.runCount),
    };
  },
};
