import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The PUBLIC plan-item PATCH carries an `add`'s SUPERSEDES set (Story MOTIR-6577 ·
// MOTIR-6631) — the human proposal-edit door, beside the MCP tools and the
// internal routes motir-ai writes through. The set is STRUCTURAL, so the route
// hands it to `correctProposal` (flagged `byReviewer`) rather than the deepen
// substrate; this asserts on what the plan holds AFTERWARDS and on the trail's
// attribution, never on the status alone. Scaffolding (the two session/workspace
// stubs) is the carve-out `publicProposalPatchTodos.test.ts` documents.

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

async function planWithOneAdd(
  fx: WorkItemFixture,
  close = true,
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Editable', authorSource: 'mcp', authorHarness: 'Claude Code', authorModel: 'm' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The replacement', kind: 'task' } }],
    fx.ctx,
  );
  if (close) await plansService.markPlanned(plan.id, fx.ctx);
  activeCtx.current = {
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  } as ProjectContext;
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

const storedRefs = async (itemId: string) =>
  (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).supersedesRefs;

describe('PATCH /api/plans/[id]/items/[itemId] — `supersedesRefs` (MOTIR-6631)', () => {
  it('REPLACES the set, records the PERSON on the trail, and `[]` clears it', async () => {
    const fx = await makeWorkItemFixture();
    const old = await createTestWorkItem(fx, { kind: 'task', title: 'Old' });
    const { planId, itemId } = await planWithOneAdd(fx);

    const res = await patch(planId, itemId, { supersedesRefs: [old.id], title: 'Renamed too' });
    expect(res.status).toBe(200);
    expect(await storedRefs(itemId)).toEqual([old.id]);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.proposedFields).toMatchObject({ title: 'Renamed too' });

    const edit = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, planItemId: itemId, changeKind: 'edited' },
      orderBy: { changedAt: 'desc' },
    });
    expect(edit.changedById).toBe(fx.ctx.userId);
    expect(edit.actorHarness ?? null).toBeNull();

    expect((await patch(planId, itemId, { supersedesRefs: [] })).status).toBe(200);
    expect(await storedRefs(itemId)).toEqual([]);
  });

  it('leaves the set alone when the body does not name it', async () => {
    const fx = await makeWorkItemFixture();
    const old = await createTestWorkItem(fx, { kind: 'task', title: 'Old' });
    const { planId, itemId } = await planWithOneAdd(fx);
    expect((await patch(planId, itemId, { supersedesRefs: [old.id] })).status).toBe(200);

    expect((await patch(planId, itemId, { priority: 'high' })).status).toBe(200);
    expect(await storedRefs(itemId)).toEqual([old.id]);
  });

  it('refuses a DANGLING ref with the service’s typed 422, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithOneAdd(fx);

    const res = await patch(planId, itemId, { supersedesRefs: ['cm-no-such-work-item'] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(body.reason).toBe('dangling');
    expect(await storedRefs(itemId)).toEqual([]);
  });

  it('keeps this route `planned`-only: a `generating` plan is a 409', async () => {
    const fx = await makeWorkItemFixture();
    const old = await createTestWorkItem(fx, { kind: 'task', title: 'Old' });
    const { planId, itemId } = await planWithOneAdd(fx, false);

    const res = await patch(planId, itemId, { supersedesRefs: [old.id] });
    expect(res.status).toBe(409);
    expect(await storedRefs(itemId)).toEqual([]);
  });
});
