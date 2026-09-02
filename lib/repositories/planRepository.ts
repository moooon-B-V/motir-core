import { Prisma, type Plan, type PlanStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';

/** A plan the abandoned-plan sweep may act on — every `generating` plan past the
 *  grace, carrying the proposal COUNT read in the same statement.
 *
 *  The count is what the sweep's write re-reads against (MOTIR-3189). It used to
 *  be able to assert `0` from the predicate alone; now that a PARTIAL plan is a
 *  candidate, "did the row move under us?" is a comparison rather than a
 *  presence test, and the number has to travel with the candidate to make it.
 *
 *  ⚠️ `sourceJobId` IS NULLABLE HERE, and that is the point (MOTIR-3236). This
 *  type used to narrow it to `string`, restating the predicate's
 *  `sourceJobId: { not: null }` in the type system. The predicate is gone, so
 *  the narrowing is REMOVED rather than weakened: the compiler is what forces
 *  the caller to decide what a plan with no producer means, instead of letting a
 *  `null` reach `resolveJobState` as a job id. */
export type AbandonedPlanCandidate = Plan & {
  _count: { items: number };
};

// Plan repository — single Prisma operations on the `plan` table (Story 7.21 ·
// MOTIR-1336). Writes require `tx` (a compile-time guarantee they run in a
// transaction); pure read paths use the `db` singleton. No business logic, no
// transactions, no DTO mapping — those belong in `plansService`.
export const planRepository = {
  /** A plan by id, scoped to its workspace. Read-only; optional `tx` joins a
   *  surrounding transaction (e.g. the locked re-read inside approve/decline). */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? db;
    return client.plan.findFirst({ where: { id, workspaceId } });
  },

  /**
   * The plan a generation job is producing into, resolved by its `sourceJobId`
   * (the generate seam sets `sourceJobId = jobId` at `createPlan`). Scoped to
   * the workspace so a job token for one tenant can never reach another's plan
   * — a cross-tenant lookup returns `null` (→ 404, never 403). Newest-first so a
   * re-submitted job resolves to its latest plan. Read-only.
   */
  async findBySourceJobId(
    sourceJobId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? db;
    return client.plan.findFirst({
      where: { sourceJobId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The project's UNDECIDED plan, if it has one — the read behind the
   * pending-proposal GATE (MOTIR-916). "Undecided" is `generating` (the engine
   * is still producing it) or `planned` (it is sitting in the human review
   * queue); `approved` / `declined` are decided and do not gate anything.
   *
   * WHO started it is deliberately NOT part of the predicate: a user-clicked
   * expand saturates the reviewer exactly as much as a cadence-fired one, and a
   * second proposal against the same committed tree makes the first STALE
   * (`planStalenessService` warns but never blocks). So any undecided plan
   * pauses cadence for the project, whatever its `origin`.
   *
   * ⚠️ ONE SHAPE IS EXCLUDED, AND IT IS NOT A NARROWING OF THE ABOVE
   * (MOTIR-3051): a `generating` plan with **no producer and no proposals** is
   * not a decision anybody can make. Nothing is in it to review, and nothing is
   * on its way in either — so counting it as pending pauses the project's
   * cadence permanently, with no surface saying why (`autoPlanCadenceService`'s
   * gate 1 is the only consumer, and MOTIR-1740's indicator reads the same
   * verdict).
   *
   * TWO shipped paths produce exactly that row. `create_plan` asserts
   * `work_item:edit` while its partner `add_plan_items` asserts `ai:view_plan`
   * (`docs/decisions/agent-authored-plans.md` Q2), so a grant holding the first
   * and not the second — `CLI_TOKEN_GRANT` — opens a plan and is refused on its
   * first append. And a motir-ai generation that DIES before its first append
   * leaves the same orphan: "a failed job leaves its plan at `generating`
   * forever (nothing writes a terminal plan state on failure)"
   * (`aiPlanEditsService.resolveJobState`). The second path holds whatever the
   * permission map says, which is why the exclusion lives here rather than at
   * the door.
   *
   * ⚠️ THE DISCRIMINATOR IS THE PRODUCER, NOT THE COUNT. Every generator submit
   * sets `sourceJobId` (`aiGenerationService.startGeneration`,
   * `aiPlanEditsService.submitPlanEditJob`) and every agent-authored plan leaves
   * it null (`lib/mcp/tools/authorPlan.ts`). Between a submit's `createPlan` and
   * motir-ai's first append the plan legitimately holds ZERO items — and
   * `autoPlanCadenceTick` is `retryPolicy: 'idempotent'` on precisely the ground
   * that "a project that already fired now HAS an undecided plan, so the gate
   * skips it on the re-run". A rule keyed on the count alone would let an
   * Inngest retry fire a second job at the same stub. So an empty plan with a
   * job still gates; only an empty plan with NO job does not.
   *
   * ⚠️ THAT IS THE RULE FOR `generating`. A `planned` plan holding NO items is
   * excluded too (MOTIR-4124), on the count alone and regardless of producer —
   * a closed plan can never gain one, so there is no window the count could
   * misread, and a plan proposing nothing is a decision nobody owes. The close
   * no longer writes that shape; the rows that predate it still exist.
   *
   * ⚠️ AND IT IS A WHERE CLAUSE, NOT A CALLER-SIDE FILTER. This returns ONE row,
   * newest first: dropping the orphan after the read would answer "not paused"
   * for a project whose real `planned` proposal sits one row down — trading a
   * permanent pause for the stacked proposal the gate exists to prevent.
   *
   * ⚠️ THE OTHER HALF — a plan whose PRODUCER died — is not reachable from here
   * and never was: that row carries a `sourceJobId`, so it is identical to a
   * healthy in-flight generation until somebody asks the job. It is reconciled
   * OUT of `generating` by `abandonedPlanService.reconcileAbandoned`
   * (MOTIR-3064, which took the empty ones; MOTIR-3189, which took the partial
   * ones too), so by the time this read sees it, it is `declined` and decided.
   * The predicate below is unchanged by BOTH fixes, deliberately: a gate that
   * guessed at liveness is the thing AMENDMENT 2 rejected, and widening the
   * sweep does not make guessing here any better an idea.
   *
   * Newest first, so the ONE row returned is the plan a caller would show. Takes
   * an optional `tx` because both consumers read it inside a workspace context
   * (correct under the non-bypass `motir_app` role, where the plan policy keys
   * on the per-transaction workspace GUC).
   */
  async findUndecidedByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? db;
    return client.plan.findFirst({
      where: {
        projectId,
        workspaceId,
        status: { in: ['generating', 'planned'] },
        AND: [
          { NOT: { status: 'generating', sourceJobId: null, items: { none: {} } } },
          // ⚠️ A CLOSED plan holding NOTHING is nobody's decision either
          // (MOTIR-4124). `markPlanned` no longer produces this shape — an
          // empty close is DISCARDED — but rows written before that fix are
          // still `planned` with zero items, and each of them silences its
          // project's cadence for ever: nothing expires a `planned` plan, and
          // the abandoned sweep only reaches `generating` ones.
          //
          // ⚠️ AND THE COUNT IS SAFE HERE, WHERE THE PARAGRAPH ABOVE SAYS IT IS
          // NOT. That warning is about `generating`, where zero items is the
          // ordinary window between a submit's `createPlan` and the producer's
          // first append — which is why the discriminator there is the PRODUCER.
          // A `planned` plan is closed: it can never gain an item, so an empty
          // one is empty for good and there is no window to misread.
          { NOT: { status: 'planned', items: { none: {} } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The ABANDONED-PLAN candidates, across workspaces — the discovery read behind
   * the reconciling sweep (MOTIR-3064; widened to PARTIAL plans by MOTIR-3189).
   * Returns `generating` plans that have a PRODUCER and are older than
   * `olderThan`, whatever they hold; the sweep then asks motir-ai what became of
   * each one's job and terminates only the ones whose producer is provably gone.
   *
   * THIS IS THE OTHER HALF OF {@link findUndecidedByProject}'s exclusion, and the
   * two are deliberately disjoint. MOTIR-3051 excluded the orphan with NO
   * producer, because that row can be judged from itself. This one carries a
   * `sourceJobId`, so it is indistinguishable BY THE ROW from a generation that
   * is going perfectly well and simply has not appended yet — the answer is not
   * in the plan table at all, it is in whether the job behind it is still alive.
   * So the gate cannot widen to cover it, and a sweep that ASKS is the shape
   * (`docs/decisions/agent-authored-plans.md` AMENDMENT 2).
   *
   * ⚠️ `olderThan` IS A CORRECTNESS ARGUMENT, NOT A PERFORMANCE ONE. Between
   * `submitExpand`'s `createPlan` and motir-ai's first append a healthy plan
   * holds zero items with a live job — the exact shape this read selects. The age
   * bound is what keeps the sweep out of that window entirely, so it can never
   * race a submit it would otherwise be asking about milliseconds after it
   * happened.
   *
   * ⚠️ IT IS NO LONGER EMPTY-ONLY (MOTIR-3189), AND THE EXCLUSION DID NOT FALL
   * FOR BEING TOO CAUTIOUS. MOTIR-3064 AC 5 read: *"a PARTIAL plan is a real
   * proposal a person can read and decline — the release valve works there, so
   * nothing here may touch it."* Read, yes. Decline, no: `declinePlan` and
   * `approvePlan` both re-read under their row lock and refused anything but
   * `planned`, so there was no path out of `generating` for anyone — not the
   * sweep, not a person, not a token. The exclusion protected a human decision
   * the status guard made impossible, and stranded every partial plan
   * permanently, which is the same harm MOTIR-3064 existed to remove:
   * `findUndecidedByProject` reads `generating` as UNDECIDED whatever the plan
   * holds. The valve is real now — `declinePlan` accepts `generating` and
   * records `discarded` — and this arm covers the plans nobody is coming back
   * to look at.
   *
   * ⚠️ SO THE COUNT IS SELECTED RATHER THAN ASSERTED, AND THE WRITE COMPARES IT.
   * `items: { none: {} }` was doing two jobs — the filter here, and the write's
   * did-it-move guard. With the filter gone the guard cannot stay a presence
   * test, so the candidate carries `_count.items` and the write refuses on a
   * MISMATCH. `row_moved` then keeps meaning exactly what it always meant (the
   * row changed between the ask and the act) while a plan that was ALREADY
   * partial at discovery goes through.
   *
   * Cross-workspace, so it runs under `withSystemContext` against the plan
   * policy's `FOR SELECT` system arm; every write the sweep then makes re-binds
   * to that row's own workspace. **`plan_item` still needs its arm, and the
   * direction has REVERSED into the safe one.** Under `items: { none: {} }` an
   * RLS-hidden proposal made a correlated `NOT EXISTS` vacuously true and
   * WIDENED the scan onto exactly the rows the exclusion protected. Under
   * `_count` a hidden proposal reads the count LOW, the write re-counts under
   * the plan's own workspace context, the two disagree, and the verdict is
   * `row_moved` — nothing is terminated. A blind spot here now costs a pass
   * rather than a plan. The arm (MOTIR-3064's migration) stays: the scan reads
   * `plan_item` either way, and a permanently-`row_moved` sweep is a broken one.
   *
   * Bounded by `take` and ordered oldest-first, so a backlog drains over
   * successive passes rather than in one long transaction.
   */
  async listAbandonedCandidates(
    olderThan: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<AbandonedPlanCandidate[]> {
    // ⚠️ NO `sourceJobId` PREDICATE (MOTIR-3236). This clause used to read
    // `sourceJobId: { not: null }`, and the cast that followed stated that
    // narrowing in the type system. Both are gone, and the reason is a shape
    // rather than one more case: the predicate had become a WHITELIST of the
    // plan shapes the sweep knew how to judge, so each newly-recognised shape
    // cost a schema-adjacent query edit (MOTIR-3051, MOTIR-3064, MOTIR-3189, and
    // then the job-less plan this one is about — four defects, one shape).
    //
    // So SELECTION is now the cheap, total question — is it `generating` and
    // past the grace? — and the JUDGEMENT is `classifyAbandonedCandidate`, a
    // pure decision table with a unit test per arm. `sourceJobId` is an INPUT to
    // that table now, not a condition of being seen by it; the next unrecognised
    // shape is a new arm, not a new migration-adjacent predicate.
    return tx.plan.findMany({
      where: {
        status: 'generating',
        createdAt: { lte: olderThan },
      },
      include: { _count: { select: { items: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  async create(data: Prisma.PlanUncheckedCreateInput, tx: Prisma.TransactionClient): Promise<Plan> {
    return tx.plan.create({ data });
  },

  /**
   * Take a row lock on the plan (`SELECT … FOR UPDATE`) so a status-deciding
   * write (markPlanned / approve / decline) serializes against a concurrent
   * decider on the SAME plan — the lost-update guard for the one-shot
   * generating→planned→decided lifecycle (the `notes.html` lock-before-
   * read-derived-update rule). Returns the id, or `null` when the plan does not
   * exist; the caller re-reads the current row under the lock to re-validate
   * the status.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: Prisma.PlanUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Plan> {
    return tx.plan.update({ where: { id }, data });
  },

  /**
   * A project's plans, newest first, keyset-paginated. `cursorId` is the id of
   * the last plan on the previous page (omitted for the first page); `limit`
   * rows are returned. Ordered (createdAt desc, id desc) so the cursor is
   * stable even when two plans share a `createdAt`.
   *
   * `status` NARROWS the page to one lifecycle status (MOTIR-3235, for the
   * tabbed list) and is applied HERE, in the `where` — not by the caller after
   * the read. A caller-side filter would take the `limit + 1` cursor page and
   * then shrink it, so a `planned` page would come back short while
   * `nextCursor` still claimed there was more. `null` / omitted ⇒ the whole
   * project, exactly as before this argument existed.
   *
   * ⚠️ IT ALSO TAKES A SET (MOTIR-4106), and for the SAME reason it is a `where`
   * clause rather than a caller-side filter. The AI boundary asks a question the
   * tabbed list never did — *which plans are PENDING?* — and "pending" is more
   * than one status, so a single-value argument left that caller either reading
   * one status per round trip and merging (three pages, three cursors, one
   * ordering nobody owns) or reading the whole project and shrinking it, which
   * is the exact defect the paragraph above rejects. An ARRAY compiles to
   * `status: { in: [...] }` and keeps the page, the ordering and the cursor a
   * property of ONE query. An EMPTY array is a caller asking for nothing and is
   * honoured as such — `{ in: [] }` matches no row — never silently widened to
   * the whole project, which is what treating it as falsy would do.
   *
   * Served by `@@index([projectId, status, createdAt])`: the narrowed set is
   * already in `createdAt` order under the index, so the keyset walk never
   * sorts a status in the heap.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    limit: number,
    cursorId: string | null,
    tx?: Prisma.TransactionClient,
    status?: PlanStatus | readonly PlanStatus[] | null,
  ): Promise<Plan[]> {
    const client = tx ?? db;
    const statusWhere =
      status == null ? {} : { status: typeof status === 'string' ? status : { in: [...status] } };
    return client.plan.findMany({
      where: { projectId, workspaceId, ...statusWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },

  /**
   * How many plans this project holds per lifecycle status, in ONE `groupBy`
   * (MOTIR-3235) — the numbers the tab strip renders beside its labels.
   *
   * Returns only the statuses that HAVE rows; zero-filling over the enum is the
   * service's job, because the enum the surface must be total over is the DTO
   * vocabulary and this layer does not map DTOs.
   *
   * One query for the whole strip rather than four counts: four round-trips to
   * render four numbers on one page is the shape `countByWorkItemIds` already
   * rejected one surface over.
   */
  async countByStatus(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ status: PlanStatus; count: number }>> {
    const client = tx ?? db;
    const rows = await client.plan.groupBy({
      by: ['status'],
      where: { projectId, workspaceId },
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  },
};
