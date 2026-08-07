import { randomUUID } from 'node:crypto';
import { Prisma } from '@/lib/generated/prisma/client';
import type { CiContainerWorkload } from './ciContainerUsageRepository';

// Data access for the per-period FLEET-COST rollup (Story MOTIR-1916 ·
// MOTIR-1924 · MOTIR-1995) — the table that answers "what did this org's fleet
// cost Motir in this period?" in one indexed read rather than a scan-and-sum over
// every container ever booted.
//
// It is `ciPeriodUsageRepository` one meter over, deliberately: same key, same
// upsert shape, same reasoning. Pairing the two by (organizationId, periodStart)
// is what makes margin a stored-value subtraction rather than a log analysis.
//
// ⚠️ THE KEY GAINED A THIRD COLUMN (MOTIR-1995) — (workspace, period, WORKLOAD).
// The fleet org is shared across CI runners, code-graph index containers and Epic
// 9's hosted agents, so a rollup keyed only by (workspace, period) answers the
// cheap question with three workloads added together and leaves the attributable
// one to a scan this table exists to avoid. Three rows make each line as cheap as
// the total.

/** The deltas one container's accrual or teardown contributes to its period's
 *  rollup. */
export interface CiContainerPeriodCostDelta {
  workspaceId: string;
  organizationId: string;
  periodStart: Date;
  /** WHICH line these seconds belong to — part of the rollup's key, so CI, index
   *  and agent spend never merge into one figure (MOTIR-1995). */
  workload: CiContainerWorkload;
  /**
   * ⚠️ SIGNED, and it must be (MOTIR-1995). A checkpointed container contributes
   * the DIFFERENCE between what it has now accrued and what this rollup already
   * holds for it, and that difference is NEGATIVE whenever a settle lands below
   * the last checkpoint — the container stopped between two observations, so the
   * final figure is smaller than the one already counted. Clamping it at zero
   * would leave the rollup permanently overstating a container that ran, which is
   * the one direction a COGS meter must never drift.
   */
  billableSeconds: number;
  /** Decimal STRING — never a float. See the model's `cost_usd` comment. Signed,
   *  for the same reason as the seconds beside it. */
  costUsd: string;
  /** 1 when this write CREATED the container's usage row, 0 for every later
   *  checkpoint or settle of the same container — so the count stays a count of
   *  containers rather than of observations. */
  containerCountDelta: number;
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

/** One workload's line within an org's period — the breakdown that keeps the
 *  three fleet workloads separable inside the shared fleet org. */
export interface WorkloadPeriodContainerCost {
  workload: string;
  containerSeconds: number;
  costUsd: string;
  containerCount: number;
}

/** A period's fleet cost split by whether the paying org is Motir's own — the
 *  META LINE (MOTIR-1995). Meta is metered exactly like a tenant, so this is the
 *  read that keeps its cost visible AS ITS OWN LINE rather than folded into
 *  per-customer margin. */
export interface MetaSplitContainerCost {
  /** True for the `moooon B.V.` dogfood org(s), false for paying tenants. */
  isMeta: boolean;
  workload: string;
  containerSeconds: number;
  costUsd: string;
  containerCount: number;
}

export const ciContainerPeriodCostRepository = {
  /**
   * Add one container's SIGNED delta to its (workspace, period, workload) rollup,
   * creating the row on first use.
   *
   * ONE atomic `INSERT … ON CONFLICT DO UPDATE`, for exactly the reasons
   * `ciPeriodUsageRepository.incrementForPeriod` gives: teardowns for the same
   * workspace and month are genuinely concurrent (a 31-job matrix tears down 31
   * containers at once), and both a read-then-write and a Prisma `upsert` race
   * on the unique index. `ON CONFLICT` resolves it inside the statement, and the
   * increment reads the row as it stands at write time, so no update can clobber
   * another's addition.
   *
   * ⚠️ THIS STATEMENT IS STILL A BLIND INCREMENT — the read-derivation moved one
   * table over, it did not disappear. Deciding WHAT the delta is now requires
   * reading what the container already contributed, which is a read-derived write
   * and is serialized by the lock the CALLER holds on the `ci_container_usage` row
   * (`ciContainerUsageRepository.lockAccruedState`; `notes.html` #35). By the time
   * the delta reaches this method it is a settled quantity, so no lock is needed
   * HERE — and adding one would serialize every workspace's unrelated containers
   * on a single rollup row. The lock belongs where the decision is, not where the
   * addition is.
   *
   * `container_count` adds `containerCountDelta` rather than a hardcoded 1: a
   * checkpointed container writes many times and is one container.
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
        "id", "workspace_id", "organization_id", "period_start", "workload",
        "container_seconds", "cost_usd", "container_count",
        "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()},
        ${delta.workspaceId},
        ${delta.organizationId},
        ${delta.periodStart},
        ${delta.workload},
        ${delta.billableSeconds},
        ${new Prisma.Decimal(delta.costUsd)},
        ${delta.containerCountDelta},
        NOW(),
        NOW()
      )
      ON CONFLICT ("workspace_id", "period_start", "workload") DO UPDATE SET
        "container_seconds" =
          "ci_container_period_cost"."container_seconds" + EXCLUDED."container_seconds",
        "cost_usd" = "ci_container_period_cost"."cost_usd" + EXCLUDED."cost_usd",
        "container_count" =
          "ci_container_period_cost"."container_count" + EXCLUDED."container_count",
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
   * ⚠️ THE `workload` ARGUMENT IS REQUIRED, NOT OPTIONAL-DEFAULTING-TO-ALL, and
   * that is deliberate (MOTIR-1995). An "all workloads" default is what the single
   * key used to give implicitly, and it is the wrong answer for every caller this
   * read has: the margin readout divides by the org's metered CI MINUTES, so
   * folding index or agent seconds in produces a cost-per-CI-minute figure that
   * overstates by whatever else the org ran — quietly, and worse as indexing grows.
   * A caller that genuinely wants the total asks for the breakdown below and adds
   * it up, which at least makes the addition visible.
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
    workload: CiContainerWorkload,
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
        AND "workload" = ${workload}
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

  /**
   * An org's period cost BROKEN DOWN by workload — one row per line the org
   * actually ran (MOTIR-1995).
   *
   * This is what "separable within the shared fleet org" means concretely: CI,
   * index and agent spend answered by the same indexed read that answers the
   * total, so nobody has to choose between a cheap number and an attributable one.
   *
   * Absent workloads are OMITTED rather than returned as zero rows: the rollup
   * only has rows for what ran, and inventing a zero line for `agent` before Epic
   * 9 ships would report a fact the table does not contain. Callers that want a
   * total line-set build it from {@link FLEET_WORKLOAD_KINDS} and this result.
   */
  async sumForOrgPeriodByWorkload(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<WorkloadPeriodContainerCost[]> {
    const rows = await tx.$queryRaw<
      Array<{
        workload: string;
        containerSeconds: bigint | number;
        costUsd: Prisma.Decimal;
        containerCount: bigint | number;
      }>
    >`
      SELECT
        "workload"                            AS "workload",
        COALESCE(SUM("container_seconds"), 0) AS "containerSeconds",
        COALESCE(SUM("cost_usd"), 0)          AS "costUsd",
        COALESCE(SUM("container_count"), 0)   AS "containerCount"
      FROM "ci_container_period_cost"
      WHERE "organization_id" = ${organizationId}
        AND "period_start" = ${periodStart}
      GROUP BY "workload"
      ORDER BY "workload" ASC
    `;
    return rows.map((row) => ({
      workload: row.workload,
      containerSeconds: Number(row.containerSeconds),
      costUsd: new Prisma.Decimal(row.costUsd).toFixed(),
      containerCount: Number(row.containerCount),
    }));
  },

  /**
   * A whole period's fleet cost split by META vs TENANT, per workload — the read
   * that makes Motir's own dogfood spend visible AS ITS OWN LINE (MOTIR-1995).
   *
   * ⚠️ WHY THIS READ HAS TO EXIST. MOTIR-1924's meter skipped meta orgs entirely,
   * so "meta cost" had no rows and needed no read. It cannot skip them any more:
   * meta indexing runs on the SHARED fleet (`code-graph-index-fleet.md` decision
   * 7 — the circularity test passes for indexing, unlike CI), so a bypass would
   * mean real Fly spend with no row at all, which is the unbounded-and-invisible
   * shape MOTIR-1935 was filed over. Metering meta then creates the opposite
   * hazard — its cost silently inside per-customer margin — and this split is what
   * closes it: the same rows, readable either as one population or as two.
   *
   * Cross-tenant and cross-org by construction (it is a question about Motir's own
   * infrastructure bill), so the caller runs it under `withSystemContext`.
   *
   * It JOINS `organization` rather than denormalizing `is_meta` onto the rollup:
   * `isMeta` is a property of the ORG that can be flipped by an operator, and a
   * copy on every rollup row would freeze whatever it was when the container ran —
   * so a flip would leave the two populations disagreeing with no way to tell
   * which rows are stale.
   */
  async sumForPeriodByMetaSplit(
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<MetaSplitContainerCost[]> {
    const rows = await tx.$queryRaw<
      Array<{
        isMeta: boolean;
        workload: string;
        containerSeconds: bigint | number;
        costUsd: Prisma.Decimal;
        containerCount: bigint | number;
      }>
    >`
      SELECT
        -- ⚠️ "isMeta", NOT "is_meta". Organization.isMeta carries no @map, so Prisma
        -- created the column in camelCase and it must be quoted exactly — unquoted
        -- or snake_cased it is a 42703 at runtime, invisible to tsc.
        "organization"."isMeta"                      AS "isMeta",
        "cost"."workload"                            AS "workload",
        COALESCE(SUM("cost"."container_seconds"), 0) AS "containerSeconds",
        COALESCE(SUM("cost"."cost_usd"), 0)          AS "costUsd",
        COALESCE(SUM("cost"."container_count"), 0)   AS "containerCount"
      FROM "ci_container_period_cost" AS "cost"
      JOIN "organization" ON "organization"."id" = "cost"."organization_id"
      WHERE "cost"."period_start" = ${periodStart}
      GROUP BY "organization"."isMeta", "cost"."workload"
      ORDER BY "organization"."isMeta" ASC, "cost"."workload" ASC
    `;
    return rows.map((row) => ({
      isMeta: row.isMeta,
      workload: row.workload,
      containerSeconds: Number(row.containerSeconds),
      costUsd: new Prisma.Decimal(row.costUsd).toFixed(),
      containerCount: Number(row.containerCount),
    }));
  },
};
