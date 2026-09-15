import { Prisma, type Plan, type PlanItem, type PlanStatus } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

/**
 * The `PlanItem` create shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanItemUncheckedCreateInput` itself is named only here.
 */
export type PlanItemCreateInput = Prisma.PlanItemUncheckedCreateInput;

/**
 * The `PlanItem` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanItemUncheckedUpdateInput` itself is named only here.
 */
export type PlanItemUpdateInput = Prisma.PlanItemUncheckedUpdateInput;

/**
 * One row of {@link planItemRepository.findHistoryByWorkItemId}: the proposal's
 * identity and the columns that say which relation it stands for, with the
 * plan's display fields (and its decider's name) on the same row.
 */
export type PlanHistoryItemRow = Pick<PlanItem, 'id' | 'op' | 'workItemId' | 'parentRef'> & {
  plan: Pick<
    Plan,
    | 'id'
    | 'title'
    | 'status'
    | 'createdAt'
    | 'plannedAt'
    | 'decidedAt'
    | 'decidedById'
    | 'authorSource'
    | 'authorHarness'
    | 'authorModel'
  > & { decidedBy: { name: string } | null };
};

// PlanItem repository — single Prisma operations on the `plan_item` table
// (Story 7.21 · MOTIR-1336). Writes require `tx`; pure reads use the `db`
// singleton. No business logic, no transactions, no DTO mapping.
export const planItemRepository = {
  async create(data: PlanItemCreateInput, tx: Prisma.TransactionClient): Promise<PlanItem> {
    return tx.planItem.create({ data });
  },

  /** A plan's proposal items in append order (createdAt asc, id asc). Optional
   *  `tx` joins a surrounding transaction (the materialize read in approve). */
  async findByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<PlanItem[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: { planId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The proposals that TARGET a given work item — the reverse lookup
   * (MOTIR-3579). `modify` / `remove` only: an `add` has a null `workItemId` by
   * construction, so it can never be the target of one.
   *
   * ⚠️ THIS IS THE READ THE `plan_item_work_item_id_workspace_id_idx` INDEX
   * EXISTS FOR, and it runs on EVERY status change in the tenant — the drift
   * listener consumes `work-item/transitioned`, which every ingress emits. The
   * `@@unique([planId, workItemId])` cannot serve it: its leftmost column is
   * `planId`, so without the composite this is a sequential scan of every
   * proposal in the workspace, per board drag.
   *
   * `workspaceId` is an explicit filter and not merely an RLS matter — RLS is
   * inert under the dev/CI superuser, so the predicate is the actual gate
   * (finding #26).
   */
  async findByWorkItemId(
    workItemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanItem[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: { workItemId, workspaceId, op: { in: ['modify', 'remove'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The UNDECIDED proposals that NAME a given work item, with the plan each one
   * belongs to — the work-item page's pending-plan read (bug MOTIR-4197 · design
   * MOTIR-4256 §3, widened by bug MOTIR-4365 · design MOTIR-4364 AMENDMENT A).
   *
   * ⚠️ TWO ARMS, BECAUSE A PROPOSAL NAMES A CARD IN TWO DIFFERENT COLUMNS — and
   * that is a fact about the substrate, not a filter someone chose narrowly:
   *
   *   * a `modify` / `remove` TARGETS the card: `workItemId`, the reverse index
   *     `[workItemId, workspaceId]` (MOTIR-3579);
   *   * an `add` PARENTS on the card: `parentRef`, the forward-parent index
   *     `[parentRef, workspaceId]` (MOTIR-4365). An `add` has NO `workItemId` at
   *     all — the row it would name does not exist until the plan is approved —
   *     so widening the `op` list alone would have changed nothing, which is why
   *     this is an `OR` of two indexed predicates rather than a looser one.
   *
   * `parentRef` is matched on the RESOLVED work-item id, which is what the
   * column holds: `add_plan_items` rewrites a `MOTIR-<n>` key to its id on the
   * way IN (MOTIR-3576, `resolveKeyRefs`), so the stored value is either a real
   * id or an intra-plan `planItem:<id>` temp-ref — and a temp-ref names another
   * PROPOSAL as the parent, which is correctly not this card.
   *
   * Narrowed to the plans in `statuses` (the caller passes
   * `WORK_ITEM_PENDING_PLAN_STATUSES`; the SET is the service's decision, not
   * this method's) and to the plans of `projectId`, so a caller granted browse
   * on one project cannot read another project's proposals through a work-item
   * id it happens to know. The plan's `id` / `title` / `status` ride back on the
   * SAME query — ONE query, never a read per row — which is the figure the item
   * page's tier-two group is allowed to add. A plan may now return SEVERAL rows
   * (N `add`s under one card), and collapsing them to one row per plan is the
   * service's in-memory fold, deliberately not a second query.
   *
   * ⚠️ NO `tx`-less arm: this read runs inside the page's request, and on a card
   * with no pending plan — nearly every card — it must cost exactly the index
   * probes and nothing more.
   */
  async findPendingByWorkItemId(
    workItemId: string,
    workspaceId: string,
    projectId: string,
    statuses: readonly PlanStatus[],
    tx?: Prisma.TransactionClient,
  ): Promise<Array<PlanItem & { plan: Pick<Plan, 'id' | 'title' | 'status'> }>> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: {
        workspaceId,
        plan: { projectId, status: { in: [...statuses] } },
        OR: [
          { workItemId, op: { in: ['modify', 'remove'] } },
          { parentRef: workItemId, op: 'add' },
        ],
      },
      include: { plan: { select: { id: true, title: true, status: true } } },
      orderBy: [{ plan: { createdAt: 'asc' } }, { id: 'asc' }],
    });
  },

  /**
   * EVERY proposal, in a plan of ANY status, that relates to a given work item —
   * the rows the item page's PLAN HISTORY is folded from (Story MOTIR-5542 ·
   * MOTIR-5546). The pending read above, widened from two arms to THREE and
   * with its status filter dropped:
   *
   *   * **created it** — an `add` whose `workItemId` is this card. An `add` is
   *     born with a null `workItemId`; `plansService.materialize` writes the
   *     created id back at approve, so this arm only ever matches an APPROVED
   *     plan's `add`;
   *   * **changed / archived it** — a `modify` / `remove` TARGETING the card;
   *   * **added children under it** — an `add` whose `parentRef` is this card.
   *
   * Arms one and two share the `[workItemId, workspaceId]` index and arm three
   * uses `[parentRef, workspaceId]`. They are written as three predicates rather
   * than a bare `{ workItemId }` so the relation each row stands for is legible
   * at the query, and so a fourth op can never slip into arm two unnoticed.
   *
   * ⚠️ KNOWN LIMITATION, stated rather than fixed: an `add` whose `parentRef` is
   * an intra-plan `planItem:<id>` temp-ref (a child laid under a story the SAME
   * plan adds) is NOT matched by arm three — the stored value names the parent
   * PROPOSAL, not the card it became. No plan is lost by it: after approve the
   * story's own `add` carries the story's id, so that plan still arrives for the
   * story through arm one, as *created it* — only its child count reads 0.
   *
   * `planIds` narrows to one page of plans (`planRepository
   * .findPageRelatedToWorkItem` pages them); `null` reads every related row.
   * The plan's display fields — including the decider's NAME, through the
   * `decidedBy` relation — ride back on this SAME query. Ordered by plan
   * creation, then the row's own append order, so a caller folding in memory
   * keeps the page's order without a second sort.
   */
  async findHistoryByWorkItemId(
    workItemId: string,
    workspaceId: string,
    projectId: string,
    planIds: readonly string[] | null,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanHistoryItemRow[]> {
    const client = tx ?? dbRead;
    return client.planItem.findMany({
      where: {
        workspaceId,
        ...(planIds ? { planId: { in: [...planIds] } } : {}),
        plan: { projectId },
        OR: [
          { workItemId, op: 'add' },
          { workItemId, op: { in: ['modify', 'remove'] } },
          { parentRef: workItemId, op: 'add' },
        ],
      },
      select: {
        id: true,
        op: true,
        workItemId: true,
        parentRef: true,
        plan: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            plannedAt: true,
            decidedAt: true,
            decidedById: true,
            authorSource: true,
            authorHarness: true,
            authorModel: true,
            decidedBy: { select: { name: true } },
          },
        },
      },
      orderBy: [
        { plan: { createdAt: 'asc' } },
        { planId: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
  },

  async countByPlan(planId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.planItem.count({ where: { planId } });
  },

  /** Item counts for a set of plans in one grouped query — the list view's
   *  `itemCount` without an N+1. Returns a `planId → count` map. */
  async countByPlanIds(
    planIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (planIds.length === 0) return new Map();
    const client = tx ?? dbRead;
    const rows = await client.planItem.groupBy({
      by: ['planId'],
      where: { planId: { in: planIds } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.planId, r._count._all]));
  },

  /** A single PlanItem by id. Optional `tx` joins a surrounding transaction
   *  (the proposal-edit path re-reads the item under the plan lock). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<PlanItem | null> {
    const client = tx ?? dbRead;
    return client.planItem.findUnique({ where: { id } });
  },

  /** Edit a PlanItem's mutable JSON/columns in place — the proposal-edit path
   *  (7.21.6 · MOTIR-1370) patches an `add`'s `proposedFields` while the plan is
   *  `planned`. A write, so `tx` is required. */
  async update(
    id: string,
    data: PlanItemUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data });
  },

  /** Delete ONE proposal — the WITHDRAW path (Story MOTIR-3533 · MOTIR-3540).
   *
   *  The per-item delete `agent-authored-plans.md` AMENDMENT 3 D4 recorded as
   *  absent: `deleteByPlan` is a whole-plan operation and could not express a
   *  single proposal coming off a plan. A write, so `tx` is required. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<PlanItem> {
    return tx.planItem.delete({ where: { id } });
  },

  /** Write the materialized work-item id back onto an `add` PlanItem (approve). */
  async setWorkItemId(
    id: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanItem> {
    return tx.planItem.update({ where: { id }, data: { workItemId } });
  },
};
