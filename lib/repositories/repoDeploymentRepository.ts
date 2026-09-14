import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';

// Single-op data access for `repo_deployment` — the preview deployments a
// repository's own host reports (Story MOTIR-4906 · Subtask MOTIR-5329).
//
// Writes run under withSystemContext from the webhook services (a delivery has
// no tenant session); reads run under the reader's workspace context. Both
// take `tx`, which is what binds the GUC the table's policies read.

/** One stored deployment status, as every read returns it. */
export interface RepoDeploymentRow {
  id: string;
  workspaceId: string;
  repoId: string;
  provider: string;
  providerDeploymentId: string;
  commitSha: string;
  ref: string;
  environment: string;
  state: string;
  environmentUrl: string | null;
  occurredAt: Date;
}

/** What one delivery writes. `environmentUrl` must already be sanitised. */
export interface RepoDeploymentUpsert {
  workspaceId: string;
  repoId: string;
  provider: string;
  providerDeploymentId: string;
  commitSha: string;
  ref: string;
  environment: string;
  state: string;
  environmentUrl: string | null;
  occurredAt: Date;
}

const SELECT_COLUMNS = `
  "id", "workspace_id" AS "workspaceId", "repo_id" AS "repoId", "provider",
  "provider_deployment_id" AS "providerDeploymentId", "commit_sha" AS "commitSha",
  "ref", "environment", "state", "environment_url" AS "environmentUrl",
  "occurred_at" AS "occurredAt"`;

export const repoDeploymentRepository = {
  /**
   * Record one deployment status, ONE atomic statement.
   *
   * ⚠️ THE OUT-OF-ORDER GUARD LIVES IN THE STATEMENT, NOT IN A READ BEFORE IT.
   * GitHub does not guarantee delivery order, so a late `in_progress` can arrive
   * after the `success` it preceded. The conflict arm updates ONLY when the
   * stored status is not newer (`occurred_at <= EXCLUDED.occurred_at`); an older
   * delivery matches no row, RETURNING yields nothing, and the caller reports
   * `stale`. A read-then-write would race two deliveries for the same deployment
   * — this cannot, because the unique index serialises the conflict inside the
   * statement.
   *
   * A re-delivery of the same status (equal `occurred_at`) rewrites identical
   * values and still leaves one row.
   *
   * Returns the row id, or `null` when the delivery was older than what is stored.
   * `@default(cuid())` and `@updatedAt` are Prisma-side, so the INSERT supplies
   * both (the `ciContainerPeriodCostRepository` precedent: a UUID for the PK).
   */
  async upsertIfNotOlder(
    input: RepoDeploymentUpsert,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "repo_deployment" (
        "id", "workspace_id", "repo_id", "provider", "provider_deployment_id",
        "commit_sha", "ref", "environment", "state", "environment_url",
        "occurred_at", "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.repoId}, ${input.provider},
        ${input.providerDeploymentId}, ${input.commitSha}, ${input.ref},
        ${input.environment}, ${input.state}, ${input.environmentUrl},
        ${input.occurredAt}, NOW(), NOW()
      )
      ON CONFLICT ("repo_id", "provider", "provider_deployment_id") DO UPDATE SET
        "commit_sha" = EXCLUDED."commit_sha",
        "ref" = EXCLUDED."ref",
        "environment" = EXCLUDED."environment",
        "state" = EXCLUDED."state",
        "environment_url" = EXCLUDED."environment_url",
        "occurred_at" = EXCLUDED."occurred_at",
        "updated_at" = NOW()
      WHERE "repo_deployment"."occurred_at" <= EXCLUDED."occurred_at"
      RETURNING "id"
    `;
    return rows[0]?.id ?? null;
  },

  /**
   * The LATEST status per `(repoId, commitSha, environment)` for a batch of
   * `(repoId, commitSha)` pairs — ONE query however many pairs. The HOW TO TEST
   * read (MOTIR-5333) keys a pull request's preview on its head commit.
   */
  async listLatestByCommits(
    pairs: ReadonlyArray<{ repoId: string; commitSha: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<RepoDeploymentRow[]> {
    if (pairs.length === 0) return [];
    const repoIds = pairs.map((p) => p.repoId);
    const shas = pairs.map((p) => p.commitSha);
    return tx.$queryRawUnsafe<RepoDeploymentRow[]>(
      `SELECT DISTINCT ON ("repo_id", "commit_sha", "environment") ${SELECT_COLUMNS}
         FROM "repo_deployment"
        WHERE ("repo_id", "commit_sha") IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )
        ORDER BY "repo_id", "commit_sha", "environment", "occurred_at" DESC, "updated_at" DESC`,
      repoIds,
      shas,
    );
  },

  /**
   * The LATEST status per `(repoId, ref, environment)` for a batch of
   * `(repoId, ref)` pairs — ONE query. The read falls back to this when a pull
   * request's head commit is not yet known (no check has reported), because
   * `github_pull_request` stores the head REF but no head sha.
   */
  async listLatestByRefs(
    pairs: ReadonlyArray<{ repoId: string; ref: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<RepoDeploymentRow[]> {
    if (pairs.length === 0) return [];
    const repoIds = pairs.map((p) => p.repoId);
    const refs = pairs.map((p) => p.ref);
    return tx.$queryRawUnsafe<RepoDeploymentRow[]>(
      `SELECT DISTINCT ON ("repo_id", "ref", "environment") ${SELECT_COLUMNS}
         FROM "repo_deployment"
        WHERE ("repo_id", "ref") IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )
        ORDER BY "repo_id", "ref", "environment", "occurred_at" DESC, "updated_at" DESC`,
      repoIds,
      refs,
    );
  },
};
