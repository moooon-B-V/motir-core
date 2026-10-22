import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSessionOrigin, PlanStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestUser } from '../../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE FRESH-START NOTICE POINTS ONLY AT A CONVERSATION THAT REACHED PLANNING
// (MOTIR-9304; amendment 5 clause 6). Real Postgres; motir-ai stubbed at its client,
// so every `plan` row is seeded through `adminDb` — the row's existence IS the settled
// definition of "reached planning". Both resume doors are driven: the project-wide
// read and the work-item-anchored one, which hand the same read a different scope.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-earlier' })),
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
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function me(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/**
 * A conversation of `scopeKey`, ENDED `idle` so nothing resumes it and the notice
 * is what the fresh start reads. `minutes` orders the scope's conversations.
 */
async function conversation(opts: {
  minutes: number;
  scopeKey?: string;
  targetKeys?: string[];
  ownerId?: string;
  origin?: PlanSessionOrigin;
}): Promise<string> {
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: opts.ownerId ?? fx.ownerId,
      origin: opts.origin ?? 'conversation',
      scopeKey: opts.scopeKey ?? PROJECT_SCOPE_KEY,
      targetKeys: opts.targetKeys ?? [],
      turnCount: 1,
      lastActivityAt: minutesAgo(opts.minutes),
      endedAt: minutesAgo(opts.minutes),
      endReason: 'idle',
    },
  });
  return s.id;
}

async function holdPlan(sessionId: string, status: PlanStatus = 'declined') {
  await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      createdById: fx.ownerId,
    },
  });
}

async function rowCounts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    locks: await adminDb.planTargetLock.count(),
    gates: await adminDb.approvalGate.count(),
  };
}

describe('the project-wide door (findResumableWithEarlier)', () => {
  it('skips a NEWER plan-less conversation for an OLDER one that planned', async () => {
    const older = await conversation({ minutes: 60 });
    await holdPlan(older, 'declined');
    await conversation({ minutes: 5 });

    const read = await planChangeSessionsService.findResumableWithEarlier(me());
    expect(read.session).toBeNull();
    expect(read.earlier?.id).toBe(older);
  });

  it('offers no link when none of the scope’s conversations planned, and writes nothing', async () => {
    await conversation({ minutes: 60 });
    await conversation({ minutes: 5 });
    const before = await rowCounts();

    const read = await planChangeSessionsService.findResumableWithEarlier(me());
    expect(read.session).toBeNull();
    expect(read.earlier).toBeNull();
    expect(await rowCounts()).toEqual(before);
  });

  it.each<PlanStatus>(['generating', 'planned', 'stale', 'approved', 'declined'])(
    'a conversation holding one `%s` plan is offered — existence, not status',
    async (status) => {
      const id = await conversation({ minutes: 10 });
      await holdPlan(id, status);
      const read = await planChangeSessionsService.findResumableWithEarlier(me());
      expect(read.earlier?.id).toBe(id);
    },
  );

  it('the copy read beside it did NOT narrow: the own ended plan-less session is copyable', async () => {
    const id = await conversation({ minutes: 10 });
    const read = await planChangeSessionsService.findResumableWithEarlier(me());
    expect(read.earlier).toBeNull();
    expect(read.copyable?.id).toBe(id);
  });

  it('keeps the conversation-origin clause: a guide or mcp session holding a plan is never offered', async () => {
    const guide = await conversation({ minutes: 1, origin: 'guide' });
    await holdPlan(guide);
    const mcp = await conversation({ minutes: 2, origin: 'mcp' });
    await holdPlan(mcp);
    const convo = await conversation({ minutes: 3 });
    await holdPlan(convo);

    const read = await planChangeSessionsService.findResumableWithEarlier(me());
    expect(read.earlier?.id).toBe(convo);
  });

  it('keeps the shipped field set, with `mine` false for another member’s conversation', async () => {
    const other = await createTestUser({
      email: `other-9304-${Date.now()}@example.com`,
      name: 'Other',
    });
    const at = minutesAgo(10);
    const theirs = await conversation({ minutes: 10, ownerId: other.id });
    await holdPlan(theirs);
    await adminDb.planChangeSession.update({ where: { id: theirs }, data: { lastActivityAt: at } });

    const read = await planChangeSessionsService.findResumableWithEarlier(me());
    expect(read.earlier).toEqual({
      id: theirs,
      targetKeys: [],
      lastActivityAt: at.toISOString(),
      startedBy: { id: other.id, name: 'Other' },
      mine: false,
    });

    const mine = await conversation({ minutes: 1 });
    await holdPlan(mine);
    expect((await planChangeSessionsService.findResumableWithEarlier(me())).earlier).toMatchObject({
      id: mine,
      mine: true,
    });
  });
});

describe('the work-item-anchored door (getSessionForWorkItem)', () => {
  it('inherits the rule from the one read: no link while the scope’s conversation holds no plan, the link once it does', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The anchored card' },
      fx.ctx,
    );
    const scope = buildScope([card.identifier]);
    const id = await conversation({
      minutes: 10,
      scopeKey: scope.scopeKey,
      targetKeys: [card.identifier],
    });

    const before = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: card.id },
      me(),
    );
    expect(before.session).toBeNull();
    expect(before.earlier).toBeNull();

    await holdPlan(id, 'generating');
    const after = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: card.id },
      me(),
    );
    expect(after.earlier).toMatchObject({ id, targetKeys: [card.identifier], mine: true });
  });
});
