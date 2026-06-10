import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { workflowsService } from '@/lib/services/workflowsService';
import { signIn } from './shell-session';
import { SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD } from '../../../scripts/seedLargeBoard';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { BoardColumnDto, BoardProjectionDto, MoveCardTarget } from '@/lib/dto/boards';
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

// ── At-scale UI helpers (Subtask 3.5.1) ─────────────────────────────────────
// Page-level (vs. the API helpers above) helpers the cross-cutting at-scale
// board specs (3.5.2 load model · 3.5.3 interaction) drive against the seeded
// board-shaped tenant. Additive — they do not touch the existing 3.1.7/3.6.4
// API helpers. They lean on the board's stable testids (`board`, `board-column-`,
// `board-card-`, `board-count-`, `board-overcap-banner`), the same set
// board-load.spec.ts asserts against.

/** The board container testid flips `board-skeleton` → `board` once the projection
 *  fetch resolves. Navigate to `/boards` and wait for the loaded board. The at-scale
 *  seed ships a heavy set, so the default budget is generous; raise it for over-cap. */
export async function gotoLoadedBoard(page: Page, loadTimeout = 30_000): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: loadTimeout });
}

/** Sign in as the `db:seed:large` (board-shaped) tenant owner, then open the
 *  loaded board — the seed pins the owner's active project, so `/boards` resolves
 *  the BIG project. The single entry point the at-scale specs use to reach a
 *  fully-populated board over the real stack. */
export async function signInBoardSeedOwnerAndOpenBoard(
  page: Page,
  loadTimeout = 30_000,
): Promise<void> {
  await signIn(page, SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD);
  await gotoLoadedBoard(page, loadTimeout);
}

/** The mounted card-node Locator for a column (by column id) — `board-card-*`
 *  descendants of the column. Because the column virtualizes (`useRowWindow`),
 *  `.count()` is the MOUNTED (rendered) node count, NOT the column total — that
 *  is the whole point of {@link expectColumnVirtualized}. */
export function columnCardNodes(page: Page, columnId: string): Locator {
  return page.getByTestId(`board-column-${columnId}`).locator('[data-testid^="board-card-"]');
}

/** The column's count badge value (its FULL `totalCount` denominator, unaffected
 *  by virtualization or the Done-age window). */
export async function columnTotalBadge(page: Page, columnId: string): Promise<number> {
  const text = await page.getByTestId(`board-count-${columnId}`).textContent();
  return Number((text ?? '').trim());
}

/** Assert a column is DOM-bounded: its mounted card-node count is > 0 but well
 *  below its full total — i.e. it virtualized rather than mounting every row.
 *  `total` is the column's full `totalCount` (from the projection / count badge). */
export async function expectColumnVirtualized(
  page: Page,
  columnId: string,
  total: number,
): Promise<void> {
  const nodes = columnCardNodes(page, columnId);
  await expect(nodes.first()).toBeVisible();
  const mounted = await nodes.count();
  expect(mounted, 'mounted card nodes').toBeGreaterThan(0);
  expect(mounted, 'mounted < total (virtualized)').toBeLessThan(total);
}

/** Assert NO per-column "Load more" affordance exists anywhere on the board — the
 *  retired 3.8.3 cursor paging (neither a button nor any "load more" text). The
 *  board's only load affordance is the column's own scroll. */
