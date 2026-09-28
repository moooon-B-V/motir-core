import type { DispatchRunGitCredential, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run_git_credential` — the GitHub
// installation tokens a hosted run was handed (Story MOTIR-683 · MOTIR-6449,
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5).
//
// `tx` on every method, reads included: the table is RLS-gated on
// `app.workspace_id`, and a read outside a bound transaction returns an empty
// list rather than an error — which here would read as "this run holds no token"
// and skip a revoke.
//
// The token column is ENCRYPTED; this layer never decrypts it. No business logic,
// no transactions, no DTO mapping — those are `lib/github/runGitCredential.ts`'s.

/** The fields a recorded token is written with. Named here so the service never
 *  names the generated client's projection type. */
export type DispatchRunGitCredentialCreateInput = Prisma.DispatchRunGitCredentialCreateManyInput;

export const dispatchRunGitCredentialRepository = {
  /** Every token one mint produced, written in one op. */
  async createMany(
    data: DispatchRunGitCredentialCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const r = await tx.dispatchRunGitCredential.createMany({ data });
    return r.count;
  },

  /** Every token recorded for a run, oldest first. */
  async listByRun(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunGitCredential[]> {
    return tx.dispatchRunGitCredential.findMany({
      where: { dispatchRunId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Delete the given rows (the ones the revoke has dealt with). */
  async deleteByIds(ids: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await tx.dispatchRunGitCredential.deleteMany({ where: { id: { in: [...ids] } } });
    return r.count;
  },
};
