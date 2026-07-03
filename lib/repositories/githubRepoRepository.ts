import { type GithubRepo, type Prisma } from '@prisma/client';

// GitHub-repo repository — single Prisma operations on the `github_repo` table
// (Story 7.10 · MOTIR-891). `installationId` here is the INTERNAL
// GithubInstallation.id (a cuid), never GitHub's numeric installation id.

export interface UpsertGithubRepoInput {
  installationId: string;
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export const githubRepoRepository = {
  /** The repos selected on an installation, stable-ordered for display. Runs
   *  inside a context transaction, so it takes `tx`. */
  async listByInstallation(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { installationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Create-or-refresh one selected repo, keyed on the unique
   *  `(installation_id, repo_id)` pair. */
  async upsert(input: UpsertGithubRepoInput, tx: Prisma.TransactionClient): Promise<GithubRepo> {
    const { installationId, repoId, ...rest } = input;
    return tx.githubRepo.upsert({
      where: { installationId_repoId: { installationId, repoId } },
      create: { installationId, repoId, ...rest },
      update: rest,
    });
  },

  /** Reconcile the selected set: delete every repo on this installation whose
   *  `repo_id` is NOT in `keepRepoIds` (a de-selected repo). An empty keep set
   *  deletes them all (`NOT IN ()` is always true). Returns the delete count. */
  async deleteExcept(
    installationId: string,
    keepRepoIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({
      where: { installationId, NOT: { repoId: { in: keepRepoIds } } },
    });
    return result.count;
  },
};
