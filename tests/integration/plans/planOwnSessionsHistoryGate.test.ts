import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Story MOTIR-9218 · MOTIR-9309 — the INTEGRATION GATE over the overlay's History
// read, assembled: every request goes through the route handler, the real 2FA
// gate, the real active-project resolution, `listOwnSessions` and the one SQL
// statement in `listPageByProject`, against real Postgres. The read card's own
// file (`planOwnSessionsHistory.test.ts`) tests the pieces; this one seeds ONE
// population that separates History from the Plans page's `mine` scope and
// reads both off it.
//
// The only stand-ins are the signed-in reader: `getSession`, and
// `getWorkspaceContext`, which reads the workspace cookie through
// `next/headers` and so has no request to read it from here.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-history-gate' })),
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

const reader = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (reader.current ? { user: { id: reader.current.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => reader.current,
}));

const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { GET } = await import('@/app/api/ai/plan-change/sessions/history/route');
const { GET: sessionGET } = await import('@/app/api/ai/plan-change/session/route');

type Page = {
  sessions: {
    id: string;
    origin: string;
    state: string;
    planCount: number;
    endedAt: string | null;
    endReason: string | null;
  }[];
  nextCursor: string | null;
};

let fx: WorkItemFixture;
let seq = 0;

/** Fixed instants, so every ordering below is decided by the seed, not the clock. */
const BASE = Date.parse('2026-10-01T12:00:00.000Z');
const at = (minutesBefore: number) => new Date(BASE - minutesBefore * 60_000);

async function seatMember(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `history-gate-${seq++}@example.com`,
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

/** Sign `ctx` in, with the project under test as their active one. */
async function signIn(ctx: ServiceContext) {
  await adminDb.workspaceMembership.updateMany({
    where: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    data: { activeProjectId: fx.projectId },
  });
  reader.current = { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

type Origin = 'conversation' | 'mcp' | 'generation' | 'expand' | 'cadence' | 'legacy' | 'guide';
type EndReason = 'failed' | 'idle' | 'restarted' | 'declined' | 'approved';

/** A session written directly — its starter, origin, last activity and end. */
async function session(opts: {
  by: string;
  at: Date;
  origin?: Origin;
  ended?: EndReason;
  projectId?: string;
}): Promise<string> {
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: opts.projectId ?? fx.projectId,
      createdById: opts.by,
      scopeKey: PROJECT_SCOPE.scopeKey,
      targetKeys: [],
      turnCount: 0,
      origin: opts.origin ?? 'conversation',
      lastActivityAt: opts.at,
      ...(opts.ended ? { endedAt: opts.at, endReason: opts.ended } : {}),
    },
  });
  return s.id;
}

/** A plan in its OWN session, started by `ctx`, last active at `when`. */
async function planBy(ctx: ServiceContext, title: string, when: Date) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title, session: { origin: 'mcp' }, authorSource: 'mcp', createdById: ctx.userId },
    ctx,
  );
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
  await adminDb.planChangeSession.update({
    where: { id: row.sessionId! },
    data: { lastActivityAt: when },
  });
  return { planId: plan.id, sessionId: row.sessionId! };
}

const req = (query = '') =>
  new Request(`http://localhost/api/ai/plan-change/sessions/history${query}`);

