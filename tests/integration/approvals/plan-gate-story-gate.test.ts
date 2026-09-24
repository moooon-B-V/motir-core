import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkItemFixture } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — APPROVING A PLAN IS AN APPROVAL GATE (Story MOTIR-6012 · Subtask MOTIR-6040;
// ADR `docs/decisions/approval-gates.md` §11).
//
// ⚠️ WHAT THIS FILE IS NOT. Every child card shipped its own suite against real Postgres,
// and those suites already prove each piece at its own boundary — the schema's CHECK,
// indexes, trigger and RLS (`tests/approvalGates/planApprovalGateSchema.test.ts`), the
// reads over a card-less row (`cardlessGateReads.test.ts`), the handler, digest, hold,
// stamp and lock order (`planApprovalHandler.test.ts`), the raise / supersede lifecycle
// and its concurrency (`planGateLifecycle.test.ts`), the one decision service and its
// source inventory (`planDecisionEntrances.test.ts`), the generic route's plan arm
// (`tests/integration/approvals/refusalReasonSeam.test.ts`) and the backfill
// (`planGateBackfill.test.ts`). None of that is re-asserted here.
//
// WHAT IS. The joints those suites each mock or seed across, driven END TO END through
// the shipped entrances, with nothing written by hand:
//
//   · the queue reads were proved over SEEDED card-less rows; here the row a real CLOSE
//     raises is what the queue, its count and the record room return — and what they
//     stop returning once a real entrance decided it;
//   · the entrances were proved through `planDecisionService`; here the three HTTP
//     entrances (the plan route, the v1 plan-approval route, the generic decide route)
//     each decide the SAME raised gate, and each of the other two then hears the
//     question answered without materializing a second time;
//   · the planning surface's CLIENT (`lib/planning/planReviewClient.ts`) reads its stamp
//     from the real review route and declines through the real decline route — the
//     request it builds is the one under test, not a restatement of it;
//   · HELD, the stale stamp and the decision after the lease, through the plan routes and
//     the queue together;
//   · every plain status writer of §11.8, run in one tenant, leaves no decision record.
//
// Mocked: the cookie-bound session readers and next-intl's request config (a Vitest
// process has no request), the motir-ai boundary the v1 session submit mints its job id from, the job bus, and
// `revalidatePath`. Every route, service, repository, trigger and index is real.

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
const activeProject = { current: null as unknown };
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeProject.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The approve route resolves the onboarding placeholder name through next-intl, which
// needs a request-scoped config the node env has none of; echo the key.
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

const { submitJob } = await import('@/lib/ai/motirAiClient');
const { plansService } = await import('@/lib/services/plansService');
const { planDriftService } = await import('@/lib/services/planDriftService');
const { abandonedPlanService } = await import('@/lib/services/abandonedPlanService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { planDecisionService } = await import('@/lib/services/planDecisionService');
const { ApprovalGateAlreadyDecidedError } = await import('@/lib/approvalGates/errors');
const { PlanNotInExpectedStatusError } = await import('@/lib/plans/errors');
const { fetchPlanReview, declinePlanRequest, approvePlanRequest } =
  await import('@/lib/planning/planReviewClient');
const { GET: reviewRoute } = await import('@/app/api/plans/[id]/route');
const { POST: approveRoute } = await import('@/app/api/plans/[id]/approve/route');
const { POST: declineRoute } = await import('@/app/api/plans/[id]/decline/route');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { POST: v1ApproveRoute } = await import('@/app/api/v1/work-items/[key]/plan-approval/route');
const { POST: sessionSubmitRoute } =
  await import('@/app/api/v1/projects/[projectKey]/plan-session/submissions/route');
const { POST: sessionTurnRoute } =
  await import('@/app/api/v1/projects/[projectKey]/plan-session/turns/route');
const { decideApprovalGateAction } = await import('@/app/(authed)/items/[key]/approvalGateActions');

const BASE = 'http://localhost:3000';
const HARNESS = { source: 'mcp' as const, harness: 'Claude Code', model: null };
const DONE = { fromStatusKey: 'in_progress', toStatusKey: 'done' };
const REVIVE = { fromStatusKey: 'done', toStatusKey: 'in_progress' };
/** The operator `motir auto --auto-approve-replan` runs as (the v1 route's own suite). */
const OPERATOR = [
  'project:browse',
  'work_item:edit',
  'ai:plan',
  'ai:view_plan',
  'ai:decide_plan',
] as const;

let caller: V1ProjectCaller;
let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  vi.clearAllMocks();
  caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
  fx = caller.fixture;
  signedIn.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name } };
  activeProject.current = { ...fx.ctx, projectId: fx.projectId, project: fx.project };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── reads of the record ────────────────────────────────────────────────────

