import type { Prisma, WorkItemDelivery } from '@/generated/prisma/client';

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
