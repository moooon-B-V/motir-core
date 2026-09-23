import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { InvalidPlanSessionCursorError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { PLAN_SESSION_STATE_VALUES } from '@/lib/dto/planSessions';
import { createTestProject } from '../../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6025 — the Plans page lists planning SESSIONS (`agent-authored-plans.md`
// AMENDMENT 17 §8). Real Postgres, the real service and repository; only the
// motir-ai boundary is mocked (a conversation's first turn submits nothing, but
// the service module graph imports the client).

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-list' })),
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

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');

let fx: WorkItemFixture;

function pctx(userId = fx.ownerId): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}

/** Pin a session's activity so the list's order is the test's, not the clock's. */
async function activeAt(sessionId: string, at: Date) {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: at },
  });
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/**
 * A NEW conversation in the project scope. A member's second first turn within
 * the resume window lands on the session they already have (AMENDMENT 17 §3),
 * so each is aged past the window before the next one starts.
 */
let aged = 0;
async function freshSession(body: string): Promise<string> {
  const s = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, body);
  aged += 1;
  await activeAt(s.id, minutesAgo(180 + aged));
  return s.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('every session of the project is listed, newest activity first', () => {
  it('a plan-less conversation, an MCP plan’s session and a backfilled one — each titled right', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      buildScope(['ACME-1']),
      '  Split invoicing out of billing  ',
    );
    await activeAt(convo.id, minutesAgo(1));

    const agent = await plansService.createPlan(
      fx.projectId,
      { title: 'Agent-authored plan', session: { origin: 'mcp' }, authorSource: 'mcp' },
      fx.ctx,
    );
    const agentSession = (await adminDb.plan.findUniqueOrThrow({ where: { id: agent.id } }))
      .sessionId!;
    await activeAt(agentSession, minutesAgo(2));

    const legacy = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        origin: 'legacy',
        lastActivityAt: minutesAgo(3),
      },
    });
    const legacyPlan = await plansService.createPlan(
      fx.projectId,
      { summary: 'An old plan named only in prose', session: { sessionId: legacy.id } },
      fx.ctx,
    );

    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);

    expect(page.nextCursor).toBeNull();
    expect(page.sessions.map((s) => s.id)).toEqual([convo.id, agentSession, legacy.id]);
    const [c, a, l] = page.sessions;
    expect(c).toMatchObject({
      origin: 'conversation',
      firstTurn: 'Split invoicing out of billing',
      targetKeys: ['ACME-1'],
      latestPlan: null,
      planCount: 0,
      startedBy: { id: fx.ownerId },
    });
    expect(a).toMatchObject({
      origin: 'mcp',
      firstTurn: null,
      latestPlan: { id: agent.id, status: 'generating', title: 'Agent-authored plan' },
      planCount: 1,
    });
    // The backfilled session has no starter and no turn; its title falls back
    // to its plan's summary.
    expect(l).toMatchObject({
      origin: 'legacy',
      startedBy: null,
      latestPlan: { id: legacyPlan.id, title: 'An old plan named only in prose' },
    });
  });

  it('a row states its LATEST plan, and counts the earlier ones', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'go');
    const first = await plansService.createPlan(
      fx.projectId,
      { title: 'first', session: { sessionId: convo.id } },
      fx.ctx,
    );
    await adminDb.plan.update({
      where: { id: first.id },
      data: { status: 'declined', createdAt: minutesAgo(10) },
    });
    const second = await plansService.createPlan(
      fx.projectId,
      { title: 'second', session: { sessionId: convo.id } },
      fx.ctx,
    );

    const [row] = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;

    expect(row!.latestPlan).toMatchObject({ id: second.id, status: 'generating' });
    expect(row!.planCount).toBe(2);
  });

  it('is ONE statement per page — no per-row plan or turn read', async () => {
    for (let i = 0; i < 4; i += 1) {
      const id = await freshSession(`t${i}`);
      await plansService.createPlan(fx.projectId, { session: { sessionId: id } }, fx.ctx);
    }

    const calls: string[] = [];
    const rows = await adminDb.$transaction(async (tx) => {
      const counted = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          // `$queryRaw` delegates to `$queryRawInternal` through the receiver;
          // that is the same statement, not a second one.
          if (
            typeof prop === 'string' &&
            !prop.startsWith('_') &&
            prop !== 'then' &&
            !prop.endsWith('Internal')
          ) {
            calls.push(prop);
          }
          return value;
        },
      });
      return planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          limit: 10,
          after: null,
          state: null,
        },
        counted,
      );
    });

    expect(rows).toHaveLength(4);
    expect(calls).toEqual(['$queryRaw']);
  });
});

