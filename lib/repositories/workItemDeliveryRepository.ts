import type { Prisma, WorkItemDelivery } from '@/generated/prisma/client';
import type { LinkedChangeRequestCompletionFact } from '@/lib/repositories/githubPullRequestRepository';

// Single Prisma operations on the `work_item_delivery` table — the ONE association
// between a work item and a pull request, many-to-many in both directions (Story
// MOTIR-3655 · MOTIR-3657, ADR `docs/decisions/work-item-delivery-links.md`).
//
// N cards linking to the SAME pull-request row is N rows, and that is how one pull
// request delivers N cards; one card linking to two pull-request rows is two rows,
// and that is how a card spans repositories. Both directions are the same table
// read from opposite sides, which is why {@link listByWorkItem} and
// {@link listByPullRequest} are one query each and not two mechanisms.
//
// Writes require `tx`, the compile-time guarantee they run in a transaction. So do
// the READS here, which is a deliberate departure from the "reads may use the `db`
// singleton" half of the layer rule and is the same departure
// `workItemRepoRepository` makes, for the same reason: every row is gated by an RLS
// policy on `app.workspace_id`, a GUC bound by `withWorkspaceContext` on a
// TRANSACTION and by nothing else. A read through the bare singleton does not fail
// — it returns an EMPTY LIST, indistinguishable from "this card has no deliveries",
// which is by a wide margin the worse of the two failures. Requiring `tx` turns
// that into a type error at the call site.
//
// No business logic, no transactions, no DTO mapping — those belong in the services
// that compose this (`workItemsService`, `changeRequestStatusSync`, `ciPromotion`).

/** A delivery row joined to the pull request and repository it names — what a read
 *  needs to answer "has this member merged, and onto which default branch?" without
 *  a second round trip. */
export type WorkItemDeliveryWithPr = Prisma.WorkItemDeliveryGetPayload<{
  include: { pullRequest: true; repo: true };
}>;

const WITH_PR = { pullRequest: true, repo: true } as const;

/** A delivery row whose pull request also carries its CHECK ROWS — what a read has
 *  to have to derive the CI verdict (MOTIR-3697). Its own type, and its own read
 *  below, because the check rows are the expensive half: the completion gate and
 *  the CI promotion ask about MERGES and would pay for rows they never look at. */
export type WorkItemDeliveryWithChecks = Prisma.WorkItemDeliveryGetPayload<{
  include: { pullRequest: { include: { checkRuns: true } }; repo: true };
}>;

const WITH_CHECKS = {
  pullRequest: { include: { checkRuns: true } },
  repo: true,
} as const;

