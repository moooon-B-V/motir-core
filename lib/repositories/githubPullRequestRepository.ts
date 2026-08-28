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
  /** The branch the change request TARGETS (Story MOTIR-2725 · MOTIR-2729).
   *  Required on `NormalizedChangeRequest` for both providers and on the
   *  historical backfill, so every live path supplies it; the COLUMN is nullable
   *  only because rows written before it existed cannot know theirs. */
  baseRef: string;
  title: string | null;
  /** The stored 1:1 link (W2, the webhook write). Still WRITTEN and still present
   *  — MOTIR-3721 moves the column's READERS onto `work_item_delivery` and drops
   *  nothing; the drop is its own later card, once nothing reads it.
   *
   *  ⚠️ OPTIONAL, and the third state is the point (MOTIR-3721). `null` CLEARS
   *  the link; a string SETS it; **omitting it leaves the stored value exactly as
   *  it is** (Prisma ignores an `undefined` field, so `update` does not touch the
   *  column and `create` takes the column default). The status sync omits it: it
   *  no longer resolves a card from this column, so it has no value to write back
   *  — and reading the row's own value merely to hand it straight back would be a
   *  read of the column wearing a write's clothes, which is the thing being
   *  retired. The two callers that genuinely DECIDE a link
   *  (`githubPullRequestService`, `historicalPullRequestBackfillService`) pass it
   *  explicitly, as they always did. */
  workItemId?: string | null;
  /** Whether this link is the manual override (MOTIR-1596). The webhook passes
   *  the row's PRESERVED value so an auto delivery never clears a manual link. */
  linkedManually: boolean;
}

/** One linked change request, reduced to the four facts the repository-SET
 *  completion gate decides on (Story MOTIR-2725 · MOTIR-2729). `baseRef` is null
 *  for rows ingested before the column existed — UNKNOWN, never "the default
 *  branch". */
export interface LinkedChangeRequestCompletionFact {
  repoName: string;
  repoDefaultBranch: string;
  merged: boolean;
  baseRef: string | null;
}

/** A PR row with the context the Development surface renders (MOTIR-1579):
 *  its repo (owner/name for the meta line + link-out) and its check rows
 *  (the per-PR CI state derivation). */
export type GithubPullRequestWithContext = GithubPullRequest & {
  repo: GithubRepo;
  checkRuns: GithubCheckRun[];
};

/** A PR row with just its check rows — enough to derive the CI verdict, which is
 *  all the MOTIR-3006 promotion reads. */
