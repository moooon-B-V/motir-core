// E2E: the cross-cutting board journey AT SCALE (Story 3.5) — the combined
// load → virtualize → interact journey every per-story board test defers here.
//
// THIS FILE hosts TWO describe blocks, one per Story-3.5 subtask, both selected
// by the `board-at-scale` grep (the verification recipe runs
// `pnpm test:e2e --grep board-at-scale`):
//
//   • `board-at-scale — load model (3.5.2)`  ← THIS subtask (below)
//       the Story-3.8 load model proven at scale: bounded whole-set load with NO
//       per-column "Load more", virtualization keeping the DOM bounded, the
//       over-cap "refine your filter" banner past the cap (flat AND swimlane),
//       and the age-based Done-age window — never the retired cursor paging.
//   • `board-at-scale — interaction (3.5.3)` ← the SIBLING subtask, appended to
//       this file by Subtask 3.5.3 (drag-as-transition · snap-back · swimlanes ·
//       cross-lane reassign · WIP). Keep the two describes independent: each
//       owns its own seeded tenant + helpers so neither block depends on the
//       other's setup.  (3.5.3 was already flipped in_progress in a parallel
//       session; this block is written to coexist with its append.)
//
// ── How this spec reaches the at-scale states cheaply (the 3.5.1 harness) ─────
// The load model only shows its over-cap banner past `BOARD_ISSUE_CAP` (5,000)
// and only trims the Done column past `DONE_AGE_WINDOW_DAYS` (14). Subtask 3.5.1
// shipped a TEST SEAM so both are reachable with TENS of rows instead of
// thousands: `boardsService.resolve{BoardIssueCap,DoneAgeWindowDays}` read the
// `BOARD_ISSUE_CAP_OVERRIDE` / `DONE_AGE_WINDOW_DAYS_OVERRIDE` envs when set
// (else the shipped constants), and `playwright.config.ts` forwards those envs
// to the dev server ONLY when the run sets them. So this spec REQUIRES the seam
// to be configured (see the beforeAll guard) — it is excluded from the default
// `pnpm test:e2e` run and gets a dedicated, seam-configured CI step. 3.8.6
// (`board-load.spec.ts`) already proves the load model end-to-enough with a
// handful of rows + the default cap; this spec proves the SAME shape holds on
// the board-shaped large seed (3.5.1) — the 5,000-card render 3.8.6 deferred
// here — so it does NOT re-assert 3.8.6's unit-level predicates.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  getBoard,
  columnByStatus,
  columnCardNodes,
  columnTotalBadge,
  expectColumnVirtualized,
  expectNoLoadMore,
  overCapBanner,
  gotoLoadedBoard,
  signInBoardSeedOwnerAndOpenBoard,
} from './_helpers/board';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  seedLargeBoard,
  SEED_LARGE_OWNER_EMAIL,
  SEED_LARGE_OWNER_PASSWORD,
  type SeedLargeBoardManifest,
} from '../../scripts/seedLargeBoard';

// The board-shaped seed loads tens of cards over real HTTP and renders them
// (virtualized) — generous headroom for the seed in beforeAll + the per-test
// loads, well above the 30s default.
test.describe.configure({ timeout: 120_000 });

// ── The 3.5.1 cap/Done-age test seam — REQUIRED for this spec ────────────────
// Read the same envs `playwright.config.ts` forwards to the dev server, so the
// spec and the server agree on the in-effect cap/window. The spec is meaningless
// without them (it could not reach the over-cap state cheaply), so it fails LOUD
// rather than silently passing — it is excluded from the default e2e run and
// invoked by its own seam-configured step (`pnpm test:e2e --grep board-at-scale`
// with BOARD_ISSUE_CAP_OVERRIDE / DONE_AGE_WINDOW_DAYS_OVERRIDE set).
function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : null;
}
const CAP = positiveIntEnv('BOARD_ISSUE_CAP_OVERRIDE');
const WINDOW_DAYS = positiveIntEnv('DONE_AGE_WINDOW_DAYS_OVERRIDE');

