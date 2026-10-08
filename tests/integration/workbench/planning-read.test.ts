import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkbenchPlanningPageDto } from '@/lib/dto/home';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// THE READER'S PLANS BEING WRITTEN (Story MOTIR-7820 · Subtask MOTIR-7828), against
// real Postgres: the membership predicate (own · generating · active project), the
// `planning` badge agreeing with the list's `total` (one builder), paging and its
// clamp, the row's fields and progress, the flat query cost, and the route.

// ── The seams OUTSIDE the path under test (the route's cookies) ─────────────
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const wsCtx = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
const { GET: planningRoute } = await import('@/app/api/workbench/planning/route');
const { workbenchPlanningService } = await import('@/lib/services/workbenchPlanningService');
const { homeService } = await import('@/lib/services/homeService');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  wsCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture, projectId: string = fx.projectId) => ({
  ...fx.ctx,
  projectId,
});

async function enrolMember(fx: WorkItemFixture, slug: string) {
  const user = await createTestUser({ email: `${slug}-${Date.now()}@example.com`, name: slug });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    workspaceRole: 'member',
  });
  return user;
}

/** A plan, opened through the product's own door, then placed in time. */
async function plan(
  fx: WorkItemFixture,
  opts: {
    title: string;
    createdById: string | null;
    at: string;
    projectId?: string;
    origin?: 'user' | 'cadence';
    adds?: number;
    authorSource?: 'mcp' | null;
    authorHarness?: string;
    authorModel?: string;
  },
): Promise<string> {
  const created = await plansService.createPlan(
    opts.projectId ?? fx.projectId,
    {
      title: opts.title,
      createdById: opts.createdById ?? undefined,
      origin: opts.origin,
      authorSource: opts.authorSource ?? undefined,
      authorHarness: opts.authorHarness,
      authorModel: opts.authorModel,
    },
    fx.ctx,
  );
  const adds = opts.adds ?? 0;
  if (adds > 0) {
    await plansService.addProposals(
      created.id,
      Array.from({ length: adds }, (_, i) => ({
        op: 'add' as const,
        proposedFields: { title: `${opts.title} add ${i}`, kind: 'task' as const },
      })),
      fx.ctx,
    );
  }
  await adminDb.plan.update({ where: { id: created.id }, data: { createdAt: new Date(opts.at) } });
  return created.id;
}

/** Every statement the pg driver sends, minus the transaction's own frames. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([q]) => {
      const text = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? '');
      return !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

/** The fixture the card names: two of the reader's own generating plans, and one
 *  of every kind of plan that must NOT appear. */
async function fixture() {
  const fx = await makeWorkItemFixture({ identifier: 'PLN' });
  const teammate = await enrolMember(fx, 'teammate');
  const other = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'OTH',
    name: 'Other',
  });
  const older = await plan(fx, {
    title: 'Older',
    createdById: fx.ownerId,
    at: '2026-10-01T10:00:00Z',
    adds: 2,
    authorSource: 'mcp',
    authorHarness: 'Claude Code',
    authorModel: 'opus',
  });
  const newer = await plan(fx, {
    title: 'Newer',
    createdById: fx.ownerId,
    at: '2026-10-02T10:00:00Z',
    adds: 1,
  });
  const planned = await plan(fx, {
    title: 'Proposed',
    createdById: fx.ownerId,
    at: '2026-10-03T10:00:00Z',
    adds: 1,
  });
  await plansService.markPlanned(planned, fx.ctx);
  const declined = await plan(fx, {
    title: 'Declined',
    createdById: fx.ownerId,
    at: '2026-10-03T11:00:00Z',
  });
  await adminDb.plan.update({ where: { id: declined }, data: { status: 'declined' } });
  const teammates = await plan(fx, {
    title: 'Teammate',
    createdById: teammate.id,
    at: '2026-10-03T12:00:00Z',
  });
  const cadence = await plan(fx, {
    title: 'Cadence',
    createdById: null,
    origin: 'cadence',
    at: '2026-10-03T13:00:00Z',
  });
  const elsewhere = await plan(fx, {
    title: 'Elsewhere',
    createdById: fx.ownerId,
    projectId: other.id,
    at: '2026-10-03T14:00:00Z',
  });
  return { fx, teammate, other, older, newer, planned, declined, teammates, cadence, elsewhere };
}

