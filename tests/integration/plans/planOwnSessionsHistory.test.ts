import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { InvalidPlanSessionCursorError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestProject } from '../../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Story MOTIR-9218 · MOTIR-9306 — the planning overlay's History reads the
// sessions the VIEWER started in this project (`created_by_id`), open or ended,
// guide conversations excluded, ten a page on the Plans list's cursor. Real
// Postgres, the real service and repository. The route section mocks only the
// session gate and the active project, the way every route test here does.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-history' })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
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

const gateSession = { current: null as { user: { id: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: async () =>
    gateSession.current
      ? { ok: true as const, session: gateSession.current }
      : {
          ok: false as const,
          response: new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 }),
        },
}));
vi.mock('@/lib/projects', async (orig) => ({
  ...(await orig<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));

const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { GET } = await import('@/app/api/ai/plan-change/sessions/history/route');

let fx: WorkItemFixture;
let seq = 0;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

async function seatMember(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `history-${seq++}@example.com`,
    password: 'correct-horse-battery-staple',
    name: `Colleague ${seq}`,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** A session written directly, with its one user turn when `body` is given. */
async function session(opts: {
  by?: string | null;
  at: Date;
  body?: string;
  projectId?: string;
  origin?: 'conversation' | 'guide';
  ended?: boolean;
}): Promise<string> {
  const by = opts.by === undefined ? fx.ownerId : opts.by;
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: opts.projectId ?? fx.projectId,
      createdById: by,
      scopeKey: PROJECT_SCOPE.scopeKey,
      targetKeys: [],
      turnCount: opts.body ? 1 : 0,
      origin: opts.origin ?? 'conversation',
      lastActivityAt: opts.at,
      ...(opts.ended ? { endedAt: opts.at, endReason: 'idle' as const } : {}),
    },
  });
  if (opts.body) {
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: s.id,
        seq: 0,
        role: 'user',
        body: opts.body,
        authorId: by,
      },
    });
  }
  return s.id;
}

/** A plan in its OWN session, started by `ctx`. */
async function planBy(ctx: ServiceContext, title: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title, session: { origin: 'mcp' }, authorSource: 'mcp', createdById: ctx.userId },
    ctx,
  );
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
  return { planId: plan.id, sessionId: row.sessionId! };
}

const ids = (page: { sessions: { id: string }[] }) => page.sessions.map((s) => s.id);

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  gateSession.current = { user: { id: fx.ownerId } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('whose sessions are listed', () => {
  it('only the viewer’s, in this project, guides excluded — open and ended alike', async () => {
    const colleague = await seatMember();
    const open = await session({ at: minutesAgo(1), body: 'Why is ACME-1 blocked?' });
    const ended = await session({ at: minutesAgo(2), body: 'What retries?', ended: true });
    await session({ by: colleague.userId, at: minutesAgo(3), body: 'Not mine' });
    await session({ at: minutesAgo(4), origin: 'guide' });
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSW',
    });
    await session({ at: minutesAgo(5), body: 'Another project', projectId: elsewhere.id });

    const page = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx);

    expect(ids(page)).toEqual([open, ended]);
    expect(page.scope).toBe('mine');
    expect(page.nextCursor).toBeNull();
    expect(page.sessions[0]).toMatchObject({ firstTurn: 'Why is ACME-1 blocked?', endedAt: null });
    expect(page.sessions[1]).toMatchObject({ firstTurn: 'What retries?', endReason: 'idle' });
  });

  it('a session with no plan and one whose plan was decided are both listed', async () => {
    const empty = await session({ at: minutesAgo(1), body: 'Just a question' });
    const decided = await planBy(fx.ctx, 'Decided plan');
    await adminDb.plan.update({
      where: { id: decided.planId },
      data: { status: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
    });
    await adminDb.planChangeSession.update({
      where: { id: decided.sessionId },
      data: { lastActivityAt: minutesAgo(2) },
    });

    const page = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx);

    expect(ids(page)).toEqual([empty, decided.sessionId]);
    expect(page.sessions[0]).toMatchObject({ planCount: 0, latestPlan: null });
    expect(page.sessions[1]?.planCount).toBe(1);
    expect(page.sessions[1]?.latestPlan).toMatchObject({ id: decided.planId });
  });

  it('a routed plan’s session the viewer did not start stays out — and Plans `mine` keeps it', async () => {
    const reader = await seatMember();
    const routed = await planBy(fx.ctx, 'Routed to reader');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: routed.planId,
        state: 'awaiting',
        routedToId: reader.userId,
      },
    });
    const own = await session({ by: reader.userId, at: minutesAgo(1), body: 'Mine' });

    const history = await planSessionsService.listOwnSessions(fx.projectId, reader);
    expect(ids(history)).toEqual([own]);

    const plansMine = await planSessionsService.listSessions(fx.projectId, reader, {
      view: 'mine',
    });
    // `own` holds no plan, so the Plans page (MOTIR-9300) leaves it out.
    expect(ids(plansMine)).toEqual([routed.sessionId]);
  });
});

