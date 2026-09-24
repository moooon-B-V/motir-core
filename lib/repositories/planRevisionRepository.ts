import type { Prisma, PlanRevision } from '@/generated/prisma/client';
import {
  INTERNAL_PLAN_REVISION_CHANGE_KINDS,
  REASON_CLASSIFIED_KIND,
} from '@/lib/plans/revisionReason';

/**
 * THE ONE PLACE a tenant read excludes an INTERNAL change kind (Story MOTIR-5543
 * · MOTIR-6083).
 *
 * ⚠️ AT THE QUERY, not at a mapper, and that is the decision rather than a
 * detail. A mapper-side filter leaves the row in memory on a tenant code path, so
 * the next reader of `revisions` — a lease, a count, a new DTO field — picks it
 * up by accident, and nothing goes red. Excluding it in the `where` means the row
 * never leaves the repository on those reads, so a future consumer CANNOT forget:
 * there is nothing to forget about.
 *
 * Spread into every read a tenant path reaches. The one read that deliberately
 * does NOT spread it is `listReasonClassifications`, which exists to return
 * exactly these rows and has no tenant surface at all.
 */
export const TENANT_VISIBLE_PLAN_REVISION_WHERE = {
  changeKind: { notIn: [...INTERNAL_PLAN_REVISION_CHANGE_KINDS] },
} as const satisfies Prisma.PlanRevisionWhereInput;

// Plan-revision repository — single Prisma operations on the `plan_revision`
// table (Story MOTIR-3532 · Subtask MOTIR-3535). The append-only leaf the plan
// write flows persist through: `plansService` records a revision via
// `planRevisionsService.recordRevision`, which calls `create` here INSIDE the
// same transaction as the mutation it describes.
//
// Layer rules (CLAUDE.md): the write REQUIRES `tx`, so a revision can only be
// written inside a transaction — that is the compile-time half of the atomicity
// guarantee (a revision commits with its mutation, or neither does). No business
// logic, no transactions, no DTO mapping here.
//
// ⚠️ THE READ TAKES A REQUIRED `tx` TOO, and that is not the usual call for a
// pure read path. `plan_revision` has no `workspace_id` of its own — its policy
// JOINS to the parent `plan` — so an UNBOUND read through the `db` singleton
// matches nothing at all rather than failing: the GUC is unset, the policy's
// predicate is NULL, and `findMany` returns an empty trail on a plan that has
// one. That is the worst shape a tenant read can take, because an empty history
// looks exactly like a plan nobody has touched. Requiring the transaction makes
// the binding a compile-time obligation rather than a thing to remember, the
// same way the write's `tx` does. (Measured: the first draft used `db`, and every
// content event silently vanished from the timeline.)
//
// The read arrived with the surface (MOTIR-3536), one card after the write — the
// trail had to be correct from its first row before anything read it, because the
// rows it misses cannot be recovered later.
//
// No error translation: the table has no triggers, and a cross-workspace write
// attempt is caught by the RLS policy's WITH CHECK (42501) rather than by
// anything this layer needs to interpret.

