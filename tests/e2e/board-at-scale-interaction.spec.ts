// E2E: the CROSS-CUTTING board journey AT SCALE — the interaction half (Story
// 3.5 · Subtask 3.5.3). The combined drag + swimlane + WIP journey every
// per-surface board test explicitly defers here (3.2.7 / 3.3.7 / 4.5.4), run
// against the 3.5.1 board-shaped large seed so each interaction exercises a
// genuinely AT-SCALE board: tall virtualized columns, many populated lanes, the
// whole thing bounded with NO per-column "Load more" anywhere.
//
// Lives in its OWN file (the load-model half, 3.5.2, owns
// `board-at-scale.spec.ts`); both carry the `board-at-scale` describe tag, so
// 3.5.2's CI step (`pnpm test:e2e --grep "board-at-scale"`, run with the 3.5.1
// cap/Done-age seam `BOARD_ISSUE_CAP_OVERRIDE=40`) runs this spec too — which is
// why the seed below stays UNDER 40 cards (no truncation under the lane's cap).
// Splitting the file avoids two parallel subtasks colliding on one new path.
//
// Proves the 3.2/3.3 interaction contracts STILL HOLD on top of the 3.8 load
// model (bounded load + virtualization), which the single-surface 3.2.7 / 3.3.7
// specs cannot: those run on a 1–3 card board where nothing virtualizes. This
// spec owns the at-scale remainder only and does NOT re-prove the reducers /
// projection internals / single-surface journeys the owning stories already
// cover with a handful of rows.
//
// What is proven here, end-to-end through the real shell over real Postgres:
//   - DRAG-AS-TRANSITION DEEP IN A VIRTUALIZED COLUMN — a card scrolled into view
//     far below the initial row-window (so it was never in the first render) drags
//     to another column; the transition applies + reconciles (3.2.4/3.2.5/3.8.3:
//     the dragged card stays mounted through virtualization).
//   - ILLEGAL-MOVE SNAP-BACK (409) AT SCALE — an illegal cross-column move on a
//     deep card snaps back, status unchanged (the 3.1.5 IllegalBoardMoveError 409).
//   - SWIMLANES RE-LAY AT SCALE — group-by Assignee/Epic/Priority/None re-lays the
//     board into bounded, virtualized lanes + the catch-all (last), each with NO
//     "Load more" (3.8.5); a collapsed lane persists across a reload (3.3.5).
//   - CROSS-LANE REASSIGN + DIAGONAL — a cross-lane drag reassigns the grouped
//     field (status unchanged, the 2.5 field path); a diagonal drag (different
//     column AND lane) applies BOTH the transition and the reassign (3.3.5).
//   - WIP SOFT-WARNING IS ADVISORY — a column over its WIP limit shows the soft
//     `n/limit` warning yet still ACCEPTS a dropped card; an at-limit column is
//     not warned (3.3.6; the 3.2.4 move contract untouched).
//
// Setup follows board-load.spec.ts (3.8.6) + board-swimlanes.spec.ts (3.3.7): a
// browser sign-up (creator = workspace owner, finding #36), one server-seeded
// project pinned active, then the 3.5.1 `seedLargeBoard` board-shaped fixture so
// the board renders at real-team scale. A few DETERMINISTIC marker cards are added
// over the `_test` transport for the swimlane/WIP assertions that need a known
// (column, lane) placement — they live INSIDE the at-scale board (surrounded by
// the seed's dozens of cards), so the assertion still runs at scale; only the
// dragged card is pinned, not the scale. The board behaviour itself is driven
// through the real /boards UI.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import {
  getBoard,
  columnByStatus,
  cardIdsIn,
  columnCardNodes,
  expectColumnVirtualized,
  expectNoLoadMore,
} from './_helpers/board';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import { seedLargeBoard } from '../../scripts/seedLargeBoard';
import type { BoardProjectionDto } from '@/lib/dto/boards';

const OWNER_EMAIL = 'e2e-board-at-scale-owner@example.com';
// The catch-all swimlane key (BOARD_SWIMLANE_NO_VALUE) — the "No assignee" / "No
// epic" lane that always sorts last.
const CATCH_ALL = BOARD_SWIMLANE_NO_VALUE;

