// E2E: the board LOAD MODEL — the Jira-faithful correction Story 3.8 ships
// (Subtask 3.8.6, the Story closer). Drives the REAL stack (Next + Postgres)
// through the /boards surface and proves, end-to-end, the renderable behaviours
// the corrected load model guarantees (notes.html mistake #33). Three are proven
// here as browser E2E (1, 2, 4); the fourth — the over-cap banner — is proven at
// the cheaper unit/component tier instead (see the NOTE at the foot for why):
//
//   1. NO per-column "Load more" — the board renders the WHOLE bounded set the
//      3.8.2 projection returns (Jira never pages a board); the only affordance
//      is the column's own scroll.
//   2. A tall column stays DOM-bounded — virtualization (the 2.5.15
//      `useRowWindow`, kept) mounts only the cards in/near the scroll viewport,
//      so a 200-card column never mounts 200 nodes.
//   3. The over-cap "refine the filter" banner (3.8.4) renders when the board
//      exceeds `BOARD_ISSUE_CAP` (the mirror of Jira's "maximum number of
//      viewable issues exceeded" warning) and is ABSENT on a normal-sized board.
//   4. The Done-age window (3.8.2) — a terminal column loads only recently-
//      resolved issues (~14 days), the full count still surfaced; older done
//      items are not loaded.
//
// Setup mirrors board-config.spec.ts (3.6.4): sign up through the real UI, then
// seed the project + work items SERVER-SIDE — projectsService for the project
// (the one sanctioned cross-layer reach for E2E setup) and a fast bulk
// `createMany` for the at-scale card sets (the same shape projection.test.ts's
// `bulkCards` uses; the projection grouping/terminal-window/RLS internals are
// covered by the 3.8.2 Vitest suite against a real DB, so this spec inserts
// rows directly to reach scale cheaply and asserts only the cross-cutting
// end-to-end journey). The combined at-scale journey stays in Story 3.5; this
// file owns the board LOAD-MODEL coverage and supersedes the retired per-column
// "Load more"/cursor assertions (none remain — 3.8.3/3.8.5 removed the
// affordance, board-column.test.tsx asserts its absence at the unit level).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus } from './_helpers/board';
import { projectsService } from '@/lib/services/projectsService';
import { DONE_AGE_WINDOW_DAYS } from '@/lib/services/boardsService';

// The over-cap case loads the full cap (5,000) over real HTTP + renders it
// (virtualized), so give the suite generous headroom.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  userId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
}

// Sign-up auto-creates `<local>'s Workspace`; add the one project the board
// hangs off and pin it active so the active-project-scoped /boards route
// resolves it on every render. Mirrors board-config.spec.ts's seedActiveProject.
async function seedActiveProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const ws = await db.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Board Load Demo',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user.id, workspaceId: ws.id, projectId: project.id, identifier };
}

// Bulk-insert `count` task cards directly in `status` (one INSERT) — the fast
// fixture for the scale assertions, keyed from `startKey` so successive calls
// don't collide. Returns the inserted identifiers in insertion (position) order.
async function bulkSeed(
  seed: Seed,
  status: string,
  count: number,
  startKey = 1,
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => {
    const key = startKey + i;
    return {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      kind: 'task' as const,
      key,
      identifier: `${seed.identifier}-${key}`,
      title: `Card ${key}`,
      status,
      reporterId: seed.userId,
      position: `p${String(key).padStart(7, '0')}`,
    };
  });
  await db.workItem.createMany({ data: rows });
  return rows.map((r) => r.identifier);
}

// The board container testid flips from `board-skeleton` to `board` once the
// projection fetch resolves; waiting on it means "the board has loaded". The
// over-cap case ships the full cap (5,000 cards) over the wire, so its load is
// inherently heavier — callers pass a larger budget for it.
async function gotoLoadedBoard(page: Page, loadTimeout = 30_000): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: loadTimeout });
}