describe('listMyPlansBeingWritten — membership', () => {
  it("returns exactly the reader's own generating plans in the active project, newest first", async () => {
    const { fx, older, newer } = await fixture();
    const page = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx));
    expect(page.items.map((r) => r.planId)).toEqual([newer, older]);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 50 });
  });

  it('the planning badge is the list total — and both drop a plan once it is proposed', async () => {
    const { fx, older, newer } = await fixture();
    const counts = await homeService.tabCounts(hctx(fx));
    const page = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx));
    expect(counts.planning).toBe(2);
    expect(page.total).toBe(counts.planning);

    await plansService.markPlanned(newer, fx.ctx);
    const after = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx));
    expect(after.items.map((r) => r.planId)).toEqual([older]);
    expect(after.total).toBe(1);
    expect((await homeService.tabCounts(hctx(fx))).planning).toBe(1);
  });

  it('a reader who cannot browse the active project gets 0 and an empty page, not an error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEC' });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    const outsider = await enrolMember(fx, 'outsider');
    await plan(fx, { title: 'Theirs', createdById: outsider.id, at: '2026-10-01T10:00:00Z' });
    const ctx = { userId: outsider.id, workspaceId: fx.workspaceId, projectId: fx.projectId };

    expect((await homeService.tabCounts(ctx)).planning).toBe(0);
    const page = await workbenchPlanningService.listMyPlansBeingWritten(ctx);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });
});

describe('listMyPlansBeingWritten — paging', () => {
  it('pages with `limit`, and clamps an out-of-range page to the last one', async () => {
    const { fx, older, newer } = await fixture();
    const first = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx), { limit: 1 });
    expect(first.items.map((r) => r.planId)).toEqual([newer]);
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });

    const second = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx), {
      limit: 1,
      page: 2,
    });
    expect(second.items.map((r) => r.planId)).toEqual([older]);
    expect(second).toMatchObject({ total: 2, page: 2, pageSize: 1 });

    const past = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx), {
      limit: 1,
      page: 99,
    });
    expect(past.items.map((r) => r.planId)).toEqual([older]);
    expect(past).toMatchObject({ total: 2, page: 2, pageSize: 1 });
  });
});

describe('listMyPlansBeingWritten — the row', () => {
  it('carries the author, the targets in stored order (null for an unresolvable key) and the progress', async () => {
    const { fx, older } = await fixture();
    const target = await createTestWorkItem(fx, { title: 'The story', kind: 'story' });
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: older } });
    expect(row.sessionId).not.toBeNull();
    await adminDb.planChangeSession.update({
      where: { id: row.sessionId! },
      data: { targetKeys: ['PLN-999', target.identifier] },
    });

    const page = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx));
    const item = page.items.find((r) => r.planId === older)!;
    expect(item).toMatchObject({
      planId: older,
      sessionId: row.sessionId,
      title: 'Older',
      projectName: fx.project.name,
      targets: [
        { key: 'PLN-999', title: null },
        { key: target.identifier, title: 'The story' },
      ],
      author: { source: 'mcp', harness: 'Claude Code', model: 'opus', origin: 'user' },
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    expect(item.progress).not.toBeNull();
    // `proposed` is the plan's `add` rows — carried unmodified from the derivation.
    expect(item.progress.proposed).toBe(2);
    expect(item.progress.startedAt).toBe('2026-10-01T10:00:00.000Z');
  });

  it('costs the same number of queries for 1 plan and for 10', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'QRY' });
    const target = await createTestWorkItem(fx, { title: 'Target', kind: 'story' });
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(
        await plan(fx, {
          title: `Q${i}`,
          createdById: fx.ownerId,
          at: `2026-10-01T10:${String(i).padStart(2, '0')}:00Z`,
          adds: 1,
        }),
      );
    }
    const sessions = await adminDb.plan.findMany({
      where: { id: { in: ids } },
      select: { sessionId: true },
    });
    await adminDb.planChangeSession.updateMany({
      where: { id: { in: sessions.map((s) => s.sessionId!).filter(Boolean) } },
      data: { targetKeys: [target.identifier] },
    });

    const one = await countQueries(() =>
      workbenchPlanningService.listMyPlansBeingWritten(hctx(fx), { limit: 1 }),
    );
    const ten = await countQueries(() =>
      workbenchPlanningService.listMyPlansBeingWritten(hctx(fx), { limit: 10 }),
    );
    expect(one).toBeGreaterThan(0);
    expect(ten).toBe(one);
  });
});

describe('GET /api/workbench/planning', () => {
  it('answers 401 without a session', async () => {
    const res = await planningRoute(new Request('http://localhost/api/workbench/planning'));
    expect(res.status).toBe(401);
  });

  it("returns the reader's page with one, honouring ?page=", async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RTE' });
    await plan(fx, { title: 'Live', createdById: fx.ownerId, at: '2026-10-01T10:00:00Z', adds: 1 });
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };

    const res = await planningRoute(new Request('http://localhost/api/workbench/planning?page=7'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkbenchPlanningPageDto;
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]!).sort()).toEqual(
      [
        'author',
        'createdAt',
        'planId',
        'progress',
        'projectName',
        'sessionId',
        'targets',
        'title',
      ].sort(),
    );
  });
});
