import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The PUBLIC plan-item PATCH carries `todos` (Story MOTIR-3810 · MOTIR-4619).
//
// `PATCH /api/plans/[id]/items/[itemId]` parses its body key by key, so a key it
// does not list is DROPPED rather than refused — the request succeeds, the
// response is a `200`, and the proposal keeps the list it had. That failure is
// invisible from both ends, which is why this asserts on what the plan holds
// AFTERWARDS and never on the status code alone.
//
// The route's own header records that no UI calls it today and that it is kept
// deliberately as an inventoried permission surface; its parse must still agree
// with the internal deepen route's, which is what the route's shipped comment
// asks of the two.
//
// The two session/workspace stubs are the node-env carve-out
// `contextualPlanningConfirmGate.test.ts` documents: there are no cookies to
// resolve a workspace from. Everything below them is real — a real Postgres, the
// real route, the real service.

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

/** A `planned` plan with one `add`, and the session pointed at its workspace. */
async function plannedPlanWithOneAdd(
  fx: WorkItemFixture,
  todos?: unknown,
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Editable' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: 'A card with steps',
          kind: 'task',
          ...(todos === undefined ? {} : { todos: todos as never }),
        },
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

describe('PATCH /api/plans/[id]/items/[itemId] — `todos` (MOTIR-4619)', () => {
  it('SETS the list, and the plan holds it afterwards', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx);

    const res = await patch(planId, itemId, {
      todos: [{ text: 'Create the account' }, { text: 'Invite the team', executor: 'human' }],
    });

    expect(res.status).toBe(200);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.proposedFields as { todos?: Array<{ text: string }> }).todos?.map((t) => t.text)) //
      .toEqual(['Create the account', 'Invite the team']);
  });

  it('leaves the list alone when the body does not name it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, [{ text: 'The one step' }]);

    expect((await patch(planId, itemId, { priority: 'high' })).status).toBe(200);

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.proposedFields as { todos?: unknown[] }).todos).toHaveLength(1);
  });

  it('CLEARS it on an explicit `null`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx, [{ text: 'The one step' }]);

    expect((await patch(planId, itemId, { todos: null })).status).toBe(200);

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.proposedFields as { todos?: unknown }).todos).toBeNull();
  });

  it('answers 422 INVALID_PROPOSAL for a step past the granularity bar', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlanWithOneAdd(fx);

    const res = await patch(planId, itemId, {
      todos: [{ text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1) }],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_PROPOSAL');
    // The refusal left the proposal untouched — a rejected edit writes nothing.
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.proposedFields as { todos?: unknown }).todos).toBeUndefined();
  });
});
