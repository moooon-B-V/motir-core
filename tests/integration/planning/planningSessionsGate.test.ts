import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PLAN_SESSION_RESUME_WINDOW_MS } from '@/lib/planChange/sessionWindow';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// MOTIR-6026 — the STORY-LEVEL integration gate for MOTIR-6011 (a planning
// conversation is a SESSION from its first turn; `agent-authored-plans.md`
// AMENDMENT 17). Each child shipped its own units, which mock exactly the seams
// asserted here: the in-app routes → the session service → the plan service →
// the Plans list; the v1 routes and the MCP adapter against the same resume
// rule; the mailbox's job lookup with several sessions in one scope; the lock
// hand-over; and the card-anchored plan resolution through the v1 approve door.
//
// Real Postgres throughout. The mocks are the two the convention allows: the
// cookie session / active project (the node env has no request to read them
// from — the v1 doors authenticate with a REAL token instead), and the motir-ai
// boundary client.
//
// The two remaining Cases live beside the code they guard, and are not
// repeated here: RLS isolation of `listSessions` / `getById` extends
// `planChangeSessionRls.test.ts`, and the backfill's four outcomes are
// `tests/integration/migrations/planning-session-record-backfill.test.ts`
// (it replays the migration SQL, which needs its own pre-migration fixture).