// A small-but-board-SHAPED distribution: ~34 cards spread across every column +
// assignee/epic/priority lane, with a tall `in_progress` column (24 extras) that
// virtualizes so a card can be dragged from DEEP below the initial window. The
// numbers stay tiny (fast per-card service-routed seed) AND deliberately UNDER
// the CI `board-at-scale` lane's `BOARD_ISSUE_CAP_OVERRIDE=40` (3.5.2's ci.yml
// step runs every `board-at-scale`-tagged spec with the 3.5.1 seam) — so the
// board is never truncated out from under the interaction assertions. The
// interaction journey needs virtualization + lanes + WIP, not the over-cap
// banner (that is 3.5.2's load-model concern), so this stays comfortably below
// the cap. Done-age spread is off — the Done-age window is also 3.5.2's concern.
const BOARD_OPTS = {
  epics: 2,
  storiesPerEpic: 3,
  rootStories: 2,
  tallColumnExtra: 24,
  unassignedEvery: 4,
  doneAgedOutEvery: 0,
};

interface Scale {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
  /** The assignee pool the seed round-robins across → the assignee lanes. */
  memberIds: string[];
}

// Sign up (the owner), add the one active project the board hangs off + pin it,
// mint a few workspace members for the assignee lanes, then lay down the 3.5.1
// board-shaped large fixture over it. Mirrors at-scale-fixture.test.ts's
// makeFixture, but the owner is a real signed-IN browser session so the journey
// drives the actual /boards surface.
async function seedBoardAtScale(
  page: Page,
  optsOverride: Partial<typeof BOARD_OPTS> = {},
  memberCount = 3,
): Promise<Scale> {
  await signUp(page, OWNER_EMAIL);
  const local = OWNER_EMAIL.split('@')[0]!;
  const owner = await db.user.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: owner.id,
    name: 'Board At-Scale Demo',
    identifier: 'BIG',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });

  // Members → one assignee lane each + the unassigned catch-all.
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const m = await usersService.createUser({
      email: `e2e-board-at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.id });
    memberIds.push(m.id);
  }

  await seedLargeBoard(
    {
      workspaceId: ws.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    { ...BOARD_OPTS, ...optsOverride },
  );

  return {
    ownerId: owner.id,
    workspaceId: ws.id,
    projectId: project.id,
    identifier: 'BIG',
    memberIds,
  };
}

// Open /boards at a viewport wide enough for all six default columns (6 × 18rem ≈
// 1728px) so a cross-column pointer drag never has to chase a horizontally-
// scrolling target. Waits past the loading skeleton (the at-scale set is heavy).
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
}

/** Create a To Do work item via the `_test` transport → its id. */
async function newItem(page: Page, projectId: string, title: string): Promise<string> {
  const { id } = await createItem(page.request, projectId, title);
  return id;
}

/** Assign a work item to a member via the `_test` free-form patch (E2E setup). */
async function assign(page: Page, id: string, assigneeId: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}`, { data: { assigneeId } });
  expect(res.ok(), `assign ${id} → ${assigneeId}`).toBeTruthy();
}

/** Resolve a card id → its board identifier (the `board-card-<identifier>` testid). */
function identifierOf(board: BoardProjectionDto, id: string): string {
  for (const col of board.columns) {
    const card = col.cards.find((c) => c.id === id);
    if (card) return card.identifier;
  }
  throw new Error(`card ${id} not found on the board`);
}

// The column's internal scroll viewport (the `.col-body` overflow-y-auto div in
// BoardColumn) — the element `useRowWindow` windows against. Setting its scrollTop
// fires the scroll event the hook listens to, so the window recomputes.
function columnScroller(page: Page, columnId: string): Locator {
  return page.getByTestId(`board-column-${columnId}`).locator('div.overflow-y-auto').first();
}

