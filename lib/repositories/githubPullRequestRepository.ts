import { type GithubPullRequest, type Prisma } from '@prisma/client';

// GitHub pull-request repository — single Prisma operations on the
// `github_pull_request` table (Story 7.10 · MOTIR-891). `repoId` is the INTERNAL
// GithubRepo.id (a cuid). This is the PR→work-item link entity the status sync
// (MOTIR-892) + CI loop (MOTIR-894) drive; `workItemId` is nullable.

export interface UpsertGithubPullRequestInput {
  repoId: string;
  number: number;
  state: string;
  merged: boolean;
  headRef: string;
  workItemId: string | null;
}

export const githubPullRequestRepository = {
  /** One PR by its `(repo, number)` identity, or null. */
  async findByRepoAndNumber(
    repoId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest | null> {
    return tx.githubPullRequest.findUnique({ where: { repoId_number: { repoId, number } } });
  },

  /** Create-or-refresh a PR link, keyed on the unique `(repo_id, number)` pair. */
  async upsert(
    input: UpsertGithubPullRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest> {
    const { repoId, number, ...rest } = input;
    return tx.githubPullRequest.upsert({
      where: { repoId_number: { repoId, number } },
      create: { repoId, number, ...rest },
      update: rest,
    });
  },
};