export const planRevisionRepository = {
  /**
   * Insert one revision row. Required `tx` — a revision MUST commit atomically
   * with the plan mutation it describes. Uses the unchecked create input so the
   * caller passes scalar foreign keys (`planId` / `planItemId` / `changedById`)
   * directly rather than nested `connect` wrappers; the service already holds
   * the ids.
   */
  async create(
    data: Prisma.PlanRevisionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanRevision> {
    return tx.planRevision.create({ data });
  },

  /**
   * One plan's whole trail, OLDEST FIRST — the order the timeline reads in
   * (MOTIR-3536).
   *
   * ⚠️ ONE query for the whole history, deliberately: the plan review model is
   * re-read on every poll of a `generating` plan, and a plan whose trail is a row
   * per proposal would otherwise cost a round trip per row on the surface that
   * polls hardest. It walks the `(plan_id, changed_at)` index end to end.
   *
   * Unbounded, and that is a decision rather than an omission. A trail is bounded
   * by the plan's own authoring — six sites, one row each, plus one per proposal
   * deepened — so it is tens of rows, not thousands, and truncating it would make
   * the timeline silently lie about the one thing it exists to say. If a plan
   * ever grows a trail worth paginating, the pagination belongs on the surface
   * that renders it, where the reader can be told what is not shown.
   */
  async listByPlan(planId: string, tx: Prisma.TransactionClient): Promise<PlanRevision[]> {
    return tx.planRevision.findMany({
      // ⚠️ EVERY caller of this method is a tenant path (MOTIR-6083): the plan
      // review timeline, the revision lease, and the plan gate's held check.
      // None of them has any business with an internal classification — and the
      // lease in particular MUST not see one, because a lease is a claim that a
      // revision is RUNNING, and recording why a change was asked is not doing
      // the change. So the exclusion rides the query and there is nothing for a
      // caller to remember. The one read that wants these rows is
      // `listReasonClassifications` below.
      where: { planId, ...TENANT_VISIBLE_PLAN_REVISION_WHERE },
      orderBy: { changedAt: 'asc' },
    });
  },

  /**
   * The LEASE-BEARING columns of MANY plans' trails in one round trip, oldest first
   * within each plan (Story MOTIR-6012 · MOTIR-6035) — the To-approve page's read of
   * which plan gates are HELD (`revisionLeaseOf`), one query per page rather than one
   * per plan. Only the columns the lease reads.
   */
  async listLeaseRowsByPlans(
    planIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Pick<PlanRevision, 'planId' | 'changeKind' | 'changedAt' | 'actorHarness' | 'actorModel'>[]
  > {
    if (planIds.length === 0) return [];
    return tx.planRevision.findMany({
      // The To-approve page's read, so the same exclusion `listByPlan` carries,
      // for the same reason (MOTIR-6083).
      where: { planId: { in: [...planIds] }, ...TENANT_VISIBLE_PLAN_REVISION_WHERE },
      orderBy: [{ planId: 'asc' }, { changedAt: 'asc' }],
      select: {
        planId: true,
        changeKind: true,
        changedAt: true,
        actorHarness: true,
        actorModel: true,
      },
    });
  },

  /**
   * How many rows of ONE verb a plan's trail holds (MOTIR-4076) — the read the
   * planner-bug VOLUME bound counts on. Required `tx` for the reason `listByPlan`
   * gives, and one more: this read GUARDS a write, so the caller holds the plan's
   * row lock (`planRepository.lockById`) in the same transaction — a count taken
   * outside it could be passed by two filings at once.
   */
  async countByPlanAndKind(
    planId: string,
    changeKind: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    // No exclusion here, and deliberately: this read is ALREADY narrowed to one
    // named verb by its caller, so it can only return an internal kind if the
    // caller asked for one by name. Spreading the exclusion would make
    // `countByPlanAndKind('reason_classified', …)` answer 0 while rows exist —
    // a read that lies, which is the failure the trail's own contract forbids.
    return tx.planRevision.count({ where: { planId, changeKind } });
  },

  /**
   * INTERNAL — every `reason_classified` row, newest first (Story MOTIR-5543 ·
   * MOTIR-6083). The ONE read that returns a classification.
   *
   * ⚠️ THIS HAS NO TENANT SURFACE, and that is the card's deliverable rather
   * than an omission: no route calls it, no MCP tool exposes it, and no DTO
   * carries its shape. It exists so the integration gate can prove the data is
   * actually kept — a write nobody can read back is indistinguishable from a
   * write that silently failed — and so Epic 10 (Platform administration &
   * operations, MOTIR-726) has a seam to build its operator view on.
   *
   * ⚠️ AND IT DELIBERATELY DOES NOT SPREAD `TENANT_VISIBLE_PLAN_REVISION_WHERE`.
   * It is the complement of that fragment, which is why it is the one read that
   * may name the kind: everything else excludes it, this alone selects it.
   *
   * Newest first, unlike `listByPlan`'s oldest-first trail order: a reader of
   * classifications is asking *what has the planner been getting wrong lately*,
   * which is a recency question, while a reader of the trail is reconstructing a
   * history. Cursor-paged on `changedAt` because — unlike a single plan's trail —
   * this read is across plans and unbounded in time.
   */
  async listReasonClassifications(
    args: {
      planId?: string;
      since?: Date;
      branch?: string;
      cursor?: { changedAt: Date; id: string };
      take?: number;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlanRevision[]> {
    const { planId, since, branch, cursor, take = 100 } = args;
    return tx.planRevision.findMany({
      where: {
        changeKind: REASON_CLASSIFIED_KIND,
        ...(planId ? { planId } : {}),
        ...(since ? { changedAt: { gte: since } } : {}),
        // The branch lives inside the count-shaped `diff`, so it is filtered as
        // a JSON path rather than as a column. Postgres reads it off the JSONB
        // directly; no index is warranted while the population is tens of rows
        // per plan.
        ...(branch ? { diff: { path: ['branch'], equals: branch } } : {}),
        // Strict keyset: rows strictly OLDER than the cursor, breaking the
        // `changedAt` tie on `id` so a page boundary landing inside one
        // millisecond neither repeats nor skips a row.
        ...(cursor
          ? {
              OR: [
                { changedAt: { lt: cursor.changedAt } },
                { changedAt: cursor.changedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  },
};
