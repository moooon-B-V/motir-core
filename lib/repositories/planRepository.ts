import { Prisma, type Plan } from '@/generated/prisma/client';
import { db } from '@/lib/db';

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
   * ⚠️ AND IT IS A WHERE CLAUSE, NOT A CALLER-SIDE FILTER. This returns ONE row,
   * newest first: dropping the orphan after the read would answer "not paused"
   * for a project whose real `planned` proposal sits one row down — trading a
   * permanent pause for the stacked proposal the gate exists to prevent.
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
        NOT: { status: 'generating', sourceJobId: null, items: { none: {} } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    limit: number,
    cursorId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan[]> {
    const client = tx ?? db;
    return client.plan.findMany({
      where: { projectId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },
};
