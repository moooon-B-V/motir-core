import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { workflowsService } from '@/lib/services/workflowsService';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  BoardColumnDto,
  BoardProjectionDto,
  MoveCardTarget,
  PagedColumnCardsDto,
} from '@/lib/dto/boards';
import type { TestUser } from './work-item-setup';

// Board-API helpers for the Story-3.1 closing E2E (Subtask 3.1.7), lifted into
// their own module so the Story-3.2 (Kanban UI) and 3.5 (Epic-3 test) specs can
// share them — the same lift pattern as workflow.ts / work-item-setup.ts. The
// board routes are ACTIVE-PROJECT scoped (GET /api/board, no key in the path):
// each helper drives them through the signed-in user's request context, so the
// route's getActiveProject() resolves the user's one project.

/** GET /api/board → the active project's default-board projection. */
export async function getBoard(ctx: APIRequestContext): Promise<BoardProjectionDto> {
  const res = await ctx.get('/api/board');
  expect(res.status(), 'GET /api/board').toBe(200);
  return (await res.json()) as BoardProjectionDto;
}

/**
 * GET /api/board/columns/[columnId]/cards?boardId=&cursor= → one lazy "load
 * more" page for a single column (finding #57). `cursor` is the opaque string
 * the previous page returned; omit it for the first page.
 */
export async function loadColumnCards(
  ctx: APIRequestContext,
  boardId: string,
  columnId: string,
  cursor?: string | null,
): Promise<PagedColumnCardsDto> {
  const qs = new URLSearchParams({ boardId });
  if (cursor) qs.set('cursor', cursor);
  const res = await ctx.get(`/api/board/columns/${columnId}/cards?${qs.toString()}`);
  expect(res.status(), 'GET column cards page').toBe(200);
  return (await res.json()) as PagedColumnCardsDto;
}

/**
 * POST /api/board/move — move a card. Returns the RAW response so the caller
 * asserts the status code itself (200 legal · 409 illegal-transition snapback ·
 * 422 unmapped target · 404 cross-tenant). `target` brackets the drop slot.
 */
export async function moveCard(
  ctx: APIRequestContext,
  boardId: string,
  workItemId: string,
  target: MoveCardTarget,
): Promise<APIResponse> {
  return ctx.post('/api/board/move', {
    data: { boardId, workItemId, ...target },
  });
}

/** The board column whose mapped statuses include `statusKey` (one per status on the default board). */
export function columnByStatus(board: BoardProjectionDto, statusKey: string): BoardColumnDto {
  const col = board.columns.find((c) => c.statusKeys.includes(statusKey));
  expect(col, `a column mapping status "${statusKey}"`).toBeTruthy();
  return col!;
}

/** The ordered ids of the cards currently in `statusKey`'s column. */
export function cardIdsIn(board: BoardProjectionDto, statusKey: string): string[] {
  return columnByStatus(board, statusKey).cards.map((c) => c.id);
}

/**
 * Add a custom workflow status to the project (the surface Story 2.2.5 exposes
 * in the workflow editor). Driven through `workflowsService` directly — the
 * sanctioned cross-layer reach for E2E SETUP (mirrors how work-item-setup.ts
 * creates projects via `projectsService`), since the status lands UNMAPPED on
 * the board and there is no board column for it. Returns the new status key.
 */
export async function addCustomStatus(
  user: TestUser,
  projectId: string,
  opts: { key: string; label: string; category?: StatusCategoryDto },
): Promise<string> {
  const status = await workflowsService.createStatus({
    userId: user.userId,
    workspaceId: user.workspaceId,
    projectId,
    key: opts.key,
    label: opts.label,
    category: opts.category ?? 'in_progress',
  });
  return status.key;
}