async function history(query = ''): Promise<Page> {
  const res = await GET(req(query));
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/** Every page of the viewer's History, following `nextCursor` to its end. */
async function allPages(): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const page = await history(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

const ids = (page: { sessions: { id: string }[] }) => page.sessions.map((s) => s.id);

/** The read's order: last activity, newest first; ties by id, highest first. */
const byActivity = (rows: { id: string; at: Date }[]) =>
  [...rows]
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((r) => r.id);

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  reader.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the History population, seeded beside the Plans page’s', () => {
  /**
   * ONE project holding every dimension the two reads could be confused on: the
   * viewer's sessions of every origin, open and ended for several reasons, with no
   * plan and with a decided one; a colleague's sessions; a colleague's session whose
   * plan is routed to the viewer; and the viewer's session in another project.
   */
  async function seed() {
    const viewer = fx.ctx;
    const colleague = await seatMember();
    const by = viewer.userId;

    const conversation = await session({ by, at: at(1), origin: 'conversation' });
    const mcp = await session({ by, at: at(2), origin: 'mcp', ended: 'idle' });
    const generation = await session({ by, at: at(3), origin: 'generation', ended: 'failed' });
    const expand = await session({ by, at: at(4), origin: 'expand', ended: 'declined' });
    const cadence = await session({ by, at: at(5), origin: 'cadence', ended: 'restarted' });
    const legacy = await session({ by, at: at(6), origin: 'legacy' });
    const guide = await session({ by, at: at(7), origin: 'guide' });

    const decided = await planBy(viewer, 'Decided plan', at(8));
    await adminDb.plan.update({
      where: { id: decided.planId },
      data: { status: 'approved', decidedById: by, decidedAt: at(8) },
    });
    await adminDb.planChangeSession.update({
      where: { id: decided.sessionId },
      data: { endedAt: at(8), endReason: 'approved' },
    });

    const theirs = [
      await session({ by: colleague.userId, at: at(9) }),
      await session({ by: colleague.userId, at: at(10), ended: 'idle' }),
    ];
    const routed = await planBy(colleague, 'Routed to the viewer', at(11));
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: routed.planId,
        state: 'awaiting',
        routedToId: by,
      },
    });

    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSW',
    });
    const otherProject = await session({ by, at: at(0), projectId: elsewhere.id });

    await signIn(viewer);
    return {
      viewer,
      own: { conversation, mcp, generation, expand, cadence, legacy, decided },
      guide,
      theirs,
      routed,
      otherProject,
    };
  }

  it('lists only the viewer’s sessions in this project: no colleague’s, no other project’s', async () => {
    const s = await seed();
    const page = await history();

    for (const id of [...s.theirs, s.routed.sessionId, s.otherProject]) {
      expect(ids(page)).not.toContain(id);
    }
    expect(ids(page)).toEqual([
      s.own.conversation,
      s.own.mcp,
      s.own.generation,
      s.own.expand,
      s.own.cadence,
      s.own.legacy,
      s.own.decided.sessionId,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('lists a session of every origin but guide', async () => {
    const s = await seed();
    const page = await history();

    expect(ids(page)).not.toContain(s.guide);
    expect(new Set(page.sessions.map((r) => r.origin))).toEqual(
      new Set(['conversation', 'mcp', 'generation', 'expand', 'cadence', 'legacy']),
    );
  });

  it('applies no plan, plan-state or ended filter, and each row reports its own', async () => {
    const s = await seed();
    const rows = new Map((await history()).sessions.map((r) => [r.id, r]));

    expect(rows.get(s.own.conversation)).toMatchObject({
      planCount: 0,
      state: 'none',
      endedAt: null,
      endReason: null,
    });
    expect(rows.get(s.own.mcp)).toMatchObject({ planCount: 0, endReason: 'idle' });
    expect(rows.get(s.own.generation)).toMatchObject({ planCount: 0, endReason: 'failed' });
    expect(rows.get(s.own.expand)).toMatchObject({ planCount: 0, endReason: 'declined' });
    expect(rows.get(s.own.cadence)).toMatchObject({ planCount: 0, endReason: 'restarted' });
    expect(rows.get(s.own.legacy)).toMatchObject({ planCount: 0, endedAt: null });
    expect(rows.get(s.own.decided.sessionId)).toMatchObject({
      planCount: 1,
      state: 'approved',
      endedAt: at(8).toISOString(),
      endReason: 'approved',
    });
  });

  it('keeps a plan routed to the viewer out of History, while the Plans page’s `mine` keeps it', async () => {
    const s = await seed();
    expect(ids(await history())).not.toContain(s.routed.sessionId);

    const plansMine = await planSessionsService.listSessions(fx.projectId, s.viewer, {
      view: 'mine',
      limit: 100,
    });
    expect(ids(plansMine)).toContain(s.routed.sessionId);

    // The Plans read is exactly the repository read with its own arguments and NO
    // `ownerId`: the option History added changes nothing for it. Whether a
    // zero-plan session is in it is the Plans page's own rule (MOTIR-9300), so it
    // is compared, never pinned.
    const direct = await withWorkspaceServiceContext(s.viewer.workspaceId, (tx) =>
      planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: s.viewer.workspaceId,
          limit: 101,
          after: null,
          state: null,
          mine: { userId: s.viewer.userId, routedPlanIds: [s.routed.planId] },
        },
        tx,
      ),
    );
    expect(ids(plansMine)).toEqual(direct.map((r) => r.id));
  });

  it('lists the viewer’s question-only session whatever the Plans page does with it', async () => {
    const s = await seed();
    const page = await history();
    const questionOnly = page.sessions.find((r) => r.id === s.own.conversation);
    expect(questionOnly).toMatchObject({ planCount: 0 });
  });
});

