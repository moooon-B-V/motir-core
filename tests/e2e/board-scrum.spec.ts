// E2E: the Scrum board — sprint header, sprint scope, the unchanged move
// contract, and the no-active-sprint state (Story 4.5 · Subtask 4.5.4, the
// Story-closing test).
//
// @smoke — proves the 4.5 layer end-to-end over the real stack: the 4.5.2
// sprint-scoped projection + `SprintSummaryDto` aggregates rendered by the
// 4.5.3 `SprintHeader` / `NoActiveSprintState` chrome, on top of the REUSED
// 3.2/3.3 board surface. Four focused journeys:
//   - HEADER: name + state, the goal, "N days remaining", the committed /
//     completed / remaining points summary, the per-column point pills, and
//     the Complete-sprint entry point.
//   - SCOPE: only the active sprint's issues render on the scrum board; an
//     out-of-sprint issue is absent there but present on the Kanban board
//     (whose projection stays unscoped, `sprint: null`).
//   - MOVE CONTRACT: a cross-column drag on the scrum board still applies the
//     workflow transition (the 3.2 contract, byte-for-byte) and does NOT
//     change the card's sprint — it stays on the sprint-scoped board.
//   - NO ACTIVE SPRINT: once the sprint completes, the board area is replaced
//     by the "No active sprint" empty state with a CTA to the Backlog — not an
//     empty six-column board, and not the unscoped backlog.
//
// The fixture (tests/e2e/_helpers/scrum-board-seed.ts) seeds through the
// SHIPPED services only — the sprint is started via the real 4.4 lifecycle
// (which provisions the scrum board), so sprint state is never poked into the
// DB column directly. The scrum board is NOT the project default; the spec
// reaches it the productized way, via the 3.7.5 `?board=<id>` selection.
//
// SCOPE: this is the 4.5 sprint-layer journey only. It does NOT re-drive the
// drag/WIP/swimlane journeys (board-ui.spec.ts / board-swimlanes.spec.ts own
// those — swimlanes/WIP compose on the scrum board because it IS the same
// component), nor the at-scale scrum board (the Epic-4 test story 4.7's
// board-at-scale specs + the 4.7.1 sprint-shaped large fixture own scale).
// The projection/aggregate unit matrix lives in tests/boards/
// scrum-projection.test.ts (4.5.2); the header/empty-state render branches in
// tests/components/scrum-board.test.tsx (4.5.3); this proves them composed.

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { getBoard, columnByStatus } from './_helpers/board';
import {
  seedScrumBoard,
  SCRUM_SPRINT_GOAL,
  SCRUM_SPRINT_NAME,
  type ScrumSeed,
} from './_helpers/scrum-board-seed';
import { sprintsService } from '@/lib/services/sprintsService';
import type { BoardProjectionDto } from '@/lib/dto/boards';

const OWNER_EMAIL = 'board-scrum-owner@motir.dev';

/** GET /api/board?boardId= → a SPECIFIC board's projection (the 3.7.5 selection
 *  param) — the scrum board here is not the project default, so the bare
 *  `getBoard` (default-board) helper can't reach it. */
async function getBoardById(ctx: APIRequestContext, boardId: string): Promise<BoardProjectionDto> {
  const res = await ctx.get(`/api/board?boardId=${encodeURIComponent(boardId)}`);
  expect(res.status(), 'GET /api/board?boardId=').toBe(200);
  return (await res.json()) as BoardProjectionDto;
}

// The board card's data-testid is keyed by the work item IDENTIFIER (SCB-1, …).
function cardTid(identifier: string): string {
  return `board-card-${identifier}`;
}

