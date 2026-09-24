import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The PUBLIC plan-item PATCH carries a leaf's DIFFICULTY (Story MOTIR-6095 ·
// MOTIR-6136) — the human proposal-edit door, beside the MCP tools and the
// internal route motir-ai writes through.
//
// The route picks its keys by NAME, so a key it does not list is DROPPED with a
// `200`; this asserts on what the plan holds AFTERWARDS, never on the status
// alone. Scaffolding (the two session/workspace stubs) is the carve-out
// `publicProposalPatchTodos.test.ts` documents.

const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({
  getSession: async () => (activeCtx.current ? { user: { id: activeCtx.current.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

const { PATCH } = await import('@/app/api/plans/[id]/items/[itemId]/route');

beforeEach(async () => {
  activeCtx.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function patch(planId: string, itemId: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://core/api/plans/${planId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: planId, itemId }) },
  );
}

/** A `planned` plan with one `add` of `kind`, and the session pointed at its workspace. */
async function plannedPlanWithOneAdd(
  fx: WorkItemFixture,
  kind: 'task' | 'story',
  difficulty?: 'trivial' | 'low' | 'medium' | 'high',
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Editable' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'A card', kind, ...(difficulty ? { difficulty } : {}) },
      },
    ],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  activeCtx.current = {
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  } as ProjectContext;
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

async function storedDifficulty(itemId: string): Promise<unknown> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return (row.proposedFields as { difficulty?: unknown }).difficulty;
}

describe('PATCH /api/plans/[id]/items/[itemId] — `difficulty` (MOTIR-6136)', () => {
  it('SETS it, and the plan holds it afterwards', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, 'task');

    expect((await patch(planId, itemId, { difficulty: 'high' })).status).toBe(200);
    expect(await storedDifficulty(itemId)).toBe('high');
  });

  it('leaves it alone when the body does not name it, and CLEARS it on an explicit `null`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, 'task', 'medium');

    expect((await patch(planId, itemId, { priority: 'high' })).status).toBe(200);
    expect(await storedDifficulty(itemId)).toBe('medium');

    expect((await patch(planId, itemId, { difficulty: null })).status).toBe(200);
    expect(await storedDifficulty(itemId)).toBeNull();
  });

  it('answers 422 INVALID_PROPOSAL naming the field for a CONTAINER, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, 'story');

    const res = await patch(planId, itemId, { difficulty: 'low' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('difficulty');
    expect(await storedDifficulty(itemId)).toBeUndefined();
  });

  it('answers 422 INVALID_PROPOSAL for a value outside the scale, rather than storing it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, 'task');

    const res = await patch(planId, itemId, { difficulty: 'extreme' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_PROPOSAL');
    expect(await storedDifficulty(itemId)).toBeUndefined();
  });
});