// The board-shaped seed sizing. Chosen so — under the lowered cap the run sets —
// the board is comfortably OVER the cap (banner shows) while staying tens of
// rows: one tall column far past the row window (virtualization), a Done-age
// spread (~half the terminal cards backdated outside the window), and enough
// spread for every column + assignee/epic/priority lane to be populated.
const SEED_OPTS = {
  epics: 3,
  storiesPerEpic: 6,
  rootStories: 12,
  tallColumnExtra: 60,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
};
// epics + epics*stories + rootStories + tallExtra = 3 + 18 + 12 + 60 = 93.
const SEEDED_TOTAL =
  SEED_OPTS.epics * (1 + SEED_OPTS.storiesPerEpic) +
  SEED_OPTS.rootStories +
  SEED_OPTS.tallColumnExtra;

interface BigSeed {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  manifest: SeedLargeBoardManifest;
}

// Recreate the `db:seed:large` board-shaped tenant (the same owner the 3.5.1
// helper signs in as) at TEST scale, through the shipped services — the
// `seedLargeBoard` fixture is built to run against a small tenant exactly so a
// test can drive it. Pins the owner's active project so the active-project-scoped
// `/boards` route resolves it. Returns the manifest so assertions read the
// distribution instead of re-deriving it.
async function seedBigBoard(): Promise<BigSeed> {
  const owner = await usersService.createUser({
    email: SEED_LARGE_OWNER_EMAIL,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Board Seed Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Board at scale WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Board at scale',
    identifier: 'BIG',
  });
  // Six members for the assignee lanes (one bucket left unassigned by the seed).
  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await usersService.createUser({
      email: `board-at-scale-m${i}@example.com`,
      password: SEED_LARGE_OWNER_PASSWORD,
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: workspace.id });
    memberIds.push(m.id);
  }
  const manifest = await seedLargeBoard(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    SEED_OPTS,
  );
  // Pin the BIG project active so /boards resolves it on every render.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ownerId: owner.id, workspaceId: workspace.id, projectId: project.id, manifest };
}

// A second, tiny tenant whose board is comfortably UNDER the cap — the
// "banner absent" case. A separate owner keeps it fully isolated from the BIG
// seed (no active-project juggling on the BIG owner that a later test could see).
interface SmallSeed {
  email: string;
  projectId: string;
  workspaceId: string;
}
async function seedSmallBoard(): Promise<SmallSeed> {
  const email = 'board-at-scale-undercap@example.com';
  const owner = await usersService.createUser({
    email,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Under-cap Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Under-cap WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Under cap',
    identifier: 'SML',
  });
  // A few task cards in the first status — well under any sane lowered cap.
  const statuses = await workflowsService.listStatusesByProject(project.id, workspace.id);
  const firstKey = [...statuses].sort((a, b) => a.position.localeCompare(b.position))[0]!.key;
  await db.workItem.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task' as const,
      key: i + 1,
      identifier: `SML-${i + 1}`,
      title: `Small ${i + 1}`,
      status: firstKey,
      reporterId: owner.id,
      position: `p${String(i + 1).padStart(7, '0')}`,
    })),
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { email, projectId: project.id, workspaceId: workspace.id };
}

// Switch the active swimlane group-by via the board-header Segmented control,
// waiting for the PATCH /api/board that persists it. Mirrors board-swimlanes.spec.ts.
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

// The terminal (category `done`) columns of the BIG board, paired with each
// column's cards partitioned by the Done-age cutoff (from the configured window)
// — so the spec asserts the EXACT aged-out cards are absent and in-window cards
// present, rather than a blanket count.
async function terminalColumnsWithAge(big: BigSeed) {
  const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
  const terminalKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const cutoff = new Date(Date.now() - WINDOW_DAYS! * 24 * 60 * 60 * 1000);
  const out: Array<{ statusKey: string; agedOut: string[]; inWindow: string[]; total: number }> =
    [];
  for (const statusKey of terminalKeys) {
    const rows = await db.workItem.findMany({
      where: { projectId: big.projectId, status: statusKey },
      select: { identifier: true, updatedAt: true },
    });
    out.push({
      statusKey,
      agedOut: rows.filter((r) => r.updatedAt < cutoff).map((r) => r.identifier),
      inWindow: rows.filter((r) => r.updatedAt >= cutoff).map((r) => r.identifier),
      total: rows.length,
    });
  }
  return out;
}

let big: BigSeed;
let small: SmallSeed;

