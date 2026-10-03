import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunOpenedSchema } from '@/lib/api/v1/workLoop/schema';
import { approvalGatePendingSchema } from '@/lib/api/v1/workItems/schema';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr } from '../../helpers/repairFixtures';
import { resolvableGateSubject } from '../../helpers/resolvableGateSubject';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE STORY'S motir-core GATE (Story MOTIR-7460 · Subtask MOTIR-7479;
// `docs/decisions/manual-work-gate.md`). The per-subtask suites each proved a slice —
// the kind and its service (`tests/approvalGates/manualWorkGate.test.ts`), the raise
// off a leg (`tests/dispatchRunService.test.ts`), the guide's close
// (`tests/ai/guideLandingService.test.ts`), the port (`tests/api/approval-gate-route`).
// This file runs the story WHOLE on real Postgres, through the doors a person and a
// runner actually use:
//
//   · RAISE — the CLI's v1 dispatch-run routes (open, append), bearer-authed, exactly
//     as `motir run` posts them (§2);
//   · DECIDE — the decide route (Mark done), the card's status control and the v1
//     transitions door (HELD, routed to the decide door, §5), and the guide's
//     consented close (the guide routes, §5 / A2.6 row 2); each decides ONCE and the
//     row leaves `listAwaitingMe`;
//   · WITHDRAW — the v1 PATCH (executor edit → `no_longer_manual`), the v1 archive and
//     the status control's Cancel (`pulled_back`); and the run's own close, which
//     withdraws NOTHING (§6);
//   · ISOLATION — another workspace's run never raises a gate here, and the queue
//     lists the gate to its routed person only;
//   · EXISTING KINDS — one awaiting gate of every shipped kind still lists (all but
//     `agent_review`, which by design asks the review agent and lists to nobody).
//
// Mocked: the session / active-project / workspace-context resolvers (a Vitest process
// has no cookies), the job bus, and the motir-ai client the guide's turn settles from —
// the one external process in the path. Every write runs through the service that
// owns it.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const signedIn = { current: null as { userId: string; workspaceId: string } | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: `job-${Math.random().toString(36).slice(2)}` })),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
  getAgentRunUsage: vi.fn(async () => null),
}));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { workItemTodosService } = await import('@/lib/services/workItemTodosService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { plansService } = await import('@/lib/services/plansService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { changeStatusAction } = await import('@/app/(authed)/items/[key]/edit/actions');
const { POST: openRunRoute } = await import('@/app/api/v1/dispatch-runs/route');
const { POST: appendRoute } = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
const { POST: closeRunRoute } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
const { POST: transitionsRoute } =
  (await import('@/app/api/v1/work-items/[key]/transitions/route')) as unknown as {
    POST: (req: Request, args: { params: Promise<{ key: string }> }) => Promise<Response>;
  };
const { PATCH: patchItemRoute } =
  (await import('@/app/api/v1/work-items/[key]/route')) as unknown as {
    PATCH: (req: Request, args: { params: Promise<{ key: string }> }) => Promise<Response>;
  };
const { POST: archiveRoute } =
  (await import('@/app/api/v1/work-items/[key]/archive/route')) as unknown as {
    POST: (req: Request, args: { params: Promise<{ key: string }> }) => Promise<Response>;
  };
const { GET: gatePortRoute } = await import('@/app/api/work-items/approval-gate/route');
const { POST: guideRoute } = await import('@/app/api/ai/guide/route');
const { POST: guideSettleRoute } = await import('@/app/api/ai/guide/settle/route');

let caller: V1ProjectCaller;
let seq = 0;

const fx = () => caller.fixture;
const meCtx = (userId = fx().ownerId) => ({
  userId,
  workspaceId: fx().workspaceId,
  projectId: fx().projectId,
});

/** Sign `user` in on the caller's project — the browser half of the story. */
function signIn(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email, name: 'Signed In' } };
  signedIn.current = { userId: user.id, workspaceId: fx().workspaceId };
  activeCtx.current = {
    userId: user.id,
    workspaceId: fx().workspaceId,
    projectId: fx().projectId,
    project: fx().project,
  } as ProjectContext;
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  resetRateLimitStore();
  caller = await createV1ProjectCaller({
    scopes: ['read', 'work_items:write', 'work_items:archive'],
  });
  signIn(fx().owner);
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