// Open the SCRUM board via the `?board=` selection and wait past the loading
// skeleton. A wide viewport keeps the first columns on screen for the drag.
async function openScrumBoard(page: Page, seed: ScrumSeed): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/boards?board=${encodeURIComponent(seed.scrumBoardId)}`);
  await expect(page.getByTestId('sprint-header')).toBeVisible({ timeout: 15_000 });
}

// A REAL pointer drag (same shape as board-ui.spec.ts's): clear the dnd-kit
// PointerSensor's 8px activation distance, settle over the target column's
// body, drop, and return the `/api/board/move` POST the drop fires.
async function pointerDrag(
  page: Page,
  from: Locator,
  to: Locator,
): ReturnType<Page['waitForResponse']> {
  const f = (await from.boundingBox())!;
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * 0.4;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.mouse.move(tx, ty, { steps: 4 });
  const move = page.waitForResponse(
    (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.mouse.up();
  return move;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Service-seeded tenant + several cold route compiles; headroom over the 30s
// default, matching the sibling board specs.
test.describe.configure({ timeout: 90_000 });

test.describe('board-scrum @smoke', () => {
  test('the sprint header shows name, state, goal, time remaining and the points summary; per-column point totals render', async ({
    page,
  }) => {
    const seed = await seedScrumBoard(OWNER_EMAIL);
    await signIn(page, seed.email, seed.password);

    // Resolve column ids from the same projection the page renders, so the
    // per-column pill assertions key off real ids.
    const board = await getBoardById(page.request, seed.scrumBoardId);
    const todoCol = columnByStatus(board, 'todo');
    const doneCol = columnByStatus(board, 'done');

    await openScrumBoard(page, seed);
    const header = page.getByTestId('sprint-header');

    // Name + the Active state pill + the goal (one line, Tooltip reveal).
    await expect(header.getByRole('heading', { name: SCRUM_SPRINT_NAME })).toBeVisible();
    await expect(header.getByText('Active', { exact: true })).toBeVisible();
    await expect(header.getByText(SCRUM_SPRINT_GOAL)).toBeVisible();

    // Time remaining — the 5-day window seeded by the fixture renders the
    // "N days remaining" treatment (never "Ended", never a negative number).
    await expect(header.getByText(/\d+ days? remaining/)).toBeVisible();
    await expect(header.getByText('Ended', { exact: true })).toHaveCount(0);

    // The points summary — committed 10 / completed 2 / remaining 8, straight
    // from the SprintSummaryDto aggregates (A 3 + B 2 + C 5 committed; B done).
    // The aria-label pins the exact figures; the visible tiles carry the
    // labelled numbers (text+number, never colour alone — finding #35).
    await expect(
      header.locator('[aria-label="Story points: 10 committed, 2 completed, 8 remaining"]'),
    ).toBeVisible();
    for (const label of ['Committed', 'Completed', 'Remaining']) {
      await expect(header.getByText(label, { exact: true })).toBeVisible();
    }

    // Per-column point totals (the Jira "sprint health" pill): todo holds
    // A (3) + C (5) = 8 pts; done holds B = 2 pts.
    await expect(page.getByTestId(`board-points-${todoCol.id}`)).toHaveText('8 pts');
    await expect(page.getByTestId(`board-points-${doneCol.id}`)).toHaveText('2 pts');

    // The Complete-sprint entry point is mounted in the header (the flow it
    // opens is Story 4.4's — the entry point's presence is 4.5's contract).
    await expect(header.getByTestId('scrum-complete-sprint')).toBeVisible();
  });

  test("only the active sprint's issues render on the scrum board; the Kanban board stays unscoped", async ({
    page,
  }) => {
    const seed = await seedScrumBoard(OWNER_EMAIL);
    await signIn(page, seed.email, seed.password);
    await openScrumBoard(page, seed);

    // Every in-sprint issue renders…
    for (const issue of [seed.issueA, seed.issueB, seed.issueC]) {
      await expect(page.getByTestId(cardTid(issue.identifier))).toBeVisible();
    }
    // …and the out-of-sprint issue is ABSENT from the sprint-scoped board.
    await expect(page.getByTestId(cardTid(seed.outOfSprint.identifier))).toHaveCount(0);

    // The DEFAULT (kanban) board is untouched by the sprint scope: its
    // projection carries the out-of-sprint issue and `sprint: null` — the
    // scope is the scrum board's filter, not a project-wide hiding.
    const kanban = await getBoard(page.request);
    expect(kanban.sprint).toBeNull();
    const kanbanTodoIds = columnByStatus(kanban, 'todo').cards.map((c) => c.id);
    expect(kanbanTodoIds).toContain(seed.outOfSprint.id);
  });

  test('a cross-column drag on the scrum board still transitions the status and leaves the sprint unchanged', async ({
    page,
  }) => {
    const seed = await seedScrumBoard(OWNER_EMAIL);
    await signIn(page, seed.email, seed.password);

    const board = await getBoardById(page.request, seed.scrumBoardId);
    const inProgCol = columnByStatus(board, 'in_progress'); // todo → in_progress is legal

    await openScrumBoard(page, seed);

    // Drag A (todo) into in_progress — the 3.2 move-as-transition contract,
    // unchanged on the scrum surface.
    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(seed.issueA.identifier)),
      page.getByTestId(`board-column-${inProgCol.id}`),
    );
    expect(res.status(), 'a legal move returns 200').toBe(200);

    // The card lands in the new column — still ON the sprint-scoped board,
    // because the move changed its status, not its sprint.
    await expect(
      page.getByTestId(`board-column-${inProgCol.id}`).getByTestId(cardTid(seed.issueA.identifier)),
    ).toBeVisible();

    // Committed state: the re-fetched scrum projection shows A in in_progress…
    const after = await getBoardById(page.request, seed.scrumBoardId);
    expect(columnByStatus(after, 'in_progress').cards.map((c) => c.id)).toContain(seed.issueA.id);
    // …and the row's sprint association is untouched (the DB-state assertion —
    // the sanctioned cross-layer reach for committed-state checks).
    const row = await db.workItem.findUniqueOrThrow({ where: { id: seed.issueA.id } });
    expect(row.sprintId, 'a board move never changes the sprint').toBe(seed.sprintId);
  });

  test('a scrum board with no active sprint shows the "No active sprint" state with a Backlog CTA — not an empty board', async ({
    page,
  }) => {
    const seed = await seedScrumBoard(OWNER_EMAIL);
    // Complete the sprint through the shipped 4.4 flow (carry-over → backlog
    // by default), leaving the scrum board with NO active sprint.
    await sprintsService.completeSprint(seed.sprintId, {}, seed.ctx);

    await signIn(page, seed.email, seed.password);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/boards?board=${encodeURIComponent(seed.scrumBoardId)}`);

    // The board area is REPLACED by the no-active-sprint empty state — its own
    // copy, distinct from the 3.2.6 "No issues yet" empty-board state.
    await expect(page.getByText('No active sprint', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('No issues yet')).toHaveCount(0);
    // Not an empty six-column board, and no sprint header chrome either.
    await expect(page.locator('section[data-testid^="board-column-"]')).toHaveCount(0);
    await expect(page.getByTestId('sprint-header')).toHaveCount(0);

    // The CTA links to the Backlog (Story 4.2) — where a sprint is planned and
    // started; 4.5 never starts one itself.
    await page.getByRole('link', { name: 'Go to Backlog' }).click();
    await page.waitForURL('**/backlog');
  });
});