const cookie = { current: null as { user: { id: string; email: string; name: string } } | null };
const active = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => cookie.current,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => active.current,
}));

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-gate-${++jobSeq}` }));
const getJobMock = vi.fn(async () => ({ status: 'running' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
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
}));

const { GET: readSessionRoute, POST: startSessionRoute } =
  await import('@/app/api/ai/plan-change/session/route');
const { POST: submitRoute } = await import('@/app/api/ai/plan-change/session/submit/route');
const { POST: v1Open } = await import('@/app/api/v1/projects/[projectKey]/plan-session/route');
const { POST: v1Approve } = await import('@/app/api/v1/work-items/[key]/plan-approval/route');
const { runOpenPlanSession } = await import('@/lib/mcp/tools/planSession');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');

let caller: V1ProjectCaller;

function pctx(userId = caller.fixture.ownerId): ProjectContext {
  const f = caller.fixture;
  return { userId, workspaceId: f.workspaceId, projectId: f.projectId, project: f.project };
}

/** Sign the cookie session in as a member, on the fixture project. */
function signInAs(userId: string, email = 'member@example.com') {
  cookie.current = { user: { id: userId, email, name: 'Member' } };
  active.current = pctx(userId);
}

async function teammate(email: string): Promise<string> {
  const u = await usersService.createUser({
    email,
    password: 'correct-horse-battery-staple-9',
    name: email.split('@')[0]!,
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: caller.fixture.workspaceId, role: 'member' },
  });
  await addToProjectAs({
    key: caller.projectKey,
    actorUserId: caller.fixture.ownerId,
    ctx: caller.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return u.id;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const APP = 'http://localhost:3000/api/ai/plan-change/session';

async function startThroughRoute(body: string): Promise<string> {
  const res = await startSessionRoute(jsonRequest(APP, { body }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function submitThroughRoute(sessionId: string): Promise<{ jobId: string; planId: string }> {
  const res = await submitRoute(jsonRequest(`${APP}/submit`, { sessionId }));
  expect(res.status).toBe(200);
  return (await res.json()) as { jobId: string; planId: string };
}

async function age(sessionId: string, ms: number) {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: new Date(Date.now() - ms) },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  getJobMock.mockClear();
  caller = await createV1ProjectCaller({ permissions: ['project:browse', 'ai:plan'] });
  signInAs(caller.fixture.ownerId, caller.fixture.owner.email);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('SEAM: turn → submit → plan → list', () => {
  it('a first turn through the route starts a session, its submit plans ON it, and the list shows it `generating`', async () => {
    // Looking creates nothing — the browser's read of a scope with no session.
    const look = await readSessionRoute(new Request(`${APP}?scope=`));
    expect(await look.json()).toEqual({ session: null, earlier: null });
    expect(await adminDb.planChangeSession.count()).toBe(0);

    const sessionId = await startThroughRoute('Split the billing epic');
    const { planId } = await submitThroughRoute(sessionId);

    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.sessionId).toBe(sessionId);

    const page = await planSessionsService.listSessions(caller.fixture.projectId, caller.ctx);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toMatchObject({
      id: sessionId,
      origin: 'conversation',
      firstTurn: 'Split the billing epic',
      latestPlan: { id: planId, status: 'generating' },
      planCount: 1,
    });
  });
});

describe('SEAM: two sessions, one scope, two members', () => {
  // ⚠️ THE PROJECT-WIDE scope, not a card's: two members cannot hold one CARD
  // scope at once — the second is refused by the first one's target lease
  // (AMENDMENT 16 D5, kept by 17 §6), which the lock case below asserts. The
  // project scope takes no lease, so it is where two members' sessions coexist.
  it('no turn, plan or mailbox entry crosses — the mailbox resolves each job to its own session', async () => {
    const mateId = await teammate('mate@example.com');

    signInAs(caller.fixture.ownerId);
    const mine = await startThroughRoute('mine: add auth');
    const myRun = await submitThroughRoute(mine);

    signInAs(mateId, 'mate@example.com');
    const theirs = await startThroughRoute('theirs: add billing');
    const theirRun = await submitThroughRoute(theirs);

    expect(theirs).not.toBe(mine);
    expect(myRun.jobId).not.toBe(theirRun.jobId);

    // Each member's mid-run message lands on the session running THAT job.
    await planChangeMailboxService.attachTurn(
      { jobId: myRun.jobId, sessionId: mine, body: 'and 2FA', idempotencyKey: 'k-mine' },
      pctx(caller.fixture.ownerId),
    );
    await planChangeMailboxService.attachTurn(
      { jobId: theirRun.jobId, body: 'and invoices', idempotencyKey: 'k-theirs' },
      pctx(mateId),
    );
    const entries = await adminDb.planChangeMailboxEntry.findMany({ orderBy: { body: 'asc' } });
    expect(entries.map((e) => [e.body, e.sessionId, e.jobId])).toEqual([
      ['and 2FA', mine, myRun.jobId],
      ['and invoices', theirs, theirRun.jobId],
    ]);

    // A message naming MY session but THEIR job is refused, not rerouted.
    await expect(
      planChangeMailboxService.attachTurn(
        { jobId: theirRun.jobId, sessionId: mine, body: 'crossed', idempotencyKey: 'k-crossed' },
        pctx(caller.fixture.ownerId),
      ),
    ).rejects.toThrow();

    const turns = await adminDb.planChangeTurn.findMany({
      where: { role: 'user' },
      select: { sessionId: true, body: true },
    });
    expect(turns.filter((t) => t.sessionId === mine).map((t) => t.body)).toEqual([
      'mine: add auth',
    ]);
    expect(turns.filter((t) => t.sessionId === theirs).map((t) => t.body)).toEqual([
      'theirs: add billing',
    ]);
    const plans = await adminDb.plan.findMany({ select: { id: true, sessionId: true } });
    expect(new Map(plans.map((p) => [p.id, p.sessionId]))).toEqual(
      new Map([
        [myRun.planId, mine],
        [theirRun.planId, theirs],
      ]),
    );
  });
});

describe('SEAM: a revision keeps its session', () => {
  it('`submitRevise` leaves `Plan.sessionId` where it was, and the Plans row still shows that plan', async () => {
    const sessionId = await startThroughRoute('first cut');
    const { planId } = await submitThroughRoute(sessionId);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });

    await aiPlanEditsService.submitRevise(planId, 'split the second story', pctx());

    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.sessionId).toBe(sessionId);
    const [row] = (await planSessionsService.listSessions(caller.fixture.projectId, caller.ctx))
      .sessions;
    expect(row).toMatchObject({ id: sessionId, latestPlan: { id: planId }, planCount: 1 });
  });
});

describe('SEAM: the resume window is ONE rule across every door', () => {
  it('the in-app route, the v1 route and MCP `open_plan_session` all land on one session inside the window, and none of them past it', async () => {
    const sessionId = await startThroughRoute('within the window');

    // In-app: the browser's resume read.
    const inApp = (await (await readSessionRoute(new Request(`${APP}?scope=`))).json()) as {
      session: { id: string } | null;
    };
    expect(inApp.session?.id).toBe(sessionId);

    // v1, with the same member's token.
    const v1 = await v1Open(
      new Request(`http://localhost:3000/api/v1/projects/${caller.projectKey}/plan-session`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(v1.status).toBe(200);
    expect(((await v1.json()) as { id: string }).id).toBe(sessionId);

    // MCP.
    const mcp = await runOpenPlanSession({ projectKey: caller.projectKey }, caller.ctx);
    expect(mcp.isError).not.toBe(true);
    expect((mcp.structuredContent as { id: string }).id).toBe(sessionId);
    expect(await adminDb.planChangeSession.count()).toBe(1);

    // PAST the window: the browser's read finds nothing resumable, and names
    // the earlier conversation instead; the public doors START a new session.
    await age(sessionId, PLAN_SESSION_RESUME_WINDOW_MS + 60_000);
    const later = (await (await readSessionRoute(new Request(`${APP}?scope=`))).json()) as {
      session: unknown;
      earlier: { id: string } | null;
    };
    expect(later.session).toBeNull();
    expect(later.earlier?.id).toBe(sessionId);

    const fresh = await runOpenPlanSession({ projectKey: caller.projectKey }, caller.ctx);
    const freshId = (fresh.structuredContent as { id: string }).id;
    expect(freshId).not.toBe(sessionId);
    expect(await adminDb.planChangeSession.count()).toBe(2);
  });

  it('resume-or-start RACING two tabs: two first turns at once make ONE session holding both', async () => {
    const [a, b] = await Promise.all([
      planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'tab one'),
      planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'tab two'),
    ]);

    expect(a.id).toBe(b.id);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    const bodies = (
      await adminDb.planChangeTurn.findMany({ where: { sessionId: a.id }, orderBy: { seq: 'asc' } })
    ).map((t) => t.body);
    expect(bodies.sort()).toEqual(['tab one', 'tab two']);
  });
});