// Scroll a virtualized column far enough that a card NOT in its initial row-window
// mounts, and return that deep card's identifier. Proves the at-scale precondition
// the drag tests need: a card reachable only by scrolling (virtualization), not by
// paging. Asserts the column virtualized first (mounted ≪ total).
async function revealDeepCard(page: Page, columnId: string, total: number): Promise<string> {
  await expectColumnVirtualized(page, columnId, total);
  const nodes = columnCardNodes(page, columnId);
  const testidsOf = async () =>
    (await nodes.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).filter(
      Boolean,
    );
  const initial = new Set(await testidsOf());

  // Scroll roughly to the middle of the stack, then poll until a card that was NOT
  // in the initial window has mounted and laid out.
  const scroller = columnScroller(page, columnId);
  await scroller.evaluate((el) => {
    el.scrollTop = Math.floor(el.scrollHeight * 0.55);
  });

  let deepTestId = '';
  await expect
    .poll(
      async () => {
        const now = await testidsOf();
        const fresh = now.find((tid) => !initial.has(tid));
        if (fresh) deepTestId = fresh;
        return Boolean(fresh);
      },
      { message: 'a card below the initial window mounted after scrolling', timeout: 10_000 },
    )
    .toBe(true);

  const identifier = deepTestId.replace('board-card-', '');
  await expect(page.getByTestId(deepTestId)).toBeVisible();
  return identifier;
}

// A REAL pointer drag from one element onto another, clearing dnd-kit's 8px
// PointerSensor activation distance before settling over the target, then
// dropping. Returns the `/api/board/move` POST the drop fires so the caller can
// assert its status (200 legal · 409 illegal). `dropYFrac` places the drop within
// the target's height. Lifted from board-ui.spec.ts (3.2.7).
async function pointerDragForMove(
  page: Page,
  from: Locator,
  to: Locator,
  dropYFrac = 0.4,
): ReturnType<Page['waitForResponse']> {
  await from.scrollIntoViewIfNeeded();
  const f = (await from.boundingBox())!;
  await to.scrollIntoViewIfNeeded();
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * dropYFrac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 }); // clear the 8px activation
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 }); // settle so the over-target sticks
  const move = page.waitForResponse(
    (r) => r.url().endsWith('/api/board/move') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.mouse.up();
  return move;
}

// A real pointer drag from a board card onto a swimlane LANE CELL (the
// `lane-cell-<col>-<lane>` droppable that owns the reassign), mirroring the
// activation-distance gesture board-swimlanes.spec.ts uses; the caller polls
// committed state (a swimlane reassign goes through the field path, not
// /api/board/move, so there is no single response to await). Drops at the cell's
// CENTRE: the board resolves the over via dnd-kit `closestCenter`, which keys off
// the dragged card's centre, so a centre-on-cell drop pins the destination
// (lane, column) cell. Dropping onto a CARD inside another lane only re-sorts;
// the lane-cell droppable is what triggers the cross-lane reassign.
async function dragCardOntoCell(page: Page, cardTestId: string, target: Locator): Promise<void> {
  const card = page.getByTestId(cardTestId);
  // Settle BOTH into view BEFORE measuring — capturing the source box and THEN
  // scrolling the target would invalidate the source coords (the target scroll
  // shifts the page), so the pickup would grab whatever now sits at the stale
  // point. Source + target lanes are adjacent + short here, so both fit on screen.
  await card.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 24, fy, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 });
  await page.waitForTimeout(80); // let dnd-kit's onDragOver settle on the target cell
  await page.mouse.up();
}

/** The committed assignee of a card id (scans the projection); null if unassigned
 *  or the card is not found. A single read — the retry helper polls with it. */
function assigneeOf(board: BoardProjectionDto, id: string): string | null {
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === id);
  return card ? card.assigneeId : null;
}

// Drag a card onto a lane cell and RETRY until the committed projection satisfies
// `predicate`, or the attempts run out. dnd-kit pointer drags onto one of several
// vertically-stacked lane cells are pixel-sensitive — an occasional drop lands a
// lane off; re-dragging the same card (now wherever it landed) onto the target
// cell converges. Returns whether the predicate held. The reassign/transition is
// idempotent, so a repeat drop that already succeeded is a no-op.
async function dragIntoCellUntil(
  page: Page,
  srcCardKey: string,
  target: Locator,
  predicate: (board: BoardProjectionDto) => boolean,
  attempts = 4,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await dragCardOntoCell(page, `board-card-${srcCardKey}`, target);
    for (let poll = 0; poll < 10; poll++) {
      if (predicate(await getBoard(page.request))) return true;
      await page.waitForTimeout(100);
    }
  }
  return false;
}

