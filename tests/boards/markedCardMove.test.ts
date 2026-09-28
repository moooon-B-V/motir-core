import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A MARKED card on the BOARD (Story MOTIR-6575 · MOTIR-6682) — against a REAL
// Postgres, through the shipped service and route. Only the session and
// active-project resolvers are stubbed, as every route suite here does.
//
// What it pins:
//   · `boardsService.moveCard` re-raises the guard's `MarkedCardCannotReopenError`
//     as `MarkedCardBoardMoveError`, naming the card and its mark;
//   · `POST /api/board/move` answers 409 `{ code: 'MARKED_CARD_CANNOT_REOPEN',
//     key, mark }` — not the snap-back's ILLEGAL_BOARD_MOVE, and not a 500;
//   · the card's status is unchanged;
//   · a move WITHIN the done category (Done → Cancelled, on a workflow that draws
//     the edge) is not a reopen, and goes through.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { MarkedCardBoardMoveError } from '@/lib/boards/errors';
import { POST as movePOST } from '@/app/api/board/move/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
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

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** A finished story, marked. */
async function markedDoneStory(mark: 'outdated' | 'deprecated' = 'outdated') {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The v1 importer' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
  await workItemsService.updateWorkItem(story.id, { obsolescence: mark }, fx.ctx);
  return story;
}

/** A board with one column per workflow status, keyed by status key. */
async function boardColumns() {
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
  return { boardId: board.id, columns, statuses };
}

function move(boardId: string, workItemId: string, toColumnId: string) {
  return movePOST(
    new Request('http://localhost:3000/api/board/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId, workItemId, toColumnId }),
    }),
  );
}

describe('a marked card on the board (MOTIR-6682)', () => {
  it(
    'POST /api/board/move answers 409 MARKED_CARD_CANNOT_REOPEN with the key and mark, and moves nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const story = await markedDoneStory('deprecated');
      const { boardId, columns } = await boardColumns();

      const res = await move(boardId, story.id, columns.todo!);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; key: string; mark: string };
      expect(body).toMatchObject({
        code: 'MARKED_CARD_CANNOT_REOPEN',
        key: story.identifier,
        mark: 'deprecated',
      });
      expect(await statusOf(story.id)).toBe('done');
    },
  );

  it(
    'boardsService.moveCard raises MarkedCardBoardMoveError',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const story = await markedDoneStory();
      const { boardId, columns } = await boardColumns();

      const err = await boardsService
        .moveCard(boardId, story.id, { toColumnId: columns.in_progress! }, fx.ctx)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MarkedCardBoardMoveError);
      expect(err).toMatchObject({ key: story.identifier, mark: 'outdated' });
      expect(await statusOf(story.id)).toBe('done');
    },
  );

  it(
    'Done → Cancelled is not a reopen: the drag goes through',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const story = await markedDoneStory();
      const { boardId, columns, statuses } = await boardColumns();
      // The default workflow draws no done → cancelled edge; this project does.
      const byKey = new Map(statuses.map((s) => [s.key, s.id]));
      await adminDb.workflowTransition.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          fromStatusId: byKey.get('done')!,
          toStatusId: byKey.get('cancelled')!,
        },
      });

      const res = await move(boardId, story.id, columns.cancelled!);

      expect(res.status).toBe(200);
      expect(await statusOf(story.id)).toBe('cancelled');
    },
  );
});
