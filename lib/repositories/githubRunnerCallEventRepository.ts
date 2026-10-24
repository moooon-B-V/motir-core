import type { GithubRunnerCallKind, Prisma } from '@/generated/prisma/client';

// Data access for the GITHUB RUNNER-CALL LEDGER (Story MOTIR-8953 · MOTIR-8969) —
// one row per runner mint or delete that reached GitHub, keyed on the RUNNER'S
// GitHub org. Platform bookkeeping with no workspace; the table's policy is
// `app.system_admin` only, so the caller holds a `withSystemContext` transaction.

export const githubRunnerCallEventRepository = {
  async record(
    githubOrg: string,
    kind: GithubRunnerCallKind,
    at: Date,
    fleetShardId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.githubRunnerCallEvent.create({
      data: { githubOrg: githubOrg.trim().toLowerCase(), kind, at, fleetShardId },
    });
  },

  /** The org's calls of these kinds in `(since, until]`. */
  async countSince(
    githubOrg: string,
    kinds: readonly GithubRunnerCallKind[],
    since: Date,
    until: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.githubRunnerCallEvent.count({
      where: {
        githubOrg: githubOrg.trim().toLowerCase(),
        kind: { in: [...kinds] },
        at: { gt: since, lte: until },
      },
    });
  },

  /** Every org with a call after `since`. */
  async listOrgsSince(since: Date, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.githubRunnerCallEvent.findMany({
      where: { at: { gt: since } },
      distinct: ['githubOrg'],
      select: { githubOrg: true },
      orderBy: { githubOrg: 'asc' },
    });
    return rows.map((row) => row.githubOrg);
  },

  /** The accounts whose machines made the org's calls after `since`. */
  async listShardIdsSince(
    githubOrg: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.githubRunnerCallEvent.findMany({
      where: {
        githubOrg: githubOrg.trim().toLowerCase(),
        at: { gt: since },
        NOT: { fleetShardId: null },
      },
      distinct: ['fleetShardId'],
      select: { fleetShardId: true },
    });
    return rows.map((row) => row.fleetShardId!).sort();
  },

  async deleteOlderThan(cutoff: Date, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.githubRunnerCallEvent.deleteMany({ where: { at: { lt: cutoff } } });
    return count;
  },
};
