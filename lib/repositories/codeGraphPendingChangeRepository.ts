import type { Prisma } from '@/generated/prisma/client';

// Data access for the CHANGED PATHS a push named and a refresh has not yet
// indexed (Story MOTIR-3249 · Subtask MOTIR-3358). Single-op methods only
// (CLAUDE.md 4-layer); every write takes the caller's `tx`.
//
// ⚠️ THE DRAIN IS A CLAIM, NOT A DELETE, and that is the whole reason this is a
// table rather than a field on the refresh event. A run that claims these rows and
// then fails must NOT consume them: their files would stay stale in the graph
// forever, and nothing downstream could tell. So the shape is claim → index →
// delete-or-release, the same posture `fleet_in_flight_slot` takes.

export interface PendingChangeCreateInput {
  installationId: string;
  repoOwner: string;
  repoName: string;
  workspaceId: string;
  headSha: string | null;
  /** `added` ∪ `modified` ∪ `removed`. EMPTY means UNKNOWN — see the service. */
  paths: string[];
}

export interface PendingChangeRow {
  id: string;
  headSha: string | null;
  paths: string[];
  createdAt: Date;
}

export const codeGraphPendingChangeRepository = {
  /** Record one push's changed paths. Append-only; a repo accumulates rows until
   *  a run drains them. */
  async append(data: PendingChangeCreateInput, tx: Prisma.TransactionClient): Promise<void> {
    await tx.codeGraphPendingChange.create({ data });
  },

  /**
   * CLAIM every unclaimed row for one repo, atomically, and return what was taken.
   *
   * One statement, so two runs for the same repo cannot both take the same rows:
   * the `UPDATE … WHERE claimed_by_ref IS NULL … RETURNING` is the claim and the
   * read at once. A second caller's `UPDATE` simply matches nothing.
   *
   * Rows claimed by a run that never settled are RECLAIMED after `staleAfter` —
   * a crashed supervisor must not strand a repo's paths permanently, and the cost
   * of reclaiming early is a whole-tree sync, which is exactly what happens today.
   */
  async claimForRepo(
    key: { installationId: string; repoOwner: string; repoName: string },
    claimRef: string,
    now: Date,
    staleAfter: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PendingChangeRow[]> {
    return tx.$queryRaw<PendingChangeRow[]>`
      UPDATE "code_graph_pending_change"
         SET "claimed_by_ref" = ${claimRef}, "claimed_at" = ${now}
       WHERE "installation_id" = ${key.installationId}
         AND "repo_owner" = ${key.repoOwner}
         AND "repo_name" = ${key.repoName}
         AND ("claimed_by_ref" IS NULL OR "claimed_at" < ${staleAfter})
      RETURNING "id", "head_sha" AS "headSha", "paths", "created_at" AS "createdAt"
    `;
  },

  /** DELETE what a run claimed — the successful-index path, and the only one that
   *  consumes rows. */
  async deleteClaimed(claimRef: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.codeGraphPendingChange.deleteMany({
      where: { claimedByRef: claimRef },
    });
    return count;
  },

  /** RELEASE what a run claimed, so the next run drains it. Every non-success
   *  path, including the one where nobody remembered which path this was. */
  async releaseClaimed(claimRef: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.codeGraphPendingChange.updateMany({
      where: { claimedByRef: claimRef },
      data: { claimedByRef: null, claimedAt: null },
    });
    return count;
  },

  /** How many rows are pending for one repo — the read a test asserts on, and the
   *  one an operator asks when a repo's graph looks stale. */
  async countForRepo(
    key: { installationId: string; repoOwner: string; repoName: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.codeGraphPendingChange.count({
      where: {
        installationId: key.installationId,
        repoOwner: key.repoOwner,
        repoName: key.repoName,
      },
    });
  },
};