async function manualCard(
  overrides: { type?: 'manual' | 'code'; executor?: 'human'; assigneeId?: string | null } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx().projectId,
      kind: 'task',
      title: `Create the production Stripe account ${seq}`,
      type: overrides.type ?? 'manual',
      executor: overrides.executor ?? 'human',
      ...(overrides.assigneeId !== undefined ? { assigneeId: overrides.assigneeId } : {}),
    },
    fx().ctx,
  );
}

async function codedCard() {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx().projectId, kind: 'task', title: `Agent work ${seq}`, type: 'code' },
    fx().ctx,
  );
}

async function member(name: string) {
  const user = await createTestUser({ email: `${name.toLowerCase()}-${seq}@ex.com`, name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx().workspaceId });
  await addToProjectAs({
    key: fx().projectIdentifier,
    actorUserId: fx().ownerId,
    ctx: fx().ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return user;
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'manual_work' },
    orderBy: { createdAt: 'asc' },
  });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const queueIds = async (userId?: string) =>
  (await approvalGatesService.listAwaitingMe(meCtx(userId))).items.map((row) => row.gateId);

// ─── the doors ───────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';

function bearer(path: string, method: string, body: unknown, as: V1ProjectCaller = caller) {
  return new Request(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...as.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openRun(body: Record<string, unknown>, as: V1ProjectCaller = caller) {
  return openRunRoute(
    bearer('/dispatch-runs', 'POST', { projectKey: as.projectKey, ...body }, as),
    { params: Promise.resolve({}) },
  );
}

/** Open a run through the route and return its id — asserting the 201. */
async function openedRun(cards: unknown[], command = 'run_scope'): Promise<string> {
  const res = await openRun({ command, cards });
  expect(res.status, 'opening the run').toBe(201);
  return dispatchRunOpenedSchema.parse(await res.json()).run.id;
}

function appendEvents(runId: string, events: unknown[]) {
  return appendRoute(bearer(`/dispatch-runs/${runId}/events`, 'POST', { events }), {
    params: Promise.resolve({ id: runId }),
  });
}

function closeRun(runId: string, stopReason: string) {
  return closeRunRoute(bearer(`/dispatch-runs/${runId}/close`, 'POST', { stopReason }), {
    params: Promise.resolve({ id: runId }),
  });
}

/** The leg a run records when it reaches a manual card it cannot do. */
const needsHuman = (key: string) => ({
  key,
  disposition: 'skipped',
  skipReason: 'needs_human',
});

/** Raise the gate the way the story does — a run's OPEN body naming the card. */
async function raisedByRun(card: { id: string; identifier: string }) {
  await openedRun([needsHuman(card.identifier)]);
  const [gate] = await gatesOf(card.id);
  expect(gate, 'the run raised the gate').toBeDefined();
  return gate!;
}

async function shownStamp(workItemId: string, userId = fx().ownerId) {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId, kind: 'manual_work' },
    { userId, workspaceId: fx().workspaceId },
  );
  return read.stamp;
}