describe('paging through the route', () => {
  it('pages 25 sessions as 10, 10 and 5 in (last activity desc, id desc) order', async () => {
    const seeded: { id: string; at: Date }[] = [];
    for (let i = 0; i < 25; i++) {
      const when = at(i + 1);
      seeded.push({ id: await session({ by: fx.ownerId, at: when }), at: when });
    }
    await signIn(fx.ctx);

    const pages = await allPages();

    expect(pages.map((p) => p.sessions.length)).toEqual([10, 10, 5]);
    expect(pages.at(-1)!.nextCursor).toBeNull();
    expect(pages.flatMap(ids)).toEqual(byActivity(seeded));
  });

  it('returns two sessions tied on last activity across the page boundary exactly once each', async () => {
    const seeded: { id: string; at: Date }[] = [];
    // Positions 10 and 11 (1-based) share one instant, so the first page ends
    // between them.
    for (let i = 0; i < 25; i++) {
      const when = at(i < 10 ? i + 1 : i);
      seeded.push({ id: await session({ by: fx.ownerId, at: when }), at: when });
    }
    await signIn(fx.ctx);
    const tied = byActivity(seeded.filter((r) => r.at.getTime() === at(10).getTime()));
    expect(tied).toHaveLength(2);

    const pages = await allPages();
    const seen = pages.flatMap(ids);

    expect(ids(pages[0]!).at(-1)).toBe(tied[0]);
    expect(ids(pages[1]!)[0]).toBe(tied[1]);
    expect(tied[0]! > tied[1]!).toBe(true);
    expect(seen.filter((id) => tied.includes(id))).toEqual(tied);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(byActivity(seeded));
  });

  it('answers a malformed cursor with a 400, not a 500', async () => {
    await signIn(fx.ctx);
    const res = await GET(req('?cursor=garbage'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PLAN_SESSION_CURSOR' });
  });

  it('clamps `limit` exactly as the Plans read clamps it', async () => {
    // Sessions that hold a plan, so the Plans read lists them under any rule.
    for (let i = 0; i < 3; i++) await planBy(fx.ctx, `Plan ${i}`, at(i + 1));
    await signIn(fx.ctx);

    for (const limit of [0, -4, 2, 1000]) {
      const route = await history(`?limit=${limit}`);
      const plans = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        view: 'mine',
        limit,
      });
      expect([limit, route.sessions.length]).toEqual([limit, plans.sessions.length]);
      expect(route.nextCursor === null).toBe(plans.nextCursor === null);
    }
    expect((await history('?limit=0')).sessions).toHaveLength(1);
    expect((await history('?limit=1000')).sessions).toHaveLength(3);
  });
});

describe('who is asking', () => {
  it('refuses a request with no session as the sibling session route does', async () => {
    reader.current = null;
    const res = await GET(req());
    const sibling = await sessionGET(new Request('http://localhost/api/ai/plan-change/session'));
    expect(res.status).toBe(sibling.status);
    expect(res.status).toBe(401);
  });

  it('gives a viewer with no sessions an empty page and no cursor', async () => {
    await session({ by: fx.ownerId, at: at(1) });
    await signIn(await seatMember());

    const page = await history();
    expect(page.sessions).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