const gatesOf = (planId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'plan_approval', subjectId: planId },
    orderBy: { createdAt: 'asc' },
  });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const workItemCount = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
const meCtx = (userId = fx.ownerId) => ({ ...fx.ctx, userId, projectId: fx.projectId });

// ─── plans, written by the product ──────────────────────────────────────────

/** A `generating` plan proposing one `add` per title (none → an empty plan). */
async function draftPlan(titles: string[], createdById?: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'A plan', ...(createdById ? { createdById } : {}) },
    fx.ctx,
  );
  const itemIds: string[] = [];
  for (const title of titles) {
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    itemIds.push(after.items[after.items.length - 1]!.id);
  }
  return { planId: plan.id, itemIds };
}

/**
 * A `planned` plan ANCHORED at a card, produced the way the v1 route's loop meets one:
 * a plan-change conversation about the card, submitted through the real v1 session
 * routes, its proposals appended and the plan CLOSED — which raises its gate. Built this
 * way so all three entrances, the v1 one included, can reach the same plan.
 */
async function anchoredPlan(titles: string[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The card the plan is about' },
    fx.ctx,
  );
  vi.mocked(submitJob).mockResolvedValue({ jobId: `job_${item.identifier}` } as Awaited<
    ReturnType<typeof submitJob>
  >);
  const sessionReq = (suffix: string, body: unknown) =>
    new Request(`${BASE}/api/v1/projects/${caller.projectKey}/plan-session${suffix}`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const args = { params: Promise.resolve({ projectKey: caller.projectKey }) };
  const targetKeys = [item.identifier];
  await sessionTurnRoute(sessionReq('/turns', { body: 'Rework this', targetKeys }), args);
  const submitted = await sessionSubmitRoute(sessionReq('/submissions', { targetKeys }), args);
  expect(submitted.status).toBe(202);
  const { planId } = (await submitted.json()) as { planId: string };
  for (const title of titles) {
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
  }
  await plansService.markPlanned(planId, fx.ctx);
  return { key: item.identifier, planId };
}

/** A closed plan proposing to `modify` a real card — the drift fixture. */
async function planTargeting() {
  const target = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'A target' },
    fx.ctx,
  );
  const plan = await plansService.createPlan(fx.projectId, { title: 'Rework' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: target.id, patch: { title: 'New' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, targetId: target.id };
}

// ─── the entrances, as a caller reaches them ────────────────────────────────

type Wire = { status: number; body: Record<string, unknown> };
const wire = async (res: Response): Promise<Wire> => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, body?: unknown) =>
  new Request(`${BASE}${url}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The planning surface's render read — `GET /api/plans/[id]` — and the stamp on it. */
async function shownStamp(planId: string): Promise<string> {
  const res = await wire(
    await reviewRoute(new Request(`${BASE}/api/plans/${planId}`), idParams(planId)),
  );
  expect(res.status).toBe(200);
  const stamp = (res.body.gate as { stamp: string | null } | null)?.stamp;
  expect(typeof stamp).toBe('string');
  return stamp!;
}

const viaPlanApprove = async (planId: string, body?: unknown) =>
  wire(await approveRoute(post(`/api/plans/${planId}/approve`, body), idParams(planId)));
const viaPlanDecline = async (planId: string, body?: unknown) =>
  wire(await declineRoute(post(`/api/plans/${planId}/decline`, body), idParams(planId)));
const viaDecideRoute = async (gateId: string, body: unknown) =>
  wire(await decideRoute(post(`/api/approval-gates/${gateId}/decide`, body), idParams(gateId)));
const viaV1 = async (key: string) =>
  wire(
    await v1ApproveRoute(
      new Request(`${BASE}/api/v1/work-items/${key}/plan-approval`, {
        method: 'POST',
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key }) },
    ),
  );

/** Route the planning surface's `fetch` to the real plan handlers — a Vitest process
 *  has no server. The client owns its method, path and body; nothing is restated. */
function routeClientFetch(): { url: string; method: string; body: unknown }[] {
  const seen: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({ url, method, body });
    const [, rest] = url.split('/api/plans/');
    const [rawId, action] = rest!.split('/');
    const id = decodeURIComponent(rawId!);
    const req = new Request(`${BASE}${url}`, { method, body: init?.body ?? undefined });
    if (action === 'approve') return approveRoute(req, idParams(id));
    if (action === 'decline') return declineRoute(req, idParams(id));
    return reviewRoute(req, idParams(id));
  });
  return seen;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('SEAM · close → raise → queue → decide → record (§11.6, §11.7 row 1)', () => {
  it('the gate a real CLOSE raises is what the queue, its count and the record room return — until an entrance decides it', async () => {
    const other = await createTestUser({ email: 'asker@ex.com', name: 'Asker' });
    await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });

    // A cadence-shaped plan (nobody asked) → the workspace OWNER; a requested plan → the
    // person who asked; an EMPTY close → no question at all.
    const cadence = await draftPlan(['One', 'Two']);
    await plansService.markPlanned(cadence.planId, fx.ctx);
    const requested = await draftPlan(['Theirs'], other.id);
    await plansService.markPlanned(requested.planId, fx.ctx);
    const empty = await draftPlan([]);
    await plansService.markPlanned(empty.planId, fx.ctx);

    expect(await gatesOf(empty.planId)).toEqual([]);
    const [cadenceGate] = await gatesOf(cadence.planId);
    const [requestedGate] = await gatesOf(requested.planId);

    // The OWNER's queue: the cadence plan, card-less, its subject read from the plan.
    const mine = await approvalGatesService.listAwaitingMe(meCtx());
    expect(mine.items.map((r) => r.gateId)).toEqual([cadenceGate!.id]);
    expect(mine.items[0]).toMatchObject({
      kind: 'plan_approval',
      state: 'awaiting',
      workItem: null,
      canDecide: true,
      subject: { kind: 'plan_approval', planId: cadence.planId, proposalCount: 2, held: null },
    });
    expect(await approvalGatesService.countAwaitingMe(meCtx())).toBe(1);

    // The ASKER's queue: their plan, and only theirs.
    const theirs = await approvalGatesService.listAwaitingMe(meCtx(other.id));
    expect(theirs.items.map((r) => r.gateId)).toEqual([requestedGate!.id]);
    expect(await approvalGatesService.countAwaitingMe(meCtx(other.id))).toBe(1);

    // The record room lists both raised questions, neither as if it had a card.
    const open = await approvalGatesService.listRecords(meCtx(), { limit: 50 });
    expect(open.sections.awaiting.items.map((r) => [r.gateId, r.workItem])).toEqual(
      expect.arrayContaining([
        [cadenceGate!.id, null],
        [requestedGate!.id, null],
      ]),
    );

    // DECIDE the owner's through the plan route, with the stamp the review read showed.
    const res = await viaPlanApprove(cadence.planId, { stamp: await shownStamp(cadence.planId) });
    expect(res.status).toBe(200);

    expect(await approvalGatesService.countAwaitingMe(meCtx())).toBe(0);
    expect((await approvalGatesService.listAwaitingMe(meCtx())).items).toEqual([]);
    // …and the asker's question is untouched by it.
    expect(await approvalGatesService.countAwaitingMe(meCtx(other.id))).toBe(1);

    const after = await approvalGatesService.listRecords(meCtx(), { limit: 50 });
    const decided = after.sections.decided.items.find((r) => r.gateId === cadenceGate!.id);
    expect(decided).toMatchObject({
      kind: 'plan_approval',
      state: 'approved',
      workItem: null,
      decisionSource: 'api',
      subject: { kind: 'plan_approval', planId: cadence.planId },
    });
    expect(decided!.subjectVersion).toMatch(/^plan\.v1\.[0-9a-f]{64}$/);
    expect(after.sections.awaiting.items.map((r) => r.gateId)).toEqual([requestedGate!.id]);
  });
});

describe('SEAM · every entrance decides the SAME raised gate — one record, one materialize (§11.4, §11.5, §11.8)', () => {
  type Entrance = 'plan route' | 'v1 plan-approval route' | 'generic decide route';
  const ENTRANCES: Entrance[] = ['plan route', 'v1 plan-approval route', 'generic decide route'];

  async function approveVia(
    entrance: Entrance,
    plan: { key: string; planId: string },
    gateId: string,
  ): Promise<Wire> {
    if (entrance === 'plan route') {
      // A reader who rendered the plan presses with what they were shown; a press that
      // arrives after the question was answered was shown no stamp.
      const gate = await approvalGatesService.getForPlan({ planId: plan.planId }, fx.ctx);
      return viaPlanApprove(plan.planId, gate.stamp ? { stamp: gate.stamp } : undefined);
    }
    if (entrance === 'v1 plan-approval route') return viaV1(plan.key);
    const gate = await approvalGatesService.getForPlan({ planId: plan.planId }, fx.ctx);
    return viaDecideRoute(gateId, { decision: 'approve', stamp: gate.stamp ?? 'plan.v1.none' });
  }

  it.each(ENTRANCES)(
    '%s decides it; the other two hear it answered and materialize nothing',
    async (entrance) => {
      const plan = await anchoredPlan(['First', 'Second']);
      const [raised] = await gatesOf(plan.planId);
      expect(raised).toMatchObject({ state: 'awaiting', workItemId: null });
      const before = await workItemCount();

      const res = await approveVia(entrance, plan, raised!.id);
      expect(res.status).toBe(200);
      if (entrance === 'generic decide route') {
        expect(res.body.effect).toEqual({
          statusWritten: null,
          statusDeferredReason: 'plan_decision_writes_no_work_item',
        });
      }

      // ONE decision record — the gate the close raised, not a second row.
      const gates = await gatesOf(plan.planId);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        id: raised!.id,
        state: 'approved',
        decidedById: fx.ownerId,
        decidedUnderAuthority: 'plan_permission',
        decisionSource: 'api',
        outcomeRef: null,
      });
      expect(gates[0]!.subjectVersion).toMatch(/^plan\.v1\./);
      // ONE materialize.
      expect(await workItemCount()).toBe(before + 2);
      expect((await planRow(plan.planId)).status).toBe('approved');

      // Every OTHER entrance meets an answered question, in its own refusal language.
      for (const otherEntrance of ENTRANCES.filter((e) => e !== entrance)) {
        const again = await approveVia(otherEntrance, plan, raised!.id);
        expect(again.status, otherEntrance).toBe(409);
        expect(again.body.code, otherEntrance).toBe(
          otherEntrance === 'v1 plan-approval route'
            ? 'PLAN_NOT_IN_EXPECTED_STATUS'
            : 'APPROVAL_GATE_ALREADY_DECIDED',
        );
      }
      expect(await workItemCount()).toBe(before + 2);
      expect(await gatesOf(plan.planId)).toEqual(gates);
    },
  );

  it('`request_changes` is refused on every entrance that carries a verb — `request_changes_on_plan`', async () => {
    // The plan routes and the v1 route carry NO verb: the path is the verb (approve /
    // decline), so a request-changes press cannot be expressed there. The two entrances
    // that take a verb are the generic decide route and the frame's server action.
    const plan = await anchoredPlan(['Only']);
    const [gate] = await gatesOf(plan.planId);
    const stamp = await shownStamp(plan.planId);

    const route = await viaDecideRoute(gate!.id, {
      decision: 'request_changes',
      noteMd: 'Split it differently',
      stamp,
    });
    expect(route.status).toBe(400);
    expect(route.body).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'request_changes_on_plan',
    });

    const action = await decideApprovalGateAction({
      gateId: gate!.id,
      decision: 'request_changes',
      identifier: plan.key,
      noteMd: 'Split it differently',
      stamp,
    });
    expect(action).toMatchObject({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' },
    });

    expect(await gatesOf(plan.planId)).toEqual([
      expect.objectContaining({ id: gate!.id, state: 'awaiting', noteMd: null }),
    ]);
    expect((await planRow(plan.planId)).status).toBe('planned');
  });
});

describe('SEAM · DECLINE from the planning surface’s client (§11.4, §11.8 item 5)', () => {
  it.each([
    ['with a note', 'Not this quarter'],
    ['without a note', null],
  ] as const)(
    '%s: the client’s stamp and note reach the door; gate `declined`, plan `declined` / `reviewed`',
    async (_label, note) => {
      const { planId } = await draftPlan(['One']);
      await plansService.markPlanned(planId, fx.ctx);
      const [gate] = await gatesOf(planId);
      const seen = routeClientFetch();

      const review = await fetchPlanReview(planId);
      expect(review.gate).toMatchObject({ id: gate!.id, state: 'awaiting', held: null });
      const declined = await declinePlanRequest(planId, review.gate!.stamp, note);
      expect(declined.status).toBe('declined');

      expect(seen.map((s) => [s.method, s.url])).toEqual([
        ['GET', `/api/plans/${planId}`],
        ['POST', `/api/plans/${planId}/decline`],
      ]);
      expect(await gatesOf(planId)).toEqual([
        expect.objectContaining({
          id: gate!.id,
          state: 'declined',
          noteMd: note,
          decidedById: fx.ownerId,
          decidedUnderAuthority: 'plan_permission',
        }),
      ]);
      expect(await planRow(planId)).toMatchObject({
        status: 'declined',
        decisionReason: 'reviewed',
      });

      // The room reads the reason back out — or none, and none is a complete decline.
      const room = await approvalGatesService.listRecords(meCtx(), { limit: 50 });
      expect(room.sections.decided.items.find((r) => r.gateId === gate!.id)).toMatchObject({
        state: 'declined',
        workItem: null,
        refusalReason: note,
      });
      // …and a later approve from the same client is refused, materializing nothing.
      const before = await workItemCount();
      await expect(approvePlanRequest(planId, null)).rejects.toMatchObject({
        status: 409,
        code: 'APPROVAL_GATE_ALREADY_DECIDED',
      });
      expect(await workItemCount()).toBe(before);
    },
  );

  it('declining a `generating` plan from the client is a PLAIN write — no gate, no decision record', async () => {
    const { planId } = await draftPlan(['Half written']);
    routeClientFetch();
    const declined = await declinePlanRequest(planId, null);
    expect(declined.status).toBe('declined');
    expect((await planRow(planId)).decisionReason).toBe('discarded');
    expect(await gatesOf(planId)).toEqual([]);
  });
});

describe('SEAM · HELD, then decidable again — through the plan routes and the queue (§11.5c, §11.3)', () => {
  it('while the lease runs the SAME gate stays in the queue with `held`, both verbs are refused; after it, a stamp from before is stale and a fresh one decides it', async () => {
    const plan = await anchoredPlan(['One', 'Two']);
    const [gate] = await gatesOf(plan.planId);
    const before = await shownStamp(plan.planId);
    const items = await workItemCount();

    await plansService.acquireRevisionLease(plan.planId, fx.ctx, HARNESS);

    // Still ASKED — still listed, still counted, and the row says why it cannot be pressed.
    const queue = await approvalGatesService.listAwaitingMe(meCtx());
    expect(queue.items.map((r) => r.gateId)).toEqual([gate!.id]);
    expect(queue.items[0]!.subject).toMatchObject({
      held: { reason: 'revision_in_flight', heldBy: 'Claude Code' },
    });
    expect(await approvalGatesService.countAwaitingMe(meCtx())).toBe(1);

    for (const press of [viaPlanApprove, viaPlanDecline]) {
      const refused = await press(plan.planId, { stamp: before });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_REVISION_IN_FLIGHT',
        heldBy: 'Claude Code',
      });
    }

    // The planner rewrites the plan inside the lease, then lets go.
    await plansService.addProposals(
      plan.planId,
      [{ op: 'add', proposedFields: { title: 'Added in the revision', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );
    await plansService.releaseRevisionLease(plan.planId, fx.ctx, HARNESS);

    // Nothing superseded, nothing re-raised.
    expect(await gatesOf(plan.planId)).toEqual([gate]);

    // A press against the version read BEFORE the rewrite is refused stale.
    const stale = await viaPlanApprove(plan.planId, { stamp: before });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'APPROVAL_GATE_STALE_SUBJECT' });
    expect((await planRow(plan.planId)).status).toBe('planned');

    // A fresh read decides the SAME gate against the new version.
    const fresh = await shownStamp(plan.planId);
    expect(fresh).not.toBe(before);
    const approved = await viaPlanApprove(plan.planId, { stamp: fresh });
    expect(approved.status).toBe(200);
    expect(await gatesOf(plan.planId)).toEqual([
      expect.objectContaining({ id: gate!.id, state: 'approved' }),
    ]);
    expect(await workItemCount()).toBe(items + 3);
  });
});

describe('GUARD · the non-decision writers of §11.8 leave no decision record', () => {
  it('markPlanned, drift (both ways), the last-withdrawal discard, the abandoned sweep and a plain decline write `Plan.status` and decide no gate', async () => {
    // markPlanned — a raise, and an EMPTY close.
    const closed = await draftPlan(['A', 'B']);
    await plansService.markPlanned(closed.planId, fx.ctx);
    const empty = await draftPlan([]);
    await plansService.markPlanned(empty.planId, fx.ctx);
    expect((await planRow(empty.planId)).status).toBe('declined');

    // Drift: planned → stale → planned → stale, then a PLAIN decline of the stale plan.
    const drifting = await planTargeting();
    await adminDb.workItem.update({ where: { id: drifting.targetId }, data: { status: 'done' } });
    await planDriftService.markStaleForTerminalTarget(drifting.targetId, fx.workspaceId, DONE);
    await adminDb.workItem.update({
      where: { id: drifting.targetId },
      data: { status: 'in_progress' },
    });
    await planDriftService.restoreForRevivedTarget(drifting.targetId, fx.workspaceId, REVIVE);
    expect((await planRow(drifting.planId)).status).toBe('planned');
    await adminDb.workItem.update({ where: { id: drifting.targetId }, data: { status: 'done' } });
    await planDriftService.markStaleForTerminalTarget(drifting.targetId, fx.workspaceId, DONE);
    expect((await viaPlanDecline(drifting.planId)).status).toBe(200);

    // The last-withdrawal discard.
    const emptied = await draftPlan(['Only']);
    await plansService.markPlanned(emptied.planId, fx.ctx);
    await plansService.withdrawProposal(emptied.planId, emptied.itemIds[0]!, fx.ctx);

    // A plain decline of a `generating` plan, and the abandoned sweep.
    const discarded = await draftPlan(['Never finished']);
    expect((await viaPlanDecline(discarded.planId)).status).toBe(200);
    const dead = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'generating',
        sourceJobId: 'job_dead',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await abandonedPlanService.reconcileAbandoned({
      deps: { resolveJobState: async () => ({ status: 'failed', reachable: true, failure: null }) },
    });

    // Every plan ended or moved as each writer says…
    expect(
      await Promise.all(
        [drifting.planId, emptied.planId, discarded.planId, dead.id].map(async (id) => {
          const p = await planRow(id);
          return [p.status, p.decisionReason];
        }),
      ),
    ).toEqual([
      // A person declining a `stale` plan reviewed it; nobody's question was answered.
      ['declined', 'reviewed'],
      ['declined', 'discarded'],
      ['declined', 'discarded'],
      ['declined', 'abandoned'],
    ]);

    // …and no gate in the tenant carries a decision: every row is still asked or was
    // withdrawn, and none names a decider, an authority, a time or a source.
    const rows = await adminDb.approvalGate.findMany({
      where: { workspaceId: fx.workspaceId, kind: 'plan_approval' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['awaiting', 'superseded']).toContain(row.state);
      expect(row).toMatchObject({
        decidedAt: null,
        decidedById: null,
        decidedUnderAuthority: null,
        decisionSource: null,
      });
    }
    expect(rows.map((r) => [r.subjectId, r.state, r.supersededCause]).sort()).toEqual(
      [
        [closed.planId, 'awaiting', null],
        [drifting.planId, 'superseded', 'plan_stale'],
        [drifting.planId, 'superseded', 'plan_stale'],
        [emptied.planId, 'superseded', 'plan_discarded'],
      ].sort(),
    );
  });
});

describe('RESIDUE · the entrances’ refusals of a plan with no question to decide', () => {
  it('an unknown plan is 404 at both plan routes — nothing to decide, nothing named', async () => {
    for (const press of [viaPlanApprove, viaPlanDecline]) {
      const res = await press('no-such-plan', { stamp: 'plan.v1.none' });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'PLAN_NOT_FOUND' });
    }
  });

  it('a press whose body is not JSON carries no stamp — an asked plan refuses it 400, a draft is discarded plainly', async () => {
    const { planId } = await draftPlan(['Asked']);
    await plansService.markPlanned(planId, fx.ctx);
    const garbled = (id: string) =>
      new Request(`${BASE}/api/plans/${id}/decline`, { method: 'POST', body: '{stamp:' });
    const refused = await wire(await declineRoute(garbled(planId), idParams(planId)));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'PLAN_DECISION_STAMP_REQUIRED' });
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);

    const draft = await draftPlan(['Never finished']);
    const discarded = await wire(await declineRoute(garbled(draft.planId), idParams(draft.planId)));
    expect(discarded.status).toBe(200);
    expect(await gatesOf(draft.planId)).toEqual([]);
  });

  it('declining a plan DECIDED BEFORE ITS GATE EXISTED is refused, not re-decided', async () => {
    // Every plan approved before this story shipped is `approved` with no gate row. It is
    // not `planned` (so not "not decidable yet"), not `generating` / `stale` (so not a
    // plain discard) — a decline names the statuses it acts on.
    const { planId } = await draftPlan(['Long since approved']);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });
    const res = await viaPlanDecline(planId, { stamp: 'plan.v1.none' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_NOT_IN_EXPECTED_STATUS' });
    expect(await gatesOf(planId)).toEqual([]);
    expect((await planRow(planId)).status).toBe('approved');
  });

  it('the v1 status refusal of a plan that no longer resolves reads `unknown` — defensive: no product path deletes a Plan (§11.2)', async () => {
    const refusal = await planDecisionService.asPlanStatusRefusal(
      new ApprovalGateAlreadyDecidedError('gate-x', 'approved', null, null, null),
      'no-such-plan',
      fx.ctx,
    );
    expect(refusal).toBeInstanceOf(PlanNotInExpectedStatusError);
    expect((refusal as InstanceType<typeof PlanNotInExpectedStatusError>).actual).toBe('unknown');
  });
});
