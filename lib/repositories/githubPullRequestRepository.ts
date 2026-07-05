import {
  type GithubCheckRun,
  type GithubInstallation,
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
  /** Whether this link is the manual override (MOTIR-1596). The webhook passes
   *  the row's PRESERVED value so an auto delivery never clears a manual link. */
  linkedManually: boolean;
}

/** A PR row with the context the Development surface renders (MOTIR-1579):
 *  its repo (owner/name for the meta line + link-out) and its check rows
 *  (the per-PR CI state derivation). */
export type GithubPullRequestWithContext = GithubPullRequest & {
  repo: GithubRepo;
  checkRuns: GithubCheckRun[];
};

/** A PR row with its repo AND the parent installation — the workspace-tenancy
 *  chain the explicit-link service validates (installation → repo → PR), plus
 *  the check rows the returned DTO needs (MOTIR-1596). */
export type GithubPullRequestWithInstallation = GithubPullRequestWithContext & {
  repo: GithubRepo & { installation: GithubInstallation };
};

/** A PR candidate for the explicit-link picker (MOTIR-1596): its repo (for the
 *  `owner/name · #n` option meta) and — when already linked — the target item's
 *  identifier (the neutral "Linked to MOTIR-<n>" takeover chip). */
export type GithubPullRequestCandidate = GithubPullRequest & {
  repo: GithubRepo;
  workItem: { identifier: string } | null;
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

  /** Take a row lock on the `(repo, number)` PR (if it exists) so a read-derived
   *  write serializes against a concurrent manual link (MOTIR-1596): the webhook
   *  decides whether to PRESERVE an existing manual link, so it must lock the row
   *  before reading `linkedManually` — otherwise a manual link committed between
   *  the read and the upsert would be silently clobbered (the lock-before-read-
   *  derived-update rule). A no-op when the row does not exist yet (a brand-new
   *  PR; the upsert's P2002 catch still converges concurrent inserts). */
  async lockByRepoAndNumber(
    repoId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_pull_request WHERE repo_id = ${repoId} AND number = ${number} FOR UPDATE`;
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

  /** Count a work item's OTHER linked PRs (excluding `excludePrId`) that are
   *  still OPEN (`state = 'open'`). The status sync uses this so a merge only
   *  COMPLETES the item when it is the item's LAST open linked PR: a cross-repo
   *  (two-PR) card must not flip Done while a sibling PR is still open
   *  (MOTIR-1604). A read guarding the transition write → takes `tx`. */
  async countOtherOpenByWorkItem(
    workItemId: string,
    excludePrId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.githubPullRequest.count({
      where: { workItemId, state: 'open', id: { not: excludePrId } },
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

  /** One PR by its internal id, with its repo + parent installation (the
   *  workspace-tenancy chain the explicit-link service validates) + check rows
   *  (the returned DTO). Read guarding a write → takes `tx`. Null when absent. */
  async findByIdWithInstallation(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithInstallation | null> {
    return tx.githubPullRequest.findUnique({
      where: { id },
      include: { repo: { include: { installation: true } }, checkRuns: true },
    });
  },

  /** Candidate PRs for the explicit-link picker (MOTIR-1596): the workspace's
   *  ingested PRs (installation → repo → PR), matched by title / repo owner+name
   *  / number, newest-updated first, bounded to `take`. Includes each PR's repo
   *  and — when already linked — the target item's identifier (the takeover
   *  chip). Read-only path → `db`; `workspaceId` is the explicit tenant gate
   *  (finding #26 — RLS is inert under the dev/CI superuser). */
  async searchCandidates(
    workspaceId: string,
    query: string,
    take: number,
  ): Promise<GithubPullRequestCandidate[]> {
    const trimmed = query.trim();
    const asNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const match: Prisma.GithubPullRequestWhereInput[] = [
      { title: { contains: trimmed, mode: 'insensitive' } },
      { repo: { is: { owner: { contains: trimmed, mode: 'insensitive' } } } },
      { repo: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
    ];
    if (asNumber !== null && Number.isSafeInteger(asNumber)) match.push({ number: asNumber });
    return db.githubPullRequest.findMany({
      where: { repo: { is: { installation: { is: { workspaceId } } } }, OR: match },
      include: { repo: true, workItem: { select: { identifier: true } } },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },

  /** Set a PR's `workItemId` as the MANUAL override (MOTIR-1596) — stamps
   *  `linkedManually = true` so the webhook never clears it from the branch/title
   *  parse. Returns the row with its context for the DTO. Write path → `tx`. */
  async setWorkItemLink(
    id: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithInstallation> {
    return tx.githubPullRequest.update({
      where: { id },
      data: { workItemId, linkedManually: true },
      include: { repo: { include: { installation: true } }, checkRuns: true },
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