export const workItemDeliveryRepository = {
  /**
   * One card's DELIVERY SET — every pull request delivering it, oldest link first.
   *
   * This is the read the completion gate and the CI promotion both ask, and they
   * must ask it the same way: `deferred_incomplete_delivery_set` holds the card
   * until every member has MERGED, and `ciPromotion` withholds `in_review` until
   * every member is GREEN. One rule shape at two statuses, over one list.
   */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithPr[]> {
    return tx.workItemDelivery.findMany({
      where: { workItemId },
      include: WITH_PR,
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Several cards' delivery sets in ONE query, in (card, link age) order.
   *
   * A batched read rather than N calls to {@link listByWorkItem}, because the
   * surfaces that need this need it for a LIST — a board column, a container's
   * children, the dispatch payload. Ordering by `workItemId` first keeps the
   * caller's grouping a single pass.
   */
  async listByWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithPr[]> {
    if (workItemIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: WITH_PR,
      orderBy: [{ workItemId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /**
   * One card's delivery set WITH the check rows behind each member's CI verdict
   * (MOTIR-3697) — what the DTO needs and what {@link listByWorkItem} deliberately
   * does not fetch.
   *
   * Same rows, same order, one heavier `include`. Kept apart from
   * {@link listByWorkItem} rather than folded into it because the two callers want
   * genuinely different things: the completion gate asks *has it merged*, which the
   * pull-request row answers on its own, while a READER also asks *is it green*,
   * which only the check rows can. Widening the gate's read would make every
   * completion evaluation drag every check row of every delivery for an answer it
   * never consults.
   */
  async listByWorkItemWithChecks(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithChecks[]> {
    return tx.workItemDelivery.findMany({
      where: { workItemId },
      include: WITH_CHECKS,
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The WORKSPACE that owns a card's deliveries, or null when it has none
   * (MOTIR-3721, moving `githubPullRequestRepository.findWorkspaceIdByWorkItem`).
   *
   * This is the re-evaluation path's TRUSTED workspace resolution: the only way a
   * caller holding just a work-item id can learn the tenant it must bind before
   * touching `work_item`, a table with no `system_admin` arm (MOTIR-2880). The
   * delivery row carries `workspace_id` DIRECTLY, so unlike the connection-tier
   * read it replaces there is no join at all — and RLS does not traverse foreign
   * keys, so a join would not have helped anyway (ADR §1 measured exactly that).
   *
   * ⚠️ IT IS ADMITTED ONLY BECAUSE THIS TABLE CARRIES THE `app.system_admin` ARM
   * (migration `20260828120000_work_item_delivery_system_arm`). Without it the read
   * returns an EMPTY LIST inside `withSystemContext` and raises nothing, which is
   * this module's own stated worst failure. The arm and this method ship together.
   *
   * Oldest link first, matching the read it replaces — a card's deliveries all
   * belong to one workspace, so the order decides nothing; it is kept so a
   * multi-row card resolves deterministically.
   */
  async findWorkspaceIdByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.workItemDelivery.findFirst({
      where: { workItemId },
      select: { workspaceId: true },
      orderBy: { createdAt: 'asc' },
    });
    return row?.workspaceId ?? null;
  },

  /**
   * Count a card's OTHER delivering pull requests (excluding `excludePrId`) that
   * are still OPEN (MOTIR-3721, moving
   * `githubPullRequestRepository.countOtherOpenByWorkItem`).
   *
   * The status sync uses it so a merge only COMPLETES the card when it is the
   * card's LAST open delivering pull request: a cross-repo card must not flip Done
   * while a sibling is still open (MOTIR-1604). A read guarding the transition
   * write → takes `tx`.
   */
  async countOtherOpenByWorkItem(
    workItemId: string,
    excludePrId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.workItemDelivery.count({
      where: {
        workItemId,
        githubPullRequestId: { not: excludePrId },
        pullRequest: { is: { state: 'open' } },
      },
    });
  },

  /**
   * Count a card's delivering pull requests that are still OPEN (MOTIR-3721,
   * moving `githubPullRequestRepository.countOpenByWorkItem`).
   *
   * The re-evaluation path (MOTIR-3034) uses it where the sync uses
   * {@link countOtherOpenByWorkItem}: there a delivery is being decided and the
   * DELIVERING row must be excluded from its own gate, here there is no delivery
   * at all, so every open sibling counts. Deliberately a second method rather than
   * a nullable exclusion on the first — the two callers ask different questions,
   * and a nullable argument would make WHICH one a property of a call site.
   */
  async countOpenByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItemDelivery.count({
      where: { workItemId, pullRequest: { is: { state: 'open' } } },
    });
  },

  /**
   * A card's deliveries, as the COMPLETION facts the repository-SET gate decides
   * on (MOTIR-3721, moving
   * `githubPullRequestRepository.listCompletionFactsByWorkItem`): which repository
   * each landed in, whether it merged, which branch it targeted, and that
   * repository's own default branch.
   *
   * Reads the repository off the DELIVERY row rather than the pull request's,
   * which is the same repository by construction (`link_pull_request` stores the
   * pull request's own `repo_id`) and is the column this table carries precisely
   * so the gate can compare each member against its own default branch without a
   * join per member.
   *
   * Takes a REQUIRED `tx`: it guards a status WRITE and must run inside the sync's
   * resolve transaction, under the row lock already taken, so concurrent
   * redeliveries serialize on it exactly as the shipped gates do.
   */
  async listCompletionFactsByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LinkedChangeRequestCompletionFact[]> {
    const rows = await tx.workItemDelivery.findMany({
      where: { workItemId },
      select: {
        repo: { select: { name: true, defaultBranch: true } },
        pullRequest: { select: { merged: true, baseRef: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      repoName: r.repo.name,
      repoDefaultBranch: r.repo.defaultBranch,
      merged: r.pullRequest.merged,
      baseRef: r.pullRequest.baseRef,
    }));
  },

  /**
   * Every card delivered by ANY of `githubPullRequestIds`, de-duplicated
   * (MOTIR-3721 — the consumer half of the base-ref backfill's candidate read).
   *
   * The backfill fills a `base_ref` on N pull requests and then re-evaluates every
   * card those merges could have completed. It used to take the card ids off the
   * candidate rows' own link column, which is exactly the projection this card
   * moves; over the delivery table the answer is a set per pull request, so the
   * read is batched rather than run per candidate.
   */
  async listWorkItemIdsByPullRequests(
    githubPullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (githubPullRequestIds.length === 0) return [];
    const rows = await tx.workItemDelivery.findMany({
      where: { githubPullRequestId: { in: [...githubPullRequestIds] } },
      select: { workItemId: true },
      distinct: ['workItemId'],
      orderBy: { workItemId: 'asc' },
    });
    return rows.map((r) => r.workItemId);
  },

  /**
   * Every card a BATCH of pull requests delivers, in (pull request, link age)
   * order — {@link listByPullRequest} for a list, in one query (MOTIR-3756).
   *
   * The callers are the two readers that ask the question per CANDIDATE rather
   * than per card: the explicit-link picker annotates each of its ten candidates
   * with the cards it already delivers, and the subsumption index annotates every
   * pull request touching a batch's paths with the cards it was opened by. Both
   * hold a list of pull-request ids and would otherwise issue one read each.
   *
   * Returns the delivery ROWS rather than resolved work items: the two callers
   * want different things from them (identifiers to render, ids to compare), and
   * a link whose target the tenant context cannot see must not become a
   * fabricated item — the caller resolves what it needs and stays tolerant of a
   * short answer, exactly as `resolveDeliveredWorkItems` does.
   */
  async listByPullRequests(
    githubPullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Pick<WorkItemDelivery, 'githubPullRequestId' | 'workItemId'>[]> {
    if (githubPullRequestIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { githubPullRequestId: { in: [...githubPullRequestIds] } },
      select: { githubPullRequestId: true, workItemId: true },
      orderBy: [{ githubPullRequestId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /**
   * Every card ONE pull request delivers — the direction the singular FK could not
   * express at all.
   *
   * This is what a merge asks: the delivery closes every card recorded against it,
   * not the one a link column happens to name. A `motir auto` pull request answers
   * with all N of its run's cards.
   */
  async listByPullRequest(
    githubPullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDelivery[]> {
    return tx.workItemDelivery.findMany({
      where: { githubPullRequestId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Record ONE delivery — idempotent by construction.
   *
   * A repeat for the same `(card, pull request)` is a no-op rather than an error or
   * a second row, which is what lets `link_pull_request` be called again on a
   * redelivery or an agent retry without the caller having to check first. The
   * unique index is the arbiter of a lost race; this `upsert` is the ordinary path
   * to the same answer in one round trip.
   *
   * `repoId` is stored rather than derived so the completion gate can compare each
   * member against its own repository's default branch without a join per member.
   */
  async add(
    data: {
      workspaceId: string;
      workItemId: string;
      githubPullRequestId: string;
      repoId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDelivery> {
    return tx.workItemDelivery.upsert({
      where: {
        workItemId_githubPullRequestId: {
          workItemId: data.workItemId,
          githubPullRequestId: data.githubPullRequestId,
        },
      },
      create: data,
      update: {},
    });
  },

  /**
   * Remove ONE delivery — the door a mistaken link needs.
   *
   * With a singular FK a correction was expressible as a MOVE (link it elsewhere
   * and the old association vanished). With rows it is not, so removal has to be
   * its own operation. Returns the number of rows removed so a caller can tell a
   * real removal from a no-op without a second read.
   */
  async remove(
    workItemId: string,
    githubPullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.workItemDelivery.deleteMany({
      where: { workItemId, githubPullRequestId },
    });
    return result.count;
  },
};
