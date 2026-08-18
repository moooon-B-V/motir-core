import {
  type GithubCheckRun,
  type GithubInstallation,
  type GithubPullRequest,
  type GithubRepo,
  type Prisma,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';

// GitHub pull-request repository — single Prisma operations on the
// `github_pull_request` table (Story 7.10 · MOTIR-891). `repoId` is the INTERNAL
// GithubRepo.id (a cuid). This is the PR→work-item link entity the status sync
// (MOTIR-892) + CI loop (MOTIR-894) drive; `workItemId` is nullable.

export interface UpsertGithubPullRequestInput {
  /** The host discriminator — 'github' | 'gitlab' (Story 7.23 · MOTIR-1475). The
   *  shared status sync stamps it from the connection's provider so the
   *  Development surface renders the right host mark; GitHub rows carry the
   *  column default. */
  provider: string;
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

/** A PR row with just its repo — what a path-intersection reader needs to name
 *  the merge it found (`owner/name#number`) without dragging the check rows the
 *  Development surface's own type carries (MOTIR-2922). */
export type GithubPullRequestWithRepo = GithubPullRequest & { repo: GithubRepo };

/** The merge facts captured best-effort AFTER the status sync commits
 *  (MOTIR-2922): when the merge landed, and which repo-relative paths it touched.
 *  `changedPathsTruncated` says the path list is a PREFIX rather than the whole,
 *  and travels WITH the paths for exactly that reason — a consumer that reads one
 *  without the other can read a capped list as a complete one. */
export interface MergeCaptureInput {
  mergedAt: Date | null;
  changedPaths: string[];
  changedPathsTruncated: boolean;
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
  async listByWorkItemWithContext(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithContext[]> {
    const client = tx ?? db;
    return client.githubPullRequest.findMany({
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
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestCandidate[]> {
    const client = tx ?? db;
    const trimmed = query.trim();
    const asNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const match: Prisma.GithubPullRequestWhereInput[] = [
      { title: { contains: trimmed, mode: 'insensitive' } },
      { repo: { is: { owner: { contains: trimmed, mode: 'insensitive' } } } },
      { repo: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
    ];
    if (asNumber !== null && Number.isSafeInteger(asNumber)) match.push({ number: asNumber });
    return client.githubPullRequest.findMany({
      // Gate on the REPO row's own `workspace_id` (MOTIR-1931), not a join through
      // the installation: a PR on a repo Motir created sits behind the shared
      // provisioning installation, which is bound to no workspace, so the old
      // join would never have matched it.
      where: { repo: { is: { workspaceId } }, OR: match },
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

  /** Stamp a merged PR's capture facts onto its row (MOTIR-2922). `updateMany`
   *  rather than `update` deliberately: this runs POST-COMMIT and best-effort, so
   *  the row it targets could have been deleted between the sync's commit and this
   *  write (a repo removal cascades), and a `P2025` thrown from a fire-and-forget
   *  side effect would be logged as a failure where the correct reading is "there
   *  is nothing left to stamp". Returns how many rows it touched so the caller can
   *  say which of the two happened. Write path → `tx`. */
  async recordMergeCapture(
    repoId: string,
    number: number,
    data: MergeCaptureInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { repoId, number },
      data: {
        mergedAt: data.mergedAt,
        changedPaths: data.changedPaths,
        changedPathsTruncated: data.changedPathsTruncated,
      },
    });
    return result.count;
  },

  /** The workspace's MERGED pull requests whose captured paths intersect `paths`
   *  and whose merge landed strictly after `since` (MOTIR-2922) — the single read
   *  a subsumption check consumes, so that consumer adds no data access of its own.
   *
   *  `excludeWorkItemId` drops the card doing the asking: a card's own merged PR
   *  touching its own paths is the ordinary case and is not evidence that someone
   *  ELSE already shipped its deliverable. Rows linked to NO work item are KEPT —
   *  an unlinked merge touched the paths just the same, and the link is a fact
   *  about the tracker rather than about the repository.
   *
   *  `workspaceId` is the explicit tenant gate on the REPO row (MOTIR-1931, and
   *  finding #26 — RLS is inert under the dev/CI superuser), never a join through
   *  the installation, which names no workspace under Motir's shared provisioning
   *  install. Read-only path → `db`, with `tx` accepted so a caller already inside
   *  a bound transaction keeps its context. */
  async findMergedTouchingPaths(
    workspaceId: string,
    paths: string[],
    since: Date,
    excludeWorkItemId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithRepo[]> {
    if (paths.length === 0) return [];
    const client = tx ?? db;
    return client.githubPullRequest.findMany({
      where: {
        repo: { is: { workspaceId } },
        merged: true,
        // A merged PR is always closed, so this is redundant with `merged` for
        // every row the webhook writes — and it is what makes "omits an OPEN row"
        // hold for a row some other path leaves inconsistent, rather than merely
        // usually hold.
        state: 'closed',
        mergedAt: { gt: since },
        changedPaths: { hasSome: paths },
        // Spelled as an explicit OR rather than `{ workItemId: { not: id } }`,
        // because whether a Prisma `not` on a NULLABLE column keeps or drops the
        // null rows is a version-dependent detail, and the answer here has to be
        // KEEP. Stating it removes the dependency.
        ...(excludeWorkItemId
          ? { OR: [{ workItemId: null }, { workItemId: { not: excludeWorkItemId } }] }
          : {}),
      },
      include: { repo: true },
      orderBy: { mergedAt: 'desc' },
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