export async function expectNoLoadMore(page: Page): Promise<void> {
  await expect(page.getByText(/load more/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);
}

/** The over-cap "refine your filter" banner Locator (`board-overcap-banner`) —
 *  present iff the board total exceeds the (resolved) cap. Use `.toHaveCount(0)`
 *  to assert absence under the cap, `.toBeVisible()` past it. */
export function overCapBanner(page: Page): Locator {
  return page.getByTestId('board-overcap-banner');
}

// ── At-scale SCRUM helpers (Subtask 4.7.1) ──────────────────────────────────
// The Scrum analogue of the 3.5.1 at-scale helpers above, for the cross-cutting
// Scrum journey specs (4.7.2 load model + scope + header · 4.7.3 interaction +
// complete). They drive the SPRINT-shaped seed (`SEED_SHAPE=scrum`,
// scripts/seed-large.ts → seedLargeScrumSprint), which flips the BIG project's
// board to scrum and gives it a large `active` sprint. Additive — they do not
// touch the 3.5.1 board helpers. The page helpers lean on the SAME stable board
// testids the kanban specs use, plus the scrum header surface defined by the
// `design/boards/scrum.mock.html` (4.5.1) mockup that Story 4.5.3 builds:
// `sprint-header`, a `points-summary` carrying the committed/completed/remaining
// figures in its aria-label, and a per-column `board-points-<columnId>` pill.

/** Sign in as the sprint-shaped seed's tenant owner and open the loaded Scrum
 *  board. The scrum seed reuses the SAME tenant owner as the board seed (it
 *  composes `seedLargeBoard`), with the project's board flipped to scrum + a
 *  large active sprint — so `/boards` renders the sprint-scoped board. The single
 *  entry point the Scrum at-scale specs use to reach a fully-populated active
 *  sprint over the real stack. */
export async function signInScrumSeedOwnerAndOpenScrumBoard(
  page: Page,
  loadTimeout = 30_000,
): Promise<void> {
  await signIn(page, SEED_LARGE_OWNER_EMAIL, SEED_LARGE_OWNER_PASSWORD);
  await gotoLoadedBoard(page, loadTimeout);
}

/** The sprint header's committed / completed / remaining story points, parsed
 *  from the `points-summary` aria-label inside `[data-testid="sprint-header"]`
 *  (the 4.5.1 design: `aria-label="Story points: 34 committed, 12 completed, 22
 *  remaining"`). The figures come from the 4.5.2 bounded aggregates, so they
 *  reflect the WHOLE sprint — not a loaded page's sum. */
export async function readSprintHeaderPoints(
  page: Page,
): Promise<{ committed: number; completed: number; remaining: number }> {
  const summary = page
    .getByTestId('sprint-header')
    .locator('[aria-label*="committed"][aria-label*="completed"]');
  const label = (await summary.getAttribute('aria-label')) ?? '';
  const num = (word: string): number => {
    const m = label.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+${word}`, 'i'));
    expect(m, `"${word}" figure in sprint-header aria-label "${label}"`).toBeTruthy();
    return Number(m![1]);
  };
  return { committed: num('committed'), completed: num('completed'), remaining: num('remaining') };
}

/** A column's per-column story-point pill value (`board-points-<columnId>`, the
 *  scrum-only addition to the column header in the 4.5.1 design). Distinct from
 *  {@link columnTotalBadge} (the issue COUNT). */
export async function columnPointPill(page: Page, columnId: string): Promise<number> {
  const text = await page.getByTestId(`board-points-${columnId}`).textContent();
  return Number((text ?? '').replace(/[^\d.]/g, ''));
}

/** Every card id currently mounted on the board, across all columns — the basis
 *  for an "is / isn't in the active sprint scope" assertion over the projection
 *  (the scrum board renders ONLY the active sprint's issues, so an id present
 *  here is in scope; an out-of-sprint id is absent). Works off the API
 *  projection {@link getBoard}, so it is independent of virtualization. */
export function allBoardCardIds(board: BoardProjectionDto): string[] {
  return board.columns.flatMap((c) => c.cards.map((card) => card.id));
}

/** Assert the projection is a scrum board scoped to an active sprint: `sprint`
 *  is non-null, and an optional in-sprint id IS rendered while an optional
 *  out-of-sprint id is absent (the seed leaves a backlog slice outside the
 *  sprint). */
export function expectActiveSprintScope(
  board: BoardProjectionDto,
  opts: { present?: string; absent?: string } = {},
): void {
  expect(board.sprint, 'scrum board has an active sprint summary').not.toBeNull();
  const ids = new Set(allBoardCardIds(board));
  if (opts.present) expect(ids.has(opts.present), `in-sprint ${opts.present} on board`).toBe(true);
  if (opts.absent) expect(ids.has(opts.absent), `out-of-sprint ${opts.absent} absent`).toBe(false);
}