test.beforeAll(async () => {
  // The spec structurally requires the 3.5.1 cap/Done-age seam (it can't reach
  // the over-cap state with tens of rows otherwise). When it's unset — e.g. a
  // plain local `pnpm test:e2e` — SKIP the whole block visibly rather than fail:
  // CI excludes it from the default run (`--grep-invert`) and runs it in its own
  // seam-configured step, so the real coverage is never silently dropped.
  test.skip(
    CAP === null || WINDOW_DAYS === null,
    'board-at-scale needs the 3.5.1 seam — run `BOARD_ISSUE_CAP_OVERRIDE=40 ' +
      'DONE_AGE_WINDOW_DAYS_OVERRIDE=7 pnpm test:e2e --grep board-at-scale` (or the dedicated CI step).',
  );
  // A set-but-too-high cap is an explicit misconfiguration of THIS run — fail loud.
  if (SEEDED_TOTAL <= CAP!) {
    throw new Error(
      `board-at-scale: the seeded board total (${SEEDED_TOTAL}) must EXCEED the lowered cap ` +
        `(BOARD_ISSUE_CAP_OVERRIDE=${CAP}) so the over-cap banner shows. Lower the cap override.`,
    );
  }
  await resetDatabase();
  big = await seedBigBoard();
  small = await seedSmallBoard();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('board-at-scale — load model (3.5.2)', () => {
  test('loads the whole bounded set with NO "Load more"; every column badge shows its full total', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);

    // The retired 3.8.3 per-column cursor paging is gone: no "Load more" button
    // and no scroll-sentinel footer anywhere on the flat board.
    await expectNoLoadMore(page);

    // Each column's count badge is its FULL totalCount (the denominator is the
    // whole set, not the loaded window), and cards actually render.
    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated`).toBeGreaterThan(0);
      expect(await columnTotalBadge(page, col.id), `badge for ${col.name}`).toBe(col.totalCount);
    }
    const anyCol = board.columns.find((c) => c.totalCount > 0)!;
    await expect(columnCardNodes(page, anyCol.id).first()).toBeVisible();
  });

  test('virtualizes a tall column — bounded DOM, later cards reachable by scrolling not paging', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);

    // The seed's tall column (most cards), far past the row window.
    const tall = columnByStatus(board, big.manifest.tallStatusKey);
    expect(tall.totalCount, 'tall column is the largest').toBe(
      Math.max(...board.columns.map((c) => c.totalCount)),
    );

    // DOM-bounded: mounted card nodes are > 0 but well below the full total —
    // it windowed (`useRowWindow`) rather than mounting every row.
    await expectColumnVirtualized(page, tall.id, tall.totalCount);

    // A card deep in the loaded set is NOT mounted initially, then becomes
    // reachable by SCROLLING the column body (not by a paging affordance).
    const lastLoaded = tall.cards.at(-1)!.identifier;
    const lastCard = page.getByTestId(`board-card-${lastLoaded}`);
    await expect(lastCard).toHaveCount(0); // virtualized out of the initial window
    const body = page.getByTestId(`board-column-${tall.id}`).locator('.overflow-y-auto');
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(lastCard).toBeVisible(); // mounted by scrolling, not paging

    // Still bounded after scrolling (it did not load-all), and still no "Load more".
    expect(await columnCardNodes(page, tall.id).count()).toBeLessThan(tall.totalCount);
    await expectNoLoadMore(page);
  });

  test('shows the over-cap "refine your filter" banner past the cap — flat AND swimlane', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);

    // Sanity: the seam put the seeded board over the (lowered) cap.
    expect(board.cap, 'projection echoes the lowered cap').toBe(CAP);
    expect(board.truncated, 'board total exceeds the cap → truncated').toBe(true);

    // Flat board: the banner shows above it, names the cap, pairs hue with the
    // alert-triangle icon + copy (not colour-alone, finding #35), role=status.
    const banner = overCapBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toContainText(String(CAP)); // copy names the cap number
    await expect(banner.locator('svg').first()).toBeVisible(); // the AlertTriangle, not colour-alone

    // Swimlane layout (group-by Assignee): the banner is mounted above BOTH
    // layouts (3.8.4 — it lives in BoardContainer), so it stays visible.
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(overCapBanner(page)).toBeVisible();
    await expectNoLoadMore(page); // no per-lane "Load more" either (3.8.5)
  });

  test('the over-cap banner "Refine filter" CTA opens the board filter (Story 6.15.3/6.15.4)', async ({
    page,
  }) => {
    // The over-cap board is the only real surface where the banner renders, so
    // its "Refine filter" CTA → board-filter-popover wiring (6.15.3) is proven
    // here, over the real stack. (The CTA→onRefine→context-open seam is unit-
    // tested in tests/components/board-filter.test.tsx; this is the composition.)
    await signInBoardSeedOwnerAndOpenBoard(page);
    await expect(overCapBanner(page)).toBeVisible();

    // Closed: the quick-filter popover's facet listboxes are not mounted.
    await expect(page.getByRole('listbox', { name: 'Kind' })).toHaveCount(0);

    // Click the banner CTA — it opens the board's quick [Filter] popover through
    // BoardFilterUiContext (the seam was dead before 6.15.3).
    await page.getByTestId('board-overcap-filter').click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('listbox', { name: 'Work type' })).toBeVisible();
  });

  test('hides the over-cap banner on an under-cap board (flat AND swimlane)', async ({ page }) => {
    // The small tenant's board is well under the cap → truncated false → no banner.
    await signIn(page, small.email, SEED_LARGE_OWNER_PASSWORD);
    await gotoLoadedBoard(page);
    const board = await getBoard(page.request);
    expect(board.truncated, 'under-cap board is not truncated').toBe(false);
    await expect(overCapBanner(page)).toHaveCount(0);

    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(overCapBanner(page)).toHaveCount(0);
  });

  test('windows the Done column to the recent set — old resolved items absent, full count on the badge', async ({
    page,
  }) => {
    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);
    const terminals = await terminalColumnsWithAge(big);

    // Seed sanity: the Done-age spread actually produced both buckets, so the
    // assertion below is meaningful (some trimmed, some kept).
    const totalAgedOut = terminals.reduce((n, t) => n + t.agedOut.length, 0);
    const totalInWindow = terminals.reduce((n, t) => n + t.inWindow.length, 0);
    expect(totalAgedOut, 'some terminal cards aged out of the window').toBeGreaterThan(0);
    expect(totalInWindow, 'some terminal cards inside the window').toBeGreaterThan(0);

    for (const term of terminals) {
      const col = columnByStatus(board, term.statusKey);

      // The count badge shows the FULL terminal total (incl. the aged-out ones)…
      expect(await columnTotalBadge(page, col.id), `badge for ${term.statusKey}`).toBe(
        col.totalCount,
      );
      expect(col.totalCount).toBe(term.total);

      // …but every card resolved OUTSIDE the window is windowed out of the DOM…
      for (const id of term.agedOut) {
        await expect(page.getByTestId(`board-card-${id}`), `aged-out ${id} absent`).toHaveCount(0);
      }
      // …while recently-resolved cards are loaded + rendered. The column is short
      // (terminal cards are not the tall column), so no virtualization hides them:
      // their absence above is AGE-based, not a count cap (a count cap would keep
      // the most-recent-by-position N regardless of resolved age).
      for (const id of term.inWindow) {
        await expect(page.getByTestId(`board-card-${id}`), `in-window ${id} present`).toBeVisible();
      }
    }
  });

  test('never calls the retired per-column cursor / "Load more" route', async ({ page }) => {
    const offending: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      // The retired 3.8.3 affordance was GET /api/board/columns/[id]/cards (+ a
      // ?cursor= page token). The board read is now a single GET /api/board.
      if (/\/api\/board\/columns\/[^/?]+\/cards/.test(url) || url.includes('cursor=')) {
        offending.push(`${r.method()} ${url}`);
      }
    });

    await signInBoardSeedOwnerAndOpenBoard(page);
    const board = await getBoard(page.request);

    // Exercise the surfaces that historically would have paged: scroll the tall
    // column and switch into the swimlane layout.
    const tall = columnByStatus(board, big.manifest.tallStatusKey);
    await page
      .getByTestId(`board-column-${tall.id}`)
      .locator('.overflow-y-auto')
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();

    expect(offending, 'no retired cursor/Load-more route calls').toEqual([]);
  });
});
