// E2E: the Kanban board UI — drag-drop transitions, snap-back, in-column
// reorder, and keyboard-DnD (Story 3.2 · Subtask 3.2.7, the Story-closing test).
//
// @smoke — proves the board SURFACE end-to-end through the real shell, on top of
// the 3.1 board API that board-projection.spec.ts (3.1.7) already proves at the
// HTTP layer. This spec drives the actual /boards page in a real browser:
//   - RENDER: the default columns project in workflow order, cards land in the
//     right column, per-column counts show.
//   - LEGAL MOVE: a cross-column drag applies the workflow transition (the
//     move-as-transition contract), the card lands, the count updates, and a
//     re-fetched projection shows the new status.
//   - SNAP-BACK: an illegal cross-column drag returns 409 and the card animates
//     back to its origin column — status unchanged on re-fetch.
//   - REORDER: an in-column drag changes rank only (no transition), and the new
//     order persists on reload.
//   - KEYBOARD DnD: a card moves to another column with the keyboard alone
//     (focus → Space pick up → arrow → Space drop).
//
// It mirrors the setup of board-config.spec.ts (3.6.4): a browser sign-up (the
// creator = workspace owner), one server-seeded project pinned active, work
// items created over the `_test` transport, and the board projection read back
// through the signed-in user's request context for committed-state assertions.
//
// SCOPE: this is the 3.2 board-CARD journey only. It does NOT re-drive the
// WIP-limit / swimlane / large-scale-virtualization journeys — those are the
// Epic-3 test story (3.5) and the 3.2.5 db:seed:large scale check. The reducer
// confirm/revert unit contract + the BoardCard/BoardColumn/unmapped-tray render
// branches are covered by the 3.2.x Vitest component suites (board-move /
// board-card / board-column / board-completeness); this proves them composed,
// over the real stack.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus, cardIdsIn } from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';

const OWNER_EMAIL = 'e2e-board-ui-owner@example.com';

// The default workflow's six columns, in projection (workflow) order, and the
// legal transitions OUT of `todo` (lib/workflows/defaultWorkflow.ts). The board
// is laid out in this order; the drag tests pick a target whose legality is
// known from this graph.
//   todo → in_progress | blocked | cancelled   (legal)
//   todo → in_review | done                     (illegal — no transition)

// Sign-up auto-creates `<local>'s Workspace`; here we add the one project the
// board hangs off and pin it active so getActiveProject() resolves it on /boards.
// Identical shape to board-config.spec.ts's seedActiveProject.
async function seedActiveProject(
  email: string,
): Promise<{ userId: string; workspaceId: string; projectId: string }> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Board UI Demo',
    identifier: 'BUI',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

// The board card's data-testid is keyed by the work item IDENTIFIER (BUI-1, …),
// not its cuid; the projection is the source of truth for the mapping.
function cardTid(identifier: string): string {
  return `board-card-${identifier}`;
}

// Open /boards and wait for the interactive board to be present (past the
// loading skeleton). A wide viewport keeps the first four columns
// (todo · blocked · in_progress · in_review) on screen without horizontal
// scroll, so a pointer drag never has to chase a scrolling target.
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
}