// Pick the active group-by dimension via the board-header Segmented control,
// awaiting the PATCH so the server-side persistence has landed. From
// board-swimlanes.spec.ts (3.3.7).
async function setGroupBy(
  page: Page,
  label: 'None' | 'Assignee' | 'Epic' | 'Priority',
): Promise<void> {
  const control = page.getByRole('group', { name: 'Swimlane group by' });
  const patch = page.waitForResponse(
    (r) => r.url().endsWith('/api/board') && r.request().method() === 'PATCH',
  );
  await control.getByRole('button', { name: label, exact: true }).click();
  expect((await patch).ok(), `group-by → ${label} persisted`).toBeTruthy();
}

// Set a column's WIP limit through its [⋯] menu's "Set WIP limit" editor, awaiting
// the PATCH so the write has landed before asserting the over/at-limit treatment.
// From board-swimlanes.spec.ts (3.3.7).
async function setColumnWip(page: Page, columnId: string, value: string): Promise<void> {
  await page.getByTestId(`board-column-actions-${columnId}`).click();
  await page.getByRole('button', { name: 'Set WIP limit' }).click();
  await page.getByTestId(`board-wip-input-${columnId}`).fill(value);
  const patch = page.waitForResponse(
    (r) =>
      new RegExp(`/api/board/columns/${columnId}$`).test(r.url()) &&
      r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await patch).ok(), `set WIP ${value} on ${columnId} persisted`).toBeTruthy();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Each journey signs up (slow argon2), lays down the ~64-card board-shaped seed,
// cold-compiles the /boards + quick-view chunks, and runs a multi-step browser
// interaction — give them generous headroom over the 30s default.
test.describe.configure({ timeout: 120_000 });

