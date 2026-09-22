import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { usersService } from '@/lib/services/usersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6023 — the IN-APP doors address a session by id (story MOTIR-6011;
// `agent-authored-plans.md` AMENDMENT 17 §1–§3). The ask door and item-anchored
// planning land their turns on the session they are GIVEN — never on a sibling
// session of the same scope — and a browse-only member reading an item's
// planning state creates nothing. Only the motir-ai boundary is mocked.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-door-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
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
const { aiAskService } = await import('@/lib/services/aiAskService');
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');

const THREE_HOURS = 3 * 60 * 60 * 1000;
let fx: WorkItemFixture;

function pctx(userId = fx.ownerId): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}

/** Two sessions of ONE scope: an older one gone quiet, and a newer one. */
async function twoSessions(scope = PROJECT_SCOPE) {
  const older = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'older');
  await adminDb.planChangeSession.update({
    where: { id: older.id },
    data: { lastActivityAt: new Date(Date.now() - THREE_HOURS) },
  });
  const newer = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'newer');
  expect(newer.id).not.toBe(older.id);
  return { older: older.id, newer: newer.id };
}

async function userBodies(sessionId: string) {
  return (
    await adminDb.planChangeTurn.findMany({
      where: { sessionId, role: 'user' },
      orderBy: { seq: 'asc' },
    })
  ).map((t) => t.body);
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the ASK door', () => {
  it('lands the turn on the session it was given, not on the scope’s newer one', async () => {
    const { older, newer } = await twoSessions();

    const result = await aiAskService.submitTurn('what is blocked?', pctx(), { sessionId: older });

    expect(result.session.id).toBe(older);
    expect(await userBodies(older)).toEqual(['older', 'what is blocked?']);
    expect(await userBodies(newer)).toEqual(['newer']);
  });

  it('STARTS a session with the ask’s first turn when the caller has none', async () => {
    const result = await aiAskService.submitTurn('what is blocked?', pctx());

    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect(await userBodies(result.session.id)).toEqual(['what is blocked?']);
  });
});

describe('ITEM-ANCHORED planning', () => {
  async function story() {
    return workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Billing', parentId: null },
      fx.ctx,
    );
  }

  it('lands the turn on the session it was given', async () => {
    const item = await story();
    const scope = buildScope([item.identifier]);
    const older = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'older');

    const run = await contextualPlanningService.planFromWorkItem(
      { anchorId: item.id, prompt: 'split it', sessionId: older.id },
      pctx(),
    );

    expect(run.sessionId).toBe(older.id);
    expect(await userBodies(older.id)).toEqual(['older', 'split it']);
  });

  it('a browse-only member reading the item’s planning state creates nothing', async () => {
    const item = await story();
    const viewer = await usersService.createUser({
      email: 'viewer-6023@example.com',
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

    const read = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: item.id },
      pctx(viewer.id),
    );

    expect(read).toEqual({ session: null, planId: null });
    expect(await adminDb.planChangeSession.count()).toBe(0);
  });
});