describe('SEAM: the target lock between sessions', () => {
  async function card(title: string) {
    return workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title, parentId: null },
      caller.ctx,
    );
  }

  it('an older OWN session hands its live lease to the new one; another member’s live lease still refuses', async () => {
    const item = await card('Anchor');
    const scope = buildScope([item.identifier]);

    const older = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'first');
    await age(older.id, PLAN_SESSION_RESUME_WINDOW_MS + 60_000);
    const fresh = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'second');

    expect(fresh.id).not.toBe(older.id);
    const lock = await adminDb.planTargetLock.findFirstOrThrow({ where: { workItemId: item.id } });
    expect(lock.sessionId).toBe(fresh.id);

    const mateId = await teammate('rival@example.com');
    await expect(
      planChangeSessionsService.startWithFirstTurn(pctx(mateId), scope, 'mine now'),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);
  });
});

describe('GUARD: card-anchored plan resolution', () => {
  it('the v1 approve door acts on the NEWER session’s planned plan, not an older session’s approved one', async () => {
    const approver = await createV1ProjectCaller({
      permissions: ['project:browse', 'ai:plan', 'ai:decide_plan'],
    });
    caller = approver;
    signInAs(caller.fixture.ownerId);
    const item = await card();
    const scope = buildScope([item.identifier]);

    const older = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'first go');
    const { planId: approvedId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: older.id,
    });
    await adminDb.plan.update({ where: { id: approvedId! }, data: { status: 'approved' } });
    await age(older.id, PLAN_SESSION_RESUME_WINDOW_MS + 60_000);

    const newer = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'second go');
    expect(newer.id).not.toBe(older.id);
    const { planId: plannedId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: newer.id,
    });
    // A plan with something to approve — an EMPTY one is refused (and over v1
    // that refusal is a 500 today: MOTIR-6105).
    await plansService.addProposals(
      plannedId!,
      [{ op: 'add', proposedFields: { title: 'A proposed task', kind: 'task' } }],
      caller.ctx,
    );
    // Closed the way the engine closes it — `markPlanned` raises the plan's gate, and a
    // `planned` plan nobody was asked about is not decidable (MOTIR-6038, §11.8).
    await plansService.markPlanned(plannedId!, caller.ctx);

    const res = await v1Approve(
      new Request(`http://localhost:3000/api/v1/work-items/${item.identifier}/plan-approval`, {
        method: 'POST',
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key: item.identifier }) },
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(plannedId);
    const [a, b] = await Promise.all([
      adminDb.plan.findUniqueOrThrow({ where: { id: approvedId! } }),
      adminDb.plan.findUniqueOrThrow({ where: { id: plannedId! } }),
    ]);
    expect(a.status).toBe('approved');
    expect(b.status).toBe('approved');

    async function card() {
      return workItemsService.createWorkItem(
        { projectId: caller.fixture.projectId, kind: 'story', title: 'Card', parentId: null },
        caller.ctx,
      );
    }
  });
});

describe('every plan-writing path leaves a plan the Plans list can show', () => {
  it('a plan written with no conversation still has a session, and so a row', async () => {
    const plan = await plansService.createPlan(
      caller.fixture.projectId,
      { title: 'written by the generator' },
      caller.ctx,
    );
    const [row] = (await planSessionsService.listSessions(caller.fixture.projectId, caller.ctx))
      .sessions;
    expect(row).toMatchObject({ origin: 'generation', latestPlan: { id: plan.id } });
  });
});
