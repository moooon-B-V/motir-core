import {
  type GithubCheckRun,
  type GithubPullRequest,
  type GithubRepo,
  type Prisma,
} from '@prisma/client';
import { db } from '@/lib/db';

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
  title: string | null;
  workItemId: string | null;
}

/** A PR row with the context the Development surface renders (MOTIR-1579):
 *  its repo (owner/name for the meta line + link-out) and its check rows
 *  (the per-PR CI state derivation). */
export type GithubPullRequestWithContext = GithubPullRequest & {
  repo: GithubRepo;
  checkRuns: GithubCheckRun[];
};

export const githubPullRequestRepository = {
  /** One PR by its `(repo, number)` identity, or null. */
  async findByRepoAndNumber(
    repoId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest | null> {
    return tx.githubPullRequest.findUnique({ where: { repoId_number: { repoId, number } } });
  },

  /** The PR on a repo's head branch (`head_ref`), preferring the OPEN one — the
   *  CI-event fallback when the check payload carries no PR number list. Stable
   *  across a re-push (unlike a head SHA). Open-first, then newest, so a reused
   *  branch resolves to the live PR. */
  async findByRepoAndHeadRef(
    repoId: string,
    headRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest | null> {
    // `state` is 'open' | 'closed'; DESC puts 'open' before 'closed' so a reused
    // branch resolves to the live PR, then newest first.
    return tx.githubPullRequest.findFirst({
      where: { repoId, headRef },
      orderBy: [{ state: 'desc' }, { updatedAt: 'desc' }],
    });
  },

  /** A work item's linked PRs, newest-updated first, with the repo + check rows
   *  the Development surface renders (MOTIR-1579). Read-only path → `db`. */
  async listByWorkItemWithContext(workItemId: string): Promise<GithubPullRequestWithContext[]> {
    return db.githubPullRequest.findMany({
      where: { workItemId },
      include: { repo: true, checkRuns: true },
      orderBy: { updatedAt: 'desc' },
    });
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