function decide(gateId: string, body: Record<string, unknown>) {
  return decideRoute(
    new Request(`${BASE}/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
}

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Settled {
  outcome: string;
  session: PlanChangeSessionDto;
  record?: { outcomes: Array<{ type: string; outcome: string; reason?: string }> };
}

/** The guide's consented close: open the guide on the card, settle a `close` turn. */
async function guideClose(identifier: string): Promise<Settled> {
  const opened = await guideRoute(post('/api/ai/guide', { itemKey: identifier }));
  expect(opened.status, 'opening the guide').toBe(200);
  const { jobId, session: guideSession } = (await opened.json()) as {
    jobId: string;
    session: PlanChangeSessionDto;
  };
  getJobMock.mockResolvedValue({
    status: 'succeeded',
    result: {
      guideTurn: { messageMd: 'All done, closing it.', actions: [{ type: 'close' }], dropped: [] },
    },
    error: null,
  });
  const res = await guideSettleRoute(
    post('/api/ai/guide/settle', { jobId, sessionId: guideSession.id }),
  );
  expect(res.status, 'settling the guide turn').toBe(200);
  return (await res.json()) as Settled;
}

async function tickedSteps(workItemId: string, texts: string[]) {
  for (const text of texts) {
    const { todo } = await workItemTodosService.addTodo(workItemId, { text }, fx().ctx);
    await workItemTodosService.setTodoDone(todo.id, true, fx().ctx);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

describe('RAISE — the CLI’s dispatch-run routes (§2)', () => {
  it('an OPEN body with a needs_human leg raises ONE gate, routed to the starter, listed to them', async () => {
    const manual = await manualCard();
    const coded = await codedCard();

    const runId = await openedRun([
      needsHuman(manual.identifier),
      { key: coded.identifier, disposition: 'queued' },
    ]);

    const gates = await gatesOf(manual.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: manual.id,
      subjectVersion: null,
      routedToId: fx().ownerId,
    });
    // The card was unassigned, so the raise assigned it to the run's starter (§3).
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: manual.id } })).assigneeId,
    ).toBe(fx().ownerId);
    // The queued leg asks nobody anything.
    expect(await adminDb.approvalGate.count({ where: { kind: 'manual_work' } })).toBe(1);

    // Waiting on you lists it — once, as a manual-work row with its stamp.
    const queue = await approvalGatesService.listAwaitingMe(meCtx());
    expect(queue.items.map((row) => row.gateId)).toEqual([gates[0]!.id]);
    expect(queue.items[0]).toMatchObject({
      kind: 'manual_work',
      canDecide: true,
      workItem: { identifier: manual.identifier },
      subject: { kind: 'manual_work', todos: null, stamp: expect.any(String) },
    });

    // And the run says who the leg waits on: you.
    const detail = await dispatchRunService.getRunDetail(runId, fx().ctx);
    expect(detail.cards[0]!.manualGate).toMatchObject({ state: 'awaiting', routedToReader: true });
    expect(detail.cards[1]!.manualGate).toBeNull();
  });

  it('a leg skipped by a later EVENT raises it; the same event again and a SECOND run raise none', async () => {
    const manual = await manualCard();
    const runId = await openedRun([{ key: manual.identifier, disposition: 'queued' }], 'auto');
    expect(await gatesOf(manual.id)).toHaveLength(0);

    const skip = {
      kind: 'card_skipped',
      workItemKey: manual.identifier,
      disposition: 'skipped',
      skipReason: 'needs_human',
    };
    expect((await appendEvents(runId, [skip])).status).toBe(200);
    expect((await appendEvents(runId, [skip])).status).toBe(200);
    await openedRun([needsHuman(manual.identifier)], 'auto');

    const gates = await gatesOf(manual.id);
    expect(gates.map((g) => g.state)).toEqual(['awaiting']);
    expect(await queueIds()).toEqual([gates[0]!.id]);
  });

  it('a Done card, a card that is not manual, and any other skip reason raise none', async () => {
    const finished = await manualCard();
    await workItemsService.updateStatus(finished.id, 'in_progress', fx().ctx);
    await workItemsService.updateStatus(finished.id, 'done', fx().ctx);
    const coded = await codedCard();
    const refused = await manualCard();

    // The server does not take the CLI's word for it: `needs_human` on a CODE card asks
    // nothing (§2 server guards).
    await openedRun([
      needsHuman(finished.identifier),
      needsHuman(coded.identifier),
      { key: refused.identifier, disposition: 'skipped', skipReason: 'claim_refused' },
    ]);

    expect(await adminDb.approvalGate.count({ where: { kind: 'manual_work' } })).toBe(0);
    expect(await queueIds()).toEqual([]);
  });

  it('an ASSIGNED card keeps its assignee, and the gate lists to THEM, not to the starter', async () => {
    const mara = await member('Mara');
    const manual = await manualCard({ assigneeId: mara.id });

    const gate = await raisedByRun(manual);

    expect(gate.routedToId).toBe(mara.id);
    expect(await queueIds(mara.id)).toEqual([gate.id]);
    expect(await queueIds()).toEqual([]);
  });
});

describe('DECIDE — every door decides ONCE, and the row leaves Waiting on you (§4, §5)', () => {
  it('MARK DONE through the decide route walks the card to Done and records the person', async () => {
    const manual = await manualCard();
    const gate = await raisedByRun(manual);
    expect(await statusOf(manual.id)).toBe('todo');

    const stamp = await shownStamp(manual.id);
    const res = await decide(gate.id, { decision: 'approve', stamp });
    expect(res.status).toBe(200);

    expect(await statusOf(manual.id)).toBe('done');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'approved',
      decidedById: fx().ownerId,
    });
    expect(await queueIds()).toEqual([]);

    // ONCE: a second press is refused, and nothing is re-asked.
    const again = await decide(gate.id, { decision: 'approve', stamp });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'APPROVAL_GATE_ALREADY_DECIDED' });
    expect((await gatesOf(manual.id)).map((g) => g.state)).toEqual(['approved']);
  });

  it('Request changes is not offered: refused by name through the route, and nothing moves', async () => {
    const manual = await manualCard();
    const gate = await raisedByRun(manual);

    const res = await decide(gate.id, {
      decision: 'request_changes',
      noteMd: 'I cannot get to this',
      stamp: await shownStamp(manual.id),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_GATE_VERB_NOT_OFFERED' });
    expect(await statusOf(manual.id)).toBe('todo');
    expect(await queueIds()).toEqual([gate.id]);
  });

  it('the card’s STATUS CONTROL and the v1 transitions door are HELD while it waits — routed to the decide door', async () => {
    const manual = await manualCard();
    const gate = await raisedByRun(manual);
    // Into In progress is not the status the gate owns — it passes.
    const started = await changeStatusAction({ id: manual.id, toStatusKey: 'in_progress' });
    expect(started.ok).toBe(true);

    // The item page's / board's control: the held answer names THIS gate and offers the press.
    const held = await changeStatusAction({ id: manual.id, toStatusKey: 'done' });
    expect(held).toMatchObject({
      ok: false,
      code: 'APPROVAL_GATE_PENDING',
      gate: { itemKey: manual.identifier, kind: 'manual_work', canDecide: true },
    });

    // REST: the same refusal, as the contract's 422.
    const rest = await transitionsRoute(
      bearer(`/work-items/${manual.identifier}/transitions`, 'POST', { status: 'done' }),
      { params: Promise.resolve({ key: manual.identifier }) },
    );
    expect(rest.status).toBe(422);
    expect(approvalGatePendingSchema.parse(await rest.json()).gate).toMatchObject({
      itemKey: manual.identifier,
      kind: 'manual_work',
    });

    // Neither moved the card nor decided anything…
    expect(await statusOf(manual.id)).toBe('in_progress');
    expect(await queueIds()).toEqual([gate.id]);

    // …and the press the surface opens IS Mark done.
    const res = await decide(gate.id, { decision: 'approve', stamp: await shownStamp(manual.id) });
    expect(res.status).toBe(200);
    expect(await statusOf(manual.id)).toBe('done');
    expect(await queueIds()).toEqual([]);
  });

  it('the GUIDE’s consented close decides it through the door, as the person whose turn it was', async () => {
    const manual = await manualCard();
    const gate = await raisedByRun(manual);
    await tickedSteps(manual.id, ['Sign in to Stripe', 'Turn on live mode']);

    // Ticking every step moves no status and decides nothing (§6).
    expect(await statusOf(manual.id)).toBe('todo');
    expect(await queueIds()).toEqual([gate.id]);

    const settled = await guideClose(manual.identifier);

    expect(settled.record?.outcomes.map((o) => [o.type, o.outcome])).toEqual([['close', 'landed']]);
    expect(await statusOf(manual.id)).toBe('done');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'approved',
      decidedById: fx().ownerId,
    });
    expect(await queueIds()).toEqual([]);
  });

  it('the guide’s close by somebody the gate is NOT routed to is a skip — the question stays theirs', async () => {
    const mara = await member('Mara');
    const manual = await manualCard({ assigneeId: mara.id });
    const gate = await raisedByRun(manual);
    await tickedSteps(manual.id, ['Only step']);

    // Somebody ELSE in the project — not the assignee, not an admin — guides the card.
    const bystander = await member('Bystander');
    signIn(bystander);
    const settled = await guideClose(manual.identifier);

    expect(settled.record?.outcomes).toEqual([
      expect.objectContaining({
        type: 'close',
        outcome: 'skipped',
        reason: expect.stringContaining('mark it on the card'),
      }),
    ]);
    expect((await gatesOf(manual.id)).map((g) => g.state)).toEqual(['awaiting']);
    expect(await statusOf(manual.id)).not.toBe('done');
    expect(await queueIds(mara.id)).toEqual([gate.id]);
  });

  it('the guide’s close on a manual card held by ANOTHER kind’s question still skips — it decides only its own', async () => {
    const manual = await manualCard({ assigneeId: fx().ownerId });
    await tickedSteps(manual.id, ['Only step']);
    // A design result waiting on the same card owns its Done; no run reached it, so there
    // is no manual-work question to answer.
    const subjectId = await resolvableGateSubject(fx(), manual.id, 'design_result');
    const design = await withWorkspaceContext(fx().ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx().workspaceId,
          projectId: fx().projectId,
          workItemId: manual.id,
          kind: 'design_result',
          subjectId,
        },
        tx,
      ),
    );

    const settled = await guideClose(manual.identifier);

    expect(settled.record?.outcomes).toEqual([
      expect.objectContaining({
        type: 'close',
        outcome: 'skipped',
        reason: expect.stringContaining('decide it on the card'),
      }),
    ]);
    expect(await statusOf(manual.id)).not.toBe('done');
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: design.id } })).state).toBe(
      'awaiting',
    );
    expect(await gatesOf(manual.id)).toHaveLength(0);
  });

  it('Mark done on a card with an OPEN pull request decides the gate and leaves Done to the merge', async () => {
    const manual = await manualCard();
    const gate = await raisedByRun(manual);
    const repo = await connectRepairRepo(fx(), 'manual-work-repo');
    await deliveredPr(fx(), manual.id, repo, { headRef: 'manual/with-a-pr' });

    // The overlay's port says so BEFORE the press: the merge, not Mark done, writes Done.
    const port = await gatePortRoute(
      new Request(`${BASE}/api/work-items/approval-gate?key=${manual.identifier}&kind=manual_work`),
    );
    expect(port.status).toBe(200);
    expect((await port.json()).subject).toMatchObject({
      state: 'resolved',
      kind: 'manual_work',
      manualWork: { todos: [], mergeWritesDone: true },
    });

    const res = await decide(gate.id, { decision: 'approve', stamp: await shownStamp(manual.id) });
    expect(res.status).toBe(200);

    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'approved',
    });
    expect(await statusOf(manual.id)).toBe('todo');
    expect(await queueIds()).toEqual([]);
  });
});

describe('WITHDRAW — and what does NOT withdraw (§6)', () => {
  it('an executor edit through the v1 PATCH leaves the card no longer manual — `no_longer_manual`', async () => {
    // Manual by EXECUTOR only, so an executor edit is what changes the answer.
    const card = await manualCard({ type: 'code', executor: 'human' });
    const gate = await raisedByRun(card);
    expect(await queueIds()).toEqual([gate.id]);

    const res = await patchItemRoute(
      bearer(`/work-items/${card.identifier}`, 'PATCH', { executor: 'coding_agent' }),
      { params: Promise.resolve({ key: card.identifier }) },
    );
    expect(res.status).toBe(200);

    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'superseded',
      supersededCause: 'no_longer_manual',
      decidedById: null,
    });
    expect(await queueIds()).toEqual([]);
  });

  it('an archive through the v1 route — `pulled_back`', async () => {
    const card = await manualCard();
    const gate = await raisedByRun(card);

    const res = await archiveRoute(bearer(`/work-items/${card.identifier}/archive`, 'POST', {}), {
      params: Promise.resolve({ key: card.identifier }),
    });
    expect(res.status).toBe(200);

    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'superseded',
      supersededCause: 'pulled_back',
    });
    expect(await queueIds()).toEqual([]);
  });

  it('a Cancel through the card’s status control — `pulled_back`, never held', async () => {
    const card = await manualCard();
    const gate = await raisedByRun(card);

    const result = await changeStatusAction({ id: card.id, toStatusKey: 'cancelled' });
    expect(result.ok).toBe(true);

    expect(await statusOf(card.id)).toBe('cancelled');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).toMatchObject({
      state: 'superseded',
      supersededCause: 'pulled_back',
    });
    expect(await queueIds()).toEqual([]);
  });

  it('the RUN closing — interrupted or completed — leaves the gate awaiting: the work is still owed', async () => {
    const card = await manualCard();
    const interrupted = await openedRun([needsHuman(card.identifier)]);
    const [gate] = await gatesOf(card.id);

    expect((await closeRun(interrupted, 'interrupted')).status).toBe(200);
    expect(await queueIds()).toEqual([gate!.id]);

    const completed = await openedRun([needsHuman(card.identifier)]);
    expect((await closeRun(completed, 'completed')).status).toBe(200);

    expect((await gatesOf(card.id)).map((g) => g.state)).toEqual(['awaiting']);
    expect(await queueIds()).toEqual([gate!.id]);
  });
});

describe('ISOLATION', () => {
  it('another workspace’s run legs never raise a gate here — not even naming this workspace’s card', async () => {
    const ours = await manualCard();
    const theirs = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Other Co',
      identifier: 'OTHR',
    });
    const theirCard = await workItemsService.createWorkItem(
      {
        projectId: theirs.fixture.projectId,
        kind: 'task',
        title: 'Their manual step',
        type: 'manual',
        executor: 'human',
      },
      theirs.fixture.ctx,
    );

    // Naming OUR card from THEIR project resolves nothing and raises nothing.
    const cross = await openRun(
      { command: 'run_scope', cards: [needsHuman(ours.identifier)] },
      theirs,
    );
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(await gatesOf(ours.id)).toHaveLength(0);

    // Their own manual leg raises THEIR gate, in THEIR workspace only.
    const own = await openRun(
      { command: 'run_scope', cards: [needsHuman(theirCard.identifier)] },
      theirs,
    );
    expect(own.status).toBe(201);
    const [theirGate] = await gatesOf(theirCard.id);
    expect(theirGate).toMatchObject({ state: 'awaiting', workspaceId: theirs.fixture.workspaceId });
    expect(
      await adminDb.approvalGate.count({
        where: { kind: 'manual_work', workspaceId: fx().workspaceId },
      }),
    ).toBe(0);
    expect(await queueIds()).toEqual([]);

    // Positive control: their owner's queue does list it.
    const theirQueue = await approvalGatesService.listAwaitingMe({
      userId: theirs.fixture.ownerId,
      workspaceId: theirs.fixture.workspaceId,
      projectId: theirs.fixture.projectId,
    });
    expect(theirQueue.items.map((row) => row.gateId)).toEqual([theirGate!.id]);
  });

  it('Waiting on you lists the gate to its ROUTED person only, and follows a reassignment', async () => {
    const mara = await member('Mara');
    const card = await manualCard();
    const gate = await raisedByRun(card);

    expect(await queueIds()).toEqual([gate.id]);
    expect(await queueIds(mara.id)).toEqual([]);

    await workItemsService.updateWorkItem(card.id, { assigneeId: mara.id }, fx().ctx);

    expect(await queueIds(mara.id)).toEqual([gate.id]);
    expect(await queueIds()).toEqual([]);
    // Reassigning re-routes; it does not withdraw (§6).
    expect((await gatesOf(card.id)).map((g) => g.state)).toEqual(['awaiting']);
  });
});

describe('EXISTING KINDS — every shipped kind a person is asked still lists in the renamed tab', () => {
  const CARD_KINDS: ApprovalGateKind[] = [
    'design_result',
    'acceptance_result',
    'pull_request_approval',
    'agent_review',
    'decision_approval',
    'decision_choice',
    'decision_confirmation',
  ];

  it('one awaiting gate of each kind, beside a run-raised manual-work gate, each listed once', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx().projectId, kind: 'story', title: 'Every kind' },
      fx().ctx,
    );
    const expected = new Map<string, ApprovalGateKind>();
    for (const kind of CARD_KINDS) {
      const item = await workItemsService.createWorkItem(
        { projectId: fx().projectId, kind: 'subtask', parentId: story.id, title: `A ${kind} card` },
        fx().ctx,
      );
      await adminDb.workItem.update({
        where: { id: item.id },
        data: { assigneeId: fx().ownerId },
      });
      const subjectId = await resolvableGateSubject(fx(), item.id, kind);
      const gate = await withWorkspaceContext(fx().ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx().workspaceId,
            projectId: fx().projectId,
            workItemId: item.id,
            kind,
            subjectId,
          },
          tx,
        ),
      );
      expected.set(gate.id, kind);
    }
    // The card-less kind: a plan the cadence closed, asked of the workspace owner.
    const plan = await plansService.createPlan(fx().projectId, { title: 'A plan' }, fx().ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx().ctx,
    );
    await plansService.markPlanned(plan.id, fx().ctx);
    const [planGate] = await adminDb.approvalGate.findMany({
      where: { kind: 'plan_approval', subjectId: plan.id },
    });
    expected.set(planGate!.id, 'plan_approval');
    // And the new kind, raised by a run.
    const manual = await manualCard();
    expected.set((await raisedByRun(manual)).id, 'manual_work');

    // ⚠️ `agent_review` is shipped and is NEVER on a person's list: it asks the review
    // agent, not them (ADR §12.1, MOTIR-6819). Its gate is awaiting all the same — the
    // positive control that keeps its absence from passing vacuously.
    const [agentReviewId] = [...expected].find(([, kind]) => kind === 'agent_review')!;
    expected.delete(agentReviewId);
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: agentReviewId } })).state,
    ).toBe('awaiting');

    const queue = await approvalGatesService.listAwaitingMe(meCtx());

    expect(queue.total).toBe(expected.size);
    expect(Object.fromEntries(queue.items.map((row) => [row.gateId, row.kind]))).toEqual(
      Object.fromEntries(expected),
    );
    // Every registered kind a person is asked — eight of the nine — each once.
    expect(new Set(queue.items.map((row) => row.kind)).size).toBe(8);
    expect(queue.items.map((row) => row.gateId)).not.toContain(agentReviewId);
    // Each subject resolved: no row lists as a gone subject.
    for (const row of queue.items) expect(row.subject?.kind).toBe(row.kind);
  });
});
