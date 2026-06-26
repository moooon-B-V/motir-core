import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as validatePlanPOST } from '@/app/api/internal/ai/validate-plan/route';
import { POST as validatePlanSprintPOST } from '@/app/api/internal/ai/validate-plan-sprint/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — the two pre-commit plan-validation endpoints (Subtask 7.28.2)
// end-to-end through the REAL routes, real Postgres. Asserts the auth grants
// (§4a service bearer + §4b job token) identically to plan-delta, the 400/404/409
// branches, and that a happy path returns the validity DTO VERBATIM from
// planValidityService.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function req(path: string, opts: { bearer?: string; token?: string; body: unknown }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(`http://core${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

const tokenFor = (fx: WorkItemFixture): string =>
  mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId });

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'story' | 'task' | 'subtask',
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

/** A `planned` plan whose single `modify` makes `targetId` blocked_by `blockerId`. */
async function planBlocking(
  fx: WorkItemFixture,
  targetId: string,
  blockerId: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: targetId, patch: { blockedByAdd: [blockerId] } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('POST /api/internal/ai/validate-plan', () => {
  it('401s a missing service bearer and a tampered token (before any work)', async () => {
    const fx = await makeWorkItemFixture();
    const noBearer = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        token: tokenFor(fx),
        body: { planId: 'x', targetKey: 'y' },
      }),
    );
    expect(noBearer.status).toBe(401);

    const [payload] = tokenFor(fx).split('.');
    const badToken = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: `${payload}.deadbeef`,
        body: { planId: 'x', targetKey: 'y' },
      }),
    );
    expect(badToken.status).toBe(401);
  });

  it('400s a missing targetKey and an unknown condition', async () => {
    const fx = await makeWorkItemFixture();
    const noTarget = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'p' },
      }),
    );
    expect(noTarget.status).toBe(400);

    const badCondition = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'p', targetKey: 'MOTIR-1', condition: 'whenever' },
      }),
    );
    expect(badCondition.status).toBe(400);
  });

  it('404s an unknown planId and an unknown targetKey', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const badPlan = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'plan_missing', targetKey: story.identifier },
      }),
    );
    expect(badPlan.status).toBe(404);

    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const badTarget = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: plan.id, targetKey: 'MOTIR-999999' },
      }),
    );
    expect(badTarget.status).toBe(404);
  });

  it('returns the validity DTO verbatim — valid and invalid bodies', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await mk(fx, 'Outside', 'task');
    const planId = await planBlocking(fx, child.id, outside.id);

    const invalid = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId, targetKey: story.identifier },
      }),
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({
      key: story.identifier,
      valid: false,
      blockers: [
        {
          item: child.identifier,
          blockedBy: outside.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });

    // A no-op plan over the same target is valid.
    const emptyPlan = await plansService.createPlan(fx.projectId, { title: 'Empty' }, fx.ctx);
    await plansService.markPlanned(emptyPlan.id, fx.ctx);
    const valid = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: emptyPlan.id, targetKey: story.identifier },
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ key: story.identifier, valid: true, blockers: [] });
  });
});

describe('POST /api/internal/ai/validate-plan-sprint', () => {
  it('401s a missing service bearer', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', { token: tokenFor(fx), body: { planId: 'x' } }),
    );
    expect(res.status).toBe(401);
  });

  it('400s a missing planId', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it('409s when the project has no active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: plan.id },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('returns the sprint validity DTO verbatim for an invalid projected sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    await db.workItem.update({ where: { id: inSprint.id }, data: { sprintId: sprint.id } });
    const backlog = await mk(fx, 'Backlog blocker', 'task');
    const planId = await planBlocking(fx, inSprint.id, backlog.id);

    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sprintId: sprint.id,
      valid: false,
      blockers: [
        {
          item: inSprint.identifier,
          blockedBy: backlog.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });
  });
});
