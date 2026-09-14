import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE APPROVAL-GATE GUARD's refusal on the two SESSION doors (Story MOTIR-4887 ·
// Subtask MOTIR-5526): `POST /api/board/move` and `changeStatusAction`, which the
// item page, quick view, inline edit and edit form all commit through. Real
// Postgres through the real services; only the session and active-project
// resolvers are stubbed, as every route/action suite here does.
//
// What is pinned is the SHAPE the surfaces read — `code` plus the `gate` payload —
// because MOTIR-5528 / MOTIR-5529 render from it. The v1 door is
// `tests/api/v1/work-item-transitions-approval-gate.test.ts`; MCP is in
// `tests/workflows/approval-gate-guard.test.ts`.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { changeStatusAction } from '@/app/(authed)/items/[key]/edit/actions';
import { POST as movePOST } from '@/app/api/board/move/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function gatedItem() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Design' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: `subject-${item.id}`,
      },
      tx,
    ),
  );
  return item;
}

async function boardWithDoneColumn() {
  const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
  const board = await adminDb.board.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Board',
      type: 'kanban',
      position: 'a0',
    },
  });
  const columns: Record<string, string> = {};
  for (const [n, status] of statuses.entries()) {
    const column = await adminDb.boardColumn.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        name: status.label,
        position: `c${n.toString(36)}`,
      },
    });
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        columnId: column.id,
        statusId: status.id,
      },
    });
    columns[status.key] = column.id;
  }
  return { boardId: board.id, columns };
}

function move(body: unknown) {
  return movePOST(
    new Request('http://localhost:3000/api/board/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/board/move', () => {
  it('answers 409 `APPROVAL_GATE_PENDING` with the gate payload — not `ILLEGAL_BOARD_MOVE`', async () => {
    const item = await gatedItem();
    const { boardId, columns } = await boardWithDoneColumn();

    const res = await move({ boardId, workItemId: item.id, toColumnId: columns.done });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string; gate: unknown };
    expect(body.code).toBe('APPROVAL_GATE_PENDING');
    expect(body.gate).toEqual({
      itemKey: item.identifier,
      kind: 'design_result',
      waitingOn: 'decision',
      gateRaised: true,
      canDecide: true,
      routedToLabel: expect.any(String),
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
  });

  it('a drop on any other column still moves the card', async () => {
    const item = await gatedItem();
    const { boardId, columns } = await boardWithDoneColumn();

    const res = await move({ boardId, workItemId: item.id, toColumnId: columns.blocked });

    expect(res.status).toBe(200);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'blocked',
    );
  });
});

describe('changeStatusAction', () => {
  it('returns `code` and `gate` for the held move, with the catalog message', async () => {
    const item = await gatedItem();

    const result = await changeStatusAction({ id: item.id, toStatusKey: 'done' });

    expect(result).toMatchObject({
      ok: false,
      field: 'status',
      code: 'APPROVAL_GATE_PENDING',
      gate: { itemKey: item.identifier, kind: 'design_result', canDecide: true },
    });
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });

  it('every other failure keeps the plain `{ ok: false, error }` shape', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Plain' },
      fx.ctx,
    );

    // `todo → done` is not an edge in the default restricted workflow.
    const result = await changeStatusAction({ id: item.id, toStatusKey: 'done' });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('gate');
  });
});