test.describe('board-load @smoke', () => {
  test('renders the whole bounded set with NO "Load more", and no over-cap banner on a normal board', async ({
    page,
  }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-normal@example.com', 'BLN');
    // A column comfortably past the OLD 50-card per-column page, plus a couple of
    // other columns — the whole set must load with no paging affordance.
    await bulkSeed(seed, 'todo', 64, 1);
    await bulkSeed(seed, 'in_progress', 4, 1001);

    await gotoLoadedBoard(page);

    // (1) NO "Load more" anywhere — neither a button nor a footer/sentinel.
    await expect(page.getByText(/load more/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);

    // (3-absent) A normal-sized board is NOT truncated → no over-cap banner.
    await expect(page.getByTestId('board-overcap-banner')).toHaveCount(0);

    // The per-column count badge shows the full total, and cards actually render.
    const board = await getBoard(page.request);
    const todo = columnByStatus(board, 'todo');
    expect(todo.totalCount).toBe(64);
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText('64');
    const todoCol = page.getByTestId(`board-column-${todo.id}`);
    await expect(todoCol.locator('[data-testid^="board-card-"]').first()).toBeVisible();
  });

  test('keeps a tall column DOM-bounded — virtualized, not every card mounted', async ({
    page,
  }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-tall@example.com', 'BLT');
    const TALL = 200;
    await bulkSeed(seed, 'todo', TALL, 1);

    await gotoLoadedBoard(page);

    const board = await getBoard(page.request);
    const todo = columnByStatus(board, 'todo');
    expect(todo.totalCount).toBe(TALL);
    // The header denominator is the FULL count...
    await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText(String(TALL));

    // ...but the column windows: only the cards in/near the scroll viewport
    // mount, so the mounted node count is far below the full set (DOM-bounded).
    const todoCol = page.getByTestId(`board-column-${todo.id}`);
    const mounted = todoCol.locator('[data-testid^="board-card-"]');
    await expect(mounted.first()).toBeVisible();
    const mountedCount = await mounted.count();
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThan(TALL); // virtualized — not all 200 mount
    expect(mountedCount).toBeLessThan(80); // and genuinely DOM-bounded, not "most"
  });

  test('windows a Done column to the recent set — old done items are not loaded, full count kept', async ({
    page,
  }) => {
    const seed = await seedActiveProject(page, 'e2e-board-load-doneage@example.com', 'BLD');
    const [recentId, oldId] = await bulkSeed(seed, 'done', 2, 1);
    // Backdate the OLD done card past the ~14-day window. `updatedAt` is
    // @updatedAt (auto-managed), so it can only be moved via raw SQL — the same
    // technique projection.test.ts's Done-age case uses.
    await db.$executeRaw`
      UPDATE "work_item"
         SET "updatedAt" = now() - (${DONE_AGE_WINDOW_DAYS + 6} || ' days')::interval
       WHERE "identifier" = ${oldId!} AND "projectId" = ${seed.projectId}`;

    await gotoLoadedBoard(page);

    const board = await getBoard(page.request);
    const done = columnByStatus(board, 'done');
    const doneCol = page.getByTestId(`board-column-${done.id}`);
    // The recent done card is loaded + rendered...
    await expect(doneCol.getByTestId(`board-card-${recentId}`)).toBeVisible();
    // ...the old one is windowed OUT (not in the DOM at all)...
    await expect(page.getByTestId(`board-card-${oldId}`)).toHaveCount(0);
    // ...but the header count still surfaces the FULL, unwindowed denominator.
    expect(done.totalCount).toBe(2);
    await expect(page.getByTestId(`board-count-${done.id}`)).toHaveText('2');
  });

  // NOTE — the over-cap "refine the filter" banner (behaviour 3) is deliberately
  // NOT re-proven here as a browser E2E. Triggering it through the real stack
  // requires a board PAST the cap (BOARD_ISSUE_CAP = 5,000), and the projection
  // then loads the full cap; rendering 5,000 cards through the dev server is the
  // heavy "combined at-scale journey" Story 3.5 owns, not a robust per-PR check
  // (it cannot complete within a sane E2E budget). The banner's correctness is
  // already proven, end-to-enough, at the two cheaper non-flaky tiers:
  //   • the PREDICATE (projection sets `truncated` exactly when board total >
  //     cap, false under it, full count still surfaced) — tests/boards/
  //     projection.test.ts, against real Postgres with BOARD_ISSUE_CAP + 1 rows;
  //   • the BANNER (renders iff `truncated`, names the cap, sits above BOTH the
  //     flat and swimlane layouts, disabled Epic-6 filter seam) — tests/
  //     components/board-completeness.test.tsx.
  // So behaviour 3 is covered; only its 5,000-card browser render is left to 3.5.
});