describe('the plan-state filter', () => {
  it('narrows the list, and the counts match a walk of every filter', async () => {
    const make = async (status: 'planned' | 'approved' | null, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const id = await freshSession('x');
        if (status) {
          const plan = await plansService.createPlan(
            fx.projectId,
            { session: { sessionId: id } },
            fx.ctx,
          );
          await adminDb.plan.update({ where: { id: plan.id }, data: { status } });
        }
      }
    };
    await make(null, 3);
    await make('planned', 2);
    await make('approved', 1);

    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    expect(counts).toEqual({
      none: 3,
      generating: 0,
      planned: 2,
      stale: 0,
      approved: 1,
      declined: 0,
    });
    for (const planState of PLAN_SESSION_STATE_VALUES) {
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, { planState });
      expect({ planState, n: page.sessions.length }).toEqual({ planState, n: counts[planState] });
      for (const s of page.sessions) expect(s.latestPlan?.status ?? 'none').toBe(planState);
    }
  });
});

describe('paging', () => {
  it('neither skips nor repeats a row when sessions SHARE a lastActivityAt across a boundary', async () => {
    const same = minutesAgo(5);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await freshSession(`t${i}`);
      ids.push(id);
    }
    for (const id of ids) {
      await activeAt(id, same);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        cursor,
        limit: 2,
      });
      seen.push(...page.sessions.map((s) => s.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    // Ties break on id, descending.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('clamps an absurd limit, and refuses a cursor it did not mint', async () => {
    await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'x');
    expect(
      (await planSessionsService.listSessions(fx.projectId, fx.ctx, { limit: 0 })).sessions,
    ).toHaveLength(1);
    expect(
      (await planSessionsService.listSessions(fx.projectId, fx.ctx, { limit: Number.NaN }))
        .sessions,
    ).toHaveLength(1);
    await expect(
      planSessionsService.listSessions(fx.projectId, fx.ctx, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidPlanSessionCursorError);
  });
});

describe('one row by id — the `?session=` landing', () => {
  it('returns the row, and null for an id from another project', async () => {
    const mine = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'mine');
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSW',
    });
    const theirs = await planChangeSessionsService.startWithFirstTurn(
      { ...pctx(), projectId: elsewhere.id, project: elsewhere },
      PROJECT_SCOPE,
      'theirs',
    );

    expect((await planSessionsService.getSessionRow(fx.projectId, mine.id, fx.ctx))?.id).toBe(
      mine.id,
    );
    expect(await planSessionsService.getSessionRow(fx.projectId, theirs.id, fx.ctx)).toBeNull();
  });
});

describe('browse is the permission', () => {
  it('a browse-only member sees every session, someone else’s included', async () => {
    await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'owner’s');
    const viewer = await usersService.createUser({
      email: 'viewer-6025@example.com',
      password: 'correct-horse-battery-staple-9',
      name: 'Viewer',
    });
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await projectMembersService.addMember({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });

    const page = await planSessionsService.listSessions(fx.projectId, {
      userId: viewer.id,
      workspaceId: fx.workspaceId,
    });
    expect(page.sessions.map((s) => s.firstTurn)).toEqual(['owner’s']);
  });
});