export type GithubPullRequestWithChecks = GithubPullRequest & {
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

  /** Take a row lock on the PR by its internal id, so the ONE CI-feedback comment
   *  a change request carries at a head sha is claimed by exactly one of the N
   *  concurrent check deliveries (MOTIR-2946). The feedback body is DERIVED from
   *  every check row at that sha and then written as a comment, so without the
   *  lock two deliveries both read "no comment yet" and both create one — the
   *  lock-before-read-derived-update rule, with the comment as the derived write.
   *  A no-op when the row does not exist (the caller has already resolved it, so
   *  in practice it always does). */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_pull_request WHERE id = ${id} FOR UPDATE`;
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

  /** One repository's MERGED change requests whose `base_ref` is NULL — the rows
   *  the completion gate reads as UNKNOWN (MOTIR-3034). Exactly the population
   *  the base-ref backfill repairs, and the reason a second run of that backfill
   *  makes zero host calls: a filled row leaves this set.
   *
   *  MERGED ONLY, and that is the decision the card asked to be recorded rather
   *  than a narrowing. `classifyRepoDelivery` filters on `f.merged` before it ever
   *  looks at `baseRef`, so an unmerged row's null base is never a term in the
   *  gate; and an OPEN change request's base is still mutable, so a value read
   *  today can be wrong tomorrow and the next delivery writes the right one
   *  anyway. Spending a rate-limited request on either buys nothing.
   *
   *  ⚠️ NO `work_item_id` IN THE PROJECTION (MOTIR-3721), and its absence is the
   *  point rather than a tidy-up. The card ids this sweep must re-evaluate come
   *  from `workItemDeliveryRepository.listWorkItemIdsByPullRequests` over the rows
   *  it actually filled — a SET per pull request, which a scalar column could not
   *  express. The projection and its consumer are the two ends of ONE path (ADR
   *  §5): read the ids off this row and a pull request delivering three cards
   *  re-evaluates one of them, or none, and the sweep reports `filled: N` either
   *  way, having repaired nothing and raised nothing.
   *
   *  Read guarding a write → takes `tx`. Ordered so a long sweep's log is
   *  diffable and resumable by eye. */
  async listMergedMissingBaseRefByRepo(
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; number: number }>> {
    return tx.githubPullRequest.findMany({
      where: { repoId, merged: true, baseRef: null },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
  },

  /** Write a `base_ref` onto a row that does NOT have one, and return how many
   *  rows that touched — 0 when a concurrent delivery filled it first
   *  (MOTIR-3034).
   *
   *  `updateMany` with `baseRef: null` in the WHERE is what makes the backfill
   *  idempotent AT THE DATABASE rather than by the caller remembering to check:
   *  a row that already carries a base is never rewritten, so its `updated_at`
   *  never churns and a live delivery's value is never clobbered by a slower
   *  historical read. It also means a re-run is a no-op by construction rather
   *  than by a comparison the caller might get wrong. Write path → `tx`. */
  async setBaseRefIfNull(
    id: string,
    baseRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { id, baseRef: null },
      data: { baseRef },
    });
    return result.count;
  },

  /** A work item's DELIVERING PRs, newest-updated first, with the repo + check
   *  rows the Development surface renders (MOTIR-1579, moved to the delivery set
   *  by MOTIR-3756).
   *
   *  The `where` is a relation filter on `work_item_delivery` rather than the
   *  singular column, so a pull request delivering this card AND others is listed
   *  here exactly once — which is the shape the column could not express and the
   *  reason the Development surface came back SHORT: a `motir auto` pull request
   *  carrying twelve cards named one of them in the FK and was invisible to the
   *  other eleven.
   *
   *  ⚠️ `tx` is REQUIRED, and that is the point rather than tidiness. This read
   *  now crosses a table whose ONLY tenant gate is an RLS policy on
   *  `app.workspace_id`; through the bare `db` singleton the delivery subquery
   *  matches nothing and the answer is an EMPTY LIST rather than an error —
   *  indistinguishable from "this card has no pull requests", which is by a wide
   *  margin the worse failure. Requiring the transaction turns that into a type
   *  error at the call site (`workItemDeliveryRepository`'s own header states the
   *  same rule for the same reason). */
  async listByWorkItemWithContext(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithContext[]> {
    return tx.githubPullRequest.findMany({
      where: { deliveries: { some: { workItemId } } },
      include: { repo: true, checkRuns: true },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Every change request whose HEAD REF is this branch, with its check rows —
   * the SESSION-BRANCH arm of the CI-green latch (MOTIR-3006).
   *
   * A session pull request carries no `work_item_id` (its branch deliberately
   * names no card), so a card integrated onto that branch cannot be reached from
   * the link column. The branch is the join, and it is the same join the merge
   * close-out uses.
   */
  async listByHeadRefWithChecks(
    headRef: string,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithChecks[]> {
    const client = tx ?? db;
    return client.githubPullRequest.findMany({
      where: { headRef },
      include: { checkRuns: true },
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
   *  Read-only path → `db`; `workspaceId` is the explicit tenant gate
   *  (finding #26 — RLS is inert under the dev/CI superuser).
   *
   *  ⚠️ NO WORK-ITEM INCLUDE (MOTIR-3756). It used to carry
   *  `workItem: { select: { identifier: true } }` — the single item the FK named,
   *  which the picker rendered as the "Linked to MOTIR-n" takeover chip. A
   *  candidate now delivers a SET, so the identifiers come from
   *  `workItemDeliveryRepository.listByPullRequests` in one batched read beside
   *  this one; an `include` cannot express it, because the relation the FK
   *  declares is the singular one being retired. */
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
      include: { repo: true },
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

  /** The workspace's pull requests whose captured paths intersect `paths` — the
   *  single read a subsumption check consumes, so that consumer adds no data
   *  access of its own. TWO arms, and they answer different questions:
   *
   *  - **MERGED**, landing strictly after `since` (MOTIR-2922) — *the work may
   *    already be in the tree*. `since` exists because a merge that predates the
   *    asking card is the substrate it was written against, which is the opposite
   *    finding.
   *  - **OPEN** (MOTIR-3230) — *somebody is changing this path right now*. **No
   *    `since` clause, deliberately**: an open pull request is current by
   *    definition, so there is no interval in which it is too old to matter. The
   *    merged arm needs an ordering fact because a merge is permanent; the open arm
   *    does not, because being open is itself the recency.
   *
   *  ⚠️ WHY THE OPEN ARM IS THE ONE THAT MATTERS, said here because the change
   *  looks like a widening for completeness and is not. A pull request is merged
   *  for the rest of time and open for about an hour, so a merged-only read is
   *  available for the whole period in which the answer no longer changes anything
   *  and blind for the one window in which it would. Two sessions filing against a
   *  path one of them is already changing is the normal state of this project, and
   *  the second usually goes on to FIX it off the default branch, in ignorance —
   *  two green pull requests that cancel when both merge.
   *
   *  ⚠️ THERE IS NO EXCLUSION CLAUSE, and there never effectively was one
   *  (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §4). This
   *  accessor carried an `excludeWorkItemId` parameter whose sole production
   *  caller passed `null`: `buildSubsumptionIndex` widens the query to the UNION
   *  of a whole batch's paths, so a per-SUBJECT clause cannot be expressed in the
   *  SQL at all and is re-applied in memory at
   *  `proseGraphAdvisoryService.subsumptionAdvisory`. Deleting the parameter
   *  leaves ONE spelling of the exclusion, in the layer that actually runs it.
   *
   *  The argument the parameter's own note made SURVIVES and becomes trivially
   *  true: rows linked to NO work item are KEPT — an unlinked merge touched the
   *  paths just the same, and the link is a fact about the tracker rather than
   *  about the repository. With no exclusion clause there is nothing that could
   *  drop them.
   *
   *  `workspaceId` is the explicit tenant gate on the REPO row (MOTIR-1931, and
   *  finding #26 — RLS is inert under the dev/CI superuser), never a join through
   *  the installation, which names no workspace under Motir's shared provisioning
   *  install. Read-only path → `db`, with `tx` accepted so a caller already inside
   *  a bound transaction keeps its context. */
  async findTouchingPaths(
    workspaceId: string,
    paths: string[],
    since: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithRepo[]> {
    if (paths.length === 0) return [];
    const client = tx ?? db;
    return client.githubPullRequest.findMany({
      where: {
        repo: { is: { workspaceId } },
        changedPaths: { hasSome: paths },
        // The two arms under an explicit `AND` member rather than beside the
        // `OR` above: an object literal carries one `OR`, so writing both at this
        // level would silently drop whichever was declared first. `AND` is the
        // only spelling under which each clause is independently true — and it is
        // kept with one member rather than flattened, because the recency arms and
        // the path/tenant clauses are two independent predicates and collapsing
        // them is how the second `OR` was lost in the first place.
        AND: [
          {
            OR: [
              {
                merged: true,
                // A merged PR is always closed, so this is redundant with `merged`
                // for every row the webhook writes — and it is what makes "omits an
                // inconsistent row" hold rather than merely usually hold.
                state: 'closed',
                mergedAt: { gt: since },
              },
              // `merged: false` beside the state for the same reason, plus one this
              // arm owns: it is what stops a row whose `state` some other path left
              // stale being read as in-flight work after it has already landed.
              { state: 'open', merged: false },
            ],
          },
        ],
      },
      include: { repo: true },
      // Merged rows descend by merge instant, as they always have. An OPEN row has
      // no `mergedAt` at all, so its position under this clause is a fact about the
      // database's null ordering rather than about the data — the consumer sorts the
      // two arms itself (`buildSubsumptionIndex`) rather than depending on it.
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