describe('paging', () => {
  it('pages 10 / 10 / 5 and ends with a null cursor', async () => {
    const all: string[] = [];
    for (let i = 0; i < 25; i++) all.push(await session({ at: minutesAgo(i + 1), body: `#${i}` }));

    const p1 = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx);
    const p2 = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, {
      cursor: p1.nextCursor,
    });
    const p3 = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, {
      cursor: p2.nextCursor,
    });

    expect([ids(p1).length, ids(p2).length, ids(p3).length]).toEqual([10, 10, 5]);
    expect(p1.nextCursor).not.toBeNull();
    expect(p2.nextCursor).not.toBeNull();
    expect(p3.nextCursor).toBeNull();
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(all);
  });

  it('sessions tied on last activity across a page boundary are neither repeated nor skipped', async () => {
    const tie = minutesAgo(10);
    const tied: string[] = [];
    for (let i = 0; i < 4; i++) tied.push(await session({ at: tie, body: `tie ${i}` }));

    const p1 = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, { limit: 3 });
    const p2 = await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, {
      limit: 3,
      cursor: p1.nextCursor,
    });

    const seen = [...ids(p1), ...ids(p2)];
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual([...tied].sort().reverse());
    expect(p2.nextCursor).toBeNull();
  });

  it('clamps the limit to 1..100', async () => {
    for (let i = 0; i < 3; i++) await session({ at: minutesAgo(i + 1), body: `#${i}` });
    expect(
      ids(await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, { limit: 0 })),
    ).toHaveLength(1);
    expect(
      ids(await planSessionsService.listOwnSessions(fx.projectId, fx.ctx, { limit: 1000 })),
    ).toHaveLength(3);
  });

  it('refuses a cursor it did not mint', async () => {
    await expect(
      planSessionsService.listOwnSessions(fx.projectId, fx.ctx, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidPlanSessionCursorError);
  });
});

describe('GET /api/ai/plan-change/sessions/history', () => {
  const req = (query = '') =>
    new Request(`http://localhost/api/ai/plan-change/sessions/history${query}`);

  it('401s without a session', async () => {
    gateSession.current = null;
    expect((await GET(req())).status).toBe(401);
  });

  it('404s without an active project', async () => {
    activeCtx.current = null;
    expect((await GET(req())).status).toBe(404);
  });

  it('200s with the viewer’s first page, uncached, and pages on its cursor', async () => {
    for (let i = 0; i < 12; i++) await session({ at: minutesAgo(i + 1), body: `#${i}` });

    const first = await GET(req());
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await first.json()) as { sessions: unknown[]; nextCursor: string | null };
    expect(body.sessions).toHaveLength(10);

    const next = await GET(req(`?cursor=${encodeURIComponent(body.nextCursor!)}`));
    const rest = (await next.json()) as { sessions: unknown[]; nextCursor: string | null };
    expect(rest.sessions).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
  });

  it('400s a malformed cursor with the typed code', async () => {
    const res = await GET(req('?cursor=garbage'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PLAN_SESSION_CURSOR' });
  });
});