// A REAL pointer drag from one element to another, clearing the dnd-kit
// PointerSensor's 8px activation distance before settling over the target, then
// dropping. Returns the `/api/board/move` POST the drop fires (the snapshot of
// the move contract) so the caller asserts its status (200 legal · 409 illegal).
// `dropYFrac` places the drop point within the target's height — the column body
// (below its sticky header) for a cross-column drop, or a sibling card's lower
// half to insert after it for an in-column reorder.
async function pointerDrag(
  page: Page,
  from: Locator,
  to: Locator,
  dropYFrac = 0.4,
): ReturnType<Page['waitForResponse']> {
  const f = (await from.boundingBox())!;
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * dropYFrac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  // Clear the 8px activation constraint, then glide onto the target.
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

// Browser sign-up (slow argon2) + several cold route compiles (boards + the
// quick-view chunk) add up; give the journeys headroom over the 30s default.
test.describe.configure({ timeout: 90_000 });

test.describe('board-ui @smoke', () => {
  test('renders the default columns in workflow order with cards grouped by status and per-column counts', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);

    const todoItem = await createItem(page.request, projectId, 'stays in todo');
    const movedItem = await createItem(page.request, projectId, 'goes in progress');
    expect((await transition(page.request, movedItem.id, 'in_progress')).status()).toBe(200);

    // Resolve column ids + card identifiers from the projection (the same data
    // the page renders), so the DOM assertions key off real ids.
    const board = await getBoard(page.request);
    const colIds = board.columns.map((c) => c.id);
    const todoCol = columnByStatus(board, 'todo');
    const inProgCol = columnByStatus(board, 'in_progress');
    const todoCard = todoCol.cards.find((c) => c.id === todoItem.id)!;
    const inProgCard = inProgCol.cards.find((c) => c.id === movedItem.id)!;

    await openBoard(page);

    // Every default column renders, in workflow order (the DOM column sequence
    // equals the projection's ordered column ids).
    // Scope to the column SECTIONs — the `board-column-` prefix also matches the
    // per-column `board-column-actions-<id>` menu button, which is not a column.
    const domColIds = await page
      .getByTestId('board')
      .locator('section[data-testid^="board-column-"]')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('board-column-', '')),
      );
    expect(domColIds).toEqual(colIds);

    // Cards land in the right column…
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(todoCard.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${inProgCol.id}`).getByTestId(cardTid(inProgCard.identifier)),
    ).toBeVisible();

    // …and the per-column total-count badges match.
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('1');
    await expect(page.getByTestId(`board-count-${inProgCol.id}`)).toHaveText('1');
  });

  test('a legal cross-column drag applies the transition — the card lands, counts update, the new status persists', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'drag me forward');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const inProgCol = columnByStatus(board, 'in_progress'); // todo → in_progress is legal
    const card = todoCol.cards.find((c) => c.id === item.id)!;

    await openBoard(page);

    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(card.identifier)),
      page.getByTestId(`board-column-${inProgCol.id}`),
    );
    expect(res.status(), 'a legal move returns 200').toBe(200);

    // The card now lives in the In Progress column in the DOM…
    await expect(
      page.getByTestId(`board-column-${inProgCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toHaveCount(0);
    // …the optimistic counts reconciled (To Do 0, In Progress 1)…
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('0');
    await expect(page.getByTestId(`board-count-${inProgCol.id}`)).toHaveText('1');

    // …and the move persisted as a real workflow transition (re-fetch).
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'in_progress')).toEqual([item.id]);
    expect(cardIdsIn(after, 'todo')).not.toContain(item.id);
  });

  test('an illegal cross-column drag snaps the card back to its origin column — status unchanged', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'cannot reach review');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const inReviewCol = columnByStatus(board, 'in_review'); // todo → in_review has NO transition
    const card = todoCol.cards.find((c) => c.id === item.id)!;

    await openBoard(page);

    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(card.identifier)),
      page.getByTestId(`board-column-${inReviewCol.id}`),
    );
    expect(res.status(), 'an illegal move returns 409').toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');

    // The rejection is surfaced (a toast), and the card animates BACK to To Do —
    // it never rests in the In Review column it was dropped on.
    await expect(page.getByText('Move not allowed')).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${todoCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toBeVisible();
    await expect(
      page.getByTestId(`board-column-${inReviewCol.id}`).getByTestId(cardTid(card.identifier)),
    ).toHaveCount(0);
    await expect(page.getByTestId(`board-count-${todoCol.id}`)).toHaveText('1');
    await expect(page.getByTestId(`board-count-${inReviewCol.id}`)).toHaveText('0');

    // The status is untouched on re-fetch — the snap-back was visual only.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'todo')).toContain(item.id);
    expect(cardIdsIn(after, 'in_review')).not.toContain(item.id);
  });

  test('an in-column drag reorders rank only — no transition, and the order survives a reload', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const a = await createItem(page.request, projectId, 'card A'); // created first → ranks above
    const b = await createItem(page.request, projectId, 'card B');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    expect(cardIdsIn(board, 'todo')).toEqual([a.id, b.id]);
    const aCard = todoCol.cards.find((c) => c.id === a.id)!;
    const bCard = todoCol.cards.find((c) => c.id === b.id)!;

    await openBoard(page);

    // Drag A onto B's lower half → A drops AFTER B (rank change within To Do).
    const res = await pointerDrag(
      page,
      page.getByTestId(cardTid(aCard.identifier)),
      page.getByTestId(cardTid(bCard.identifier)),
      0.85,
    );
    expect(res.status(), 'an in-column reorder returns 200').toBe(200);
    const moved = (await res.json()) as { appliedStatus: string };
    expect(moved.appliedStatus, 'no transition on a rank-only move').toBe('todo');

    // Order flipped, both cards still in To Do (membership + status unchanged),
    // count unchanged.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'todo')).toEqual([b.id, a.id]);
    expect(columnByStatus(after, 'todo').totalCount).toBe(2);

    // And the new order is durable — it persisted server-side as a rank change.
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    const reloaded = await getBoard(page.request);
    expect(cardIdsIn(reloaded, 'todo')).toEqual([b.id, a.id]);
  });

  test('a card moves to another column using the keyboard alone (pick up · arrow · drop)', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);
    const item = await createItem(page.request, projectId, 'keyboard mover');

    const board = await getBoard(page.request);
    const todoCol = columnByStatus(board, 'todo');
    const card = todoCol.cards.find((c) => c.id === item.id)!;

    await openBoard(page);

    // Focus the card, pick it up (Space), move one column to the right (→ Blocked,
    // the next column; todo → blocked is a legal transition), and drop (Space) —
    // all with the keyboard, no pointer.
    await page.getByTestId(cardTid(card.identifier)).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    const move = page.waitForResponse(
      (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.keyboard.press('Space');
    const res = await move;
    expect(res.status(), 'the keyboard move is a legal transition (200)').toBe(200);

    // The move happened: the card left To Do via a real transition.
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'todo')).not.toContain(item.id);
    expect(after.columns.flatMap((c) => c.cards).map((c) => c.id)).toContain(item.id);
  });
});