test.describe('board-at-scale — interaction (3.5.3)', () => {
  test('a drag-as-transition on a card DEEP in a virtualized column applies and reconciles', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    const board = await getBoard(page.request);
    const inProg = columnByStatus(board, 'in_progress'); // the tall, virtualized column
    const inReview = columnByStatus(board, 'in_review'); // in_progress → in_review is legal
    expect(inProg.totalCount, 'the tall column is at scale').toBeGreaterThan(15);

    // A card reachable only by scrolling the virtualized column (never in the
    // initial render window), then drag it to the ADJACENT In Review column (a
    // legal transition). In Review is the column immediately right of In Progress,
    // so a pointer drop is unambiguous — and it proves the dragged card survives
    // virtualization (force-mounted through the drag, 3.2.5/3.8.3).
    const deepIdentifier = await revealDeepCard(page, inProg.id, inProg.totalCount);
    const deepId = inProg.cards.find((c) => c.identifier === deepIdentifier)!.id;

    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${deepIdentifier}`),
      page.getByTestId(`board-column-${inReview.id}`),
    );
    expect(res.status(), 'in_progress → in_review is a legal transition (200)').toBe(200);

    // The move reconciled to a real workflow transition: the deep card now lives in
    // In Review, gone from In Progress — proving the drag survived virtualization.
    await expect
      .poll(async () => cardIdsIn(await getBoard(page.request), 'in_review').includes(deepId), {
        message: 'the deep card transitioned to in_review',
        timeout: 10_000,
      })
      .toBe(true);
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'in_progress')).not.toContain(deepId);
    expect(columnByStatus(after, 'in_review').totalCount).toBe(inReview.totalCount + 1);
    expect(columnByStatus(after, 'in_progress').totalCount).toBe(inProg.totalCount - 1);
    void scale;
  });

  test('an illegal cross-column move snaps back (409) with status unchanged, at scale', async ({
    page,
  }) => {
    await seedBoardAtScale(page);
    await openBoard(page);

    const board = await getBoard(page.request);
    // Done → Cancelled has NO workflow transition, and Cancelled is the column
    // immediately RIGHT of Done — an ADJACENT illegal pair, so the pointer drop is
    // unambiguous (In Progress has no illegal neighbour: both Blocked and In Review
    // are legal from it, and a 2-column drag latches onto the legal column between).
    const doneCol = columnByStatus(board, 'done');
    const cancelledCol = columnByStatus(board, 'cancelled');
    const doomedId = doneCol.cards[0]?.id;
    const doomedKey = doneCol.cards[0]?.identifier;
    const cancelledTargetKey = cancelledCol.cards[0]?.identifier;
    expect(doomedKey, 'the Done column has a seeded card to drag').toBeTruthy();
    expect(cancelledTargetKey, 'the Cancelled column has a seeded card to drop onto').toBeTruthy();

    // Drop onto the Cancelled CARD (not the bare column droppable): a card target
    // registers the over-column reliably and pins the destination to Cancelled.
    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${doomedKey}`),
      page.getByTestId(`board-card-${cancelledTargetKey}`),
      0.5,
    );
    expect(res.status(), 'done → cancelled is illegal (409)').toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');

    // The rejection is surfaced (a toast) and the status is untouched on re-fetch —
    // the snap-back was visual only.
    await expect(page.getByText('Move not allowed', { exact: true })).toBeVisible();
    const after = await getBoard(page.request);
    expect(cardIdsIn(after, 'done')).toContain(doomedId);
    expect(cardIdsIn(after, 'cancelled')).not.toContain(doomedId);
  });

  test('group-by re-lays the board into bounded virtualized lanes + catch-all with NO "Load more"; a collapsed lane persists on reload', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    // Flat at scale: NO "Load more" anywhere (the retired cursor paging, 3.8.3).
    await expectNoLoadMore(page);

    // Group by Assignee → the board re-lays into one lane per assignee-with-cards
    // plus the "No assignee" catch-all (sorted LAST), still bounded with NO "Load
    // more" anywhere in the swimlane layout (3.8.5).
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    for (const memberId of scale.memberIds) {
      await expect(page.getByTestId(`swimlane-${memberId}`)).toBeVisible();
    }
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible();
    const laneHeadIds = await page
      .locator('[data-testid^="swimlane-head-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(laneHeadIds.at(-1), 'the catch-all lane sorts last').toBe(`swimlane-head-${CATCH_ALL}`);
    await expectNoLoadMore(page);

    // Epic / Priority / None all re-lay (server-side group-by) without a paging
    // affordance ever appearing.
    await setGroupBy(page, 'Epic');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(page.getByTestId(`swimlane-${CATCH_ALL}`)).toBeVisible(); // epics + root stories have no epic ancestor
    await expectNoLoadMore(page);
    await setGroupBy(page, 'Priority');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expectNoLoadMore(page);
    await setGroupBy(page, 'None');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('swimlane-board')).toHaveCount(0);

    // Collapse a populated lane under Assignee → its cells unmount, the header +
    // aggregate count stay, and the collapse persists across a reload.
    await setGroupBy(page, 'Assignee');
    const laneKey = scale.memberIds[0]!;
    const head = page.getByTestId(`swimlane-head-${laneKey}`);
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`swimlane-count-${laneKey}`)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('swimlane-board')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`swimlane-head-${laneKey}`)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('a cross-lane drag reassigns the grouped field (status unchanged); a diagonal drag applies both writes', async ({
    page,
  }) => {
    // A SHORTER tall column for the swimlane scenario: the at-scale concern for a
    // cross-lane DRAG is many populated lanes, not column height. A tall in_progress
    // cell would make each lane band hundreds of px tall, so the source lane and the
    // target lane could not both fit on screen — scrolling the target into view would
    // push the source off the top and the pickup would miss it. With a short column
    // every lane band fits, so a centre-on-cell drop lands deterministically. (The
    // tall-column virtualization scale is owned by the transition + WIP tests above.)
    // TWO members (→ m0, m1 + the catch-all = three lanes only): the fewer the
    // vertically-stacked lanes, the less a pixel-precise drop can land a lane off.
    const scale = await seedBoardAtScale(page, { tallColumnExtra: 6 }, 2);
    const [m0, m1] = scale.memberIds;

    // Deterministic marker cards placed INSIDE the at-scale board, so the (column,
    // lane) source/target slots are known and the target cells are non-empty (a
    // drop onto an empty placeholder is the finicky case — board-swimlanes #61):
    //   cross-lane:  crossSrc in (To Do, m0)         → drop on the (To Do, m1) cell
    //                crossAnchor in (To Do, m1)       keeps that target cell non-empty
    //   diagonal:    diagSrc in (To Do, m0)          → drop on the (In Progress, m1) cell
    //                diagAnchor in (In Progress, m1)  keeps that target cell non-empty
    // Both sources sit in the short To Do column (an easy drag origin); the scale is
    // supplied by the seed cards filling every other column + lane.
    const crossSrc = await newItem(page, scale.projectId, 'cross-lane source');
    const crossAnchor = await newItem(page, scale.projectId, 'cross-lane target anchor');
    const diagSrc = await newItem(page, scale.projectId, 'diagonal source');
    const diagAnchor = await newItem(page, scale.projectId, 'diagonal target anchor');
    expect((await transition(page.request, diagAnchor, 'in_progress')).status()).toBe(200);
    await assign(page, crossSrc, m0!);
    await assign(page, crossAnchor, m1!);
    await assign(page, diagSrc, m0!);
    await assign(page, diagAnchor, m1!);

    await openBoard(page);
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    const board0 = await getBoard(page.request);
    const todoColId = columnByStatus(board0, 'todo').id;
    const inProgColId = columnByStatus(board0, 'in_progress').id;
    const crossSrcKey = identifierOf(board0, crossSrc);
    const diagSrcKey = identifierOf(board0, diagSrc);

    // CROSS-LANE: drag crossSrc from the m0 lane into the m1 lane's To Do cell →
    // the assignee flips to m1, the status (column membership) stays To Do. The
    // m1 cell is kept non-empty by `crossAnchor` (a drop onto a bare placeholder is
    // the finicky case — board-swimlanes #61). Retried to absorb pointer-drag jitter.
    const crossOk = await dragIntoCellUntil(
      page,
      crossSrcKey,
      page.getByTestId(`lane-cell-${todoColId}-${m1}`),
      (b) => assigneeOf(b, crossSrc) === m1 && cardIdsIn(b, 'todo').includes(crossSrc),
    );
    expect(crossOk, 'cross-lane reassigned crossSrc to m1 with the status unchanged (To Do)').toBe(
      true,
    );

    // DIAGONAL: drag diagSrc from (To Do, m0) into the (In Progress, m1) cell →
    // BOTH writes apply: the transition (todo → in_progress) AND the reassign
    // (m0 → m1), each reconciled independently (3.3.5). `diagAnchor` keeps the
    // target cell non-empty.
    const diagOk = await dragIntoCellUntil(
      page,
      diagSrcKey,
      page.getByTestId(`lane-cell-${inProgColId}-${m1}`),
      (b) => cardIdsIn(b, 'in_progress').includes(diagSrc) && assigneeOf(b, diagSrc) === m1,
    );
    expect(diagOk, 'diagonal drag moved diagSrc to In Progress AND reassigned it to m1').toBe(true);
  });

  test('a WIP-over-limit column shows the soft warning yet still ACCEPTS a drop; an at-limit column is not warned', async ({
    page,
  }) => {
    const scale = await seedBoardAtScale(page);
    await openBoard(page);

    const board0 = await getBoard(page.request);
    const inProg = columnByStatus(board0, 'in_progress'); // the tall column, at scale
    const n = inProg.totalCount;
    expect(n, 'the WIP column is at scale').toBeGreaterThan(15);
    const wipBadge = page.getByTestId(`board-wip-${inProg.id}`);

    // AT the limit (n/n) is NOT warned (the predicate is strictly greater).
    await setColumnWip(page, inProg.id, String(n));
    await expect(wipBadge).toBeVisible();
    await expect(wipBadge).not.toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n}/${n}`);

    // One under (limit n-1) → the SOFT over-limit warning shows (n/(n-1) + icon).
    await setColumnWip(page, inProg.id, String(n - 1));
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n}/${n - 1}`);

    // SOFT, not blocking: drag a To Do card into the over-limit In Progress column
    // (todo → in_progress legal) → the move is ACCEPTED (200), the card lands, the
    // count climbs to n+1, and the warning persists. The 3.2.4 move contract is
    // untouched by the WIP limit.
    const todoCardId = cardIdsIn(board0, 'todo')[0]!;
    const todoCardKey = identifierOf(board0, todoCardId);
    const res = await pointerDragForMove(
      page,
      page.getByTestId(`board-card-${todoCardKey}`),
      page.getByTestId(`board-column-${inProg.id}`),
    );
    expect(res.status(), 'the soft over-limit drop is accepted, never blocked').toBe(200);
    await expect
      .poll(async () => columnByStatus(await getBoard(page.request), 'in_progress').totalCount, {
        message: 'the dragged card landed in the over-limit column (soft)',
        timeout: 10_000,
      })
      .toBe(n + 1);
    await expect(wipBadge).toHaveAttribute('data-over', 'true');
    await expect(wipBadge).toContainText(`${n + 1}/${n - 1}`);
    void scale;
  });
});
