import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { isEnforced } from '@/lib/permissions/catalog';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6179 · MOTIR-6330 — the plan reads take a SCOPE. `project` is
// served to a reader holding `plan:view_any` (and, on a token, a grant that holds
// it); `mine` — the sessions a reader started, or holding a plan they asked for,
// decided or have routed to them — to anyone who browses. A single plan outside
// the reader's scope is the same not-found an unknown id is. Real Postgres, the
// real resolver; only the motir-ai boundary is mocked.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-scope' })),
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

const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { planReviewService } = await import('@/lib/services/planReviewService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { runGetPlan } = await import('@/lib/mcp/tools/getPlan');

let fx: WorkItemFixture;
let seq = 0;

async function seat(role: 'member' | 'viewer'): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `scope-${role}-${seq++}@example.com`,
    password: 'correct-horse-battery-staple',
    name: `Reader ${role}`,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** A project member on a CUSTOM role listing exactly `permissions`. */
async function seatCustom(permissions: PermissionKey[]): Promise<ServiceContext> {
  const ctx = await seat('member');
  const role = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: `Custom ${seq++}`,
      permissions,
    },
  });
  await adminDb.$transaction((tx) =>
    projectMembershipRepository.setRoleDefinition(
      ctx.userId,
      fx.projectId,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );
  return ctx;
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

const AUTHOR_WITHOUT_VIEW: PermissionKey[] = [
  'project:browse',
  'work_item:edit',
  'ai:plan',
  'ai:view_plan',
];

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the list resolves a SERVED scope', () => {
  it('a Member is served `project` and sees a colleague’s session; `mine` narrows to their own', async () => {
    const member = await seat('member');
    const theirs = await planBy(fx.ctx, 'Owner plan');
    const mine = await planBy(member, 'Member plan');

    const project = await planSessionsService.listSessions(fx.projectId, member, {
      view: 'project',
    });
    expect(project.scope).toBe('project');
    expect(project.sessions.map((s) => s.id).sort()).toEqual(
      [theirs.sessionId, mine.sessionId].sort(),
    );

    const own = await planSessionsService.listSessions(fx.projectId, member, { view: 'mine' });
    expect(own.scope).toBe('mine');
    expect(own.sessions.map((s) => s.id)).toEqual([mine.sessionId]);
  });

  it('a Viewer is served `project` — every session', async () => {
    const viewer = await seat('viewer');
    const theirs = await planBy(fx.ctx, 'Owner plan');
    const page = await planSessionsService.listSessions(fx.projectId, viewer);
    expect(page.scope).toBe('project');
    expect(page.sessions.map((s) => s.id)).toEqual([theirs.sessionId]);
  });

  it('an author WITHOUT `plan:view_any` asking for `project` is served `mine` — never refused', async () => {
    const author = await seatCustom(AUTHOR_WITHOUT_VIEW);
    await planBy(fx.ctx, 'Owner plan');
    const own = await planBy(author, 'Author plan');
    const page = await planSessionsService.listSessions(fx.projectId, author, { view: 'project' });
    expect(page.scope).toBe('mine');
    expect(page.sessions.map((s) => s.id)).toEqual([own.sessionId]);
  });

  it('a reader holding neither key is served `mine`, and it is empty', async () => {
    const reader = await seatCustom(['project:browse']);
    await planBy(fx.ctx, 'Owner plan');
    const page = await planSessionsService.listSessions(fx.projectId, reader, { view: 'project' });
    expect(page).toMatchObject({ scope: 'mine', sessions: [], nextCursor: null });
  });

  it('`mine` includes a plan the reader DECIDED and a plan ROUTED to them', async () => {
    const reader = await seatCustom(['project:browse']);
    const decided = await planBy(fx.ctx, 'Decided by reader');
    const routed = await planBy(fx.ctx, 'Routed to reader');
    await planBy(fx.ctx, 'Neither');
    await adminDb.plan.update({
      where: { id: decided.planId },
      data: { decidedById: reader.userId },
    });
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
    const page = await planSessionsService.listSessions(fx.projectId, reader, { view: 'mine' });
    expect(page.sessions.map((s) => s.id).sort()).toEqual(
      [decided.sessionId, routed.sessionId].sort(),
    );
  });

  it('the plan-state counts are counted over the SERVED scope', async () => {
    const author = await seatCustom(AUTHOR_WITHOUT_VIEW);
    await planBy(fx.ctx, 'Owner plan');
    await planBy(author, 'Author plan');
    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, author, {
      view: 'project',
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('a bearer token whose GRANT lacks `plan:view_any` is served `mine`, whatever the role holds', async () => {
    const member = await seat('member');
    await planBy(fx.ctx, 'Owner plan');
    const own = await planBy(member, 'Member plan');
    const narrowed: ServiceContext = {
      ...member,
      tokenGrant: ['project:browse', 'work_item:edit'],
    };
    const page = await planSessionsService.listSessions(fx.projectId, narrowed, {
      view: 'project',
    });
    expect(page.scope).toBe('mine');
    expect(page.sessions.map((s) => s.id)).toEqual([own.sessionId]);
  });

  it('issues ONE mine lookup and ONE list query per read, whatever the page size', async () => {
    const reader = await seatCustom(AUTHOR_WITHOUT_VIEW);
    for (let i = 0; i < 3; i += 1) await planBy(reader, `Plan ${i}`);
    const routed = vi.spyOn(approvalGateRepository, 'findAwaitingRoutedPlanIds');
    const list = vi.spyOn(planChangeSessionRepository, 'listPageByProject');
    try {
      for (const limit of [1, 50]) {
        routed.mockClear();
        list.mockClear();
        await planSessionsService.listSessions(fx.projectId, reader, { view: 'mine', limit });
        expect(routed).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledTimes(1);
      }
    } finally {
      routed.mockRestore();
      list.mockRestore();
    }
  });
});

describe('a single plan outside the reader’s scope is NOT-FOUND, identical to an unknown id', () => {
  it('getPlanForReader, getPlanReview and get_plan refuse a colleague’s plan and serve one’s own', async () => {
    const author = await seatCustom(AUTHOR_WITHOUT_VIEW);
    const theirs = await planBy(fx.ctx, 'Owner plan');
    const own = await planBy(author, 'Author plan');

    await expect(plansService.getPlanForReader(theirs.planId, author)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(plansService.getPlanForReader('no-such-plan', author)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(planReviewService.getPlanReview(theirs.planId, author)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(runGetPlan({ planId: theirs.planId }, author)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );

    expect((await plansService.getPlanForReader(own.planId, author)).id).toBe(own.planId);
    expect((await planReviewService.getPlanReview(own.planId, author)).id).toBe(own.planId);
  });

  it('a Viewer reads any plan; the system `getPlan` stays browse-only', async () => {
    const viewer = await seat('viewer');
    const reader = await seatCustom(['project:browse']);
    const theirs = await planBy(fx.ctx, 'Owner plan');
    expect((await plansService.getPlanForReader(theirs.planId, viewer)).id).toBe(theirs.planId);
    expect((await plansService.getPlan(theirs.planId, reader)).id).toBe(theirs.planId);
  });

  it('the overlay’s by-id session read refuses a session outside the scope', async () => {
    const reader = await seatCustom(['project:browse']);
    const theirs = await planBy(fx.ctx, 'Owner plan');
    const pctx = {
      userId: reader.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
    await expect(
      planChangeSessionsService.getByIdForReader(pctx, theirs.sessionId),
    ).rejects.toMatchObject({ code: 'PLAN_SESSION_NOT_FOUND' });
  });
});

describe('authoring is untouched', () => {
  it('an author without `plan:view_any` opens, appends to and closes their OWN plan', async () => {
    const author = await seatCustom(AUTHOR_WITHOUT_VIEW);
    const { planId } = await planBy(author, 'Author plan');
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
      author,
    );
    const closed = await plansService.markPlanned(planId, author);
    expect(closed.status).toBe('planned');
  });
});

describe('the key is enforced and grantable', () => {
  it('`plan:view_any` is enforced, and a token can be granted it', () => {
    expect(isEnforced('plan:view_any')).toBe(true);
    expect(GRANTABLE_PERMISSIONS).toContain('plan:view_any');
  });
});
