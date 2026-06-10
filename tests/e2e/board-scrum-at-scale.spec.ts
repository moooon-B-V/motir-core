// E2E: the cross-cutting SCRUM journey AT SCALE (Story 4.7) — the combined
// sprint-scoped load → virtualize → interact → complete journey every per-story
// Epic-4 test defers here. The Scrum analogue of board-at-scale.spec.ts (3.5).
//
// THIS FILE hosts the describe blocks for Story 4.7's journey subtasks, all
// selected by the `board-scrum-at-scale` grep (the verification recipe runs
// `pnpm test:e2e --grep board-scrum-at-scale`):
//
//   • `board-scrum-at-scale — load model + scope + header (4.7.2)` ← THIS
//       subtask (below): the Story-3.8 load model proven on the SCRUM board,
//       scoped to the active sprint — sprint scope at scale (the backlog slice
//       absent), bounded whole-set load with NO per-column "Load more" (flat AND
//       swimlane), virtualization keeping the DOM bounded, the over-cap "refine
//       your filter" banner past the cap, the age-based Done-age window, the
//       sprint header's aggregate (never page-sum) points, and the
//       no-active-sprint empty state — never the retired cursor paging.
//   • `board-scrum-at-scale — interaction + complete (4.7.3)` ← the SIBLING
//       subtask (drag-as-transition · snap-back · swimlanes · cross-lane
//       reassign · WIP · complete-sprint carry-over + report), appended later.
//       Keep the describes independent: each owns its seeded tenants so neither
//       depends on the other's setup.
//
// What this spec does NOT re-test (the deferral boundary): the sprint-scope
// projection units + the small-scale scrum surface (4.5.4 / 4.5.2's own tests),
// the sprint state machine + the focused lifecycle E2E (4.4.7), the roll-up
// math (4.3.7), and the KANBAN at-scale journey (3.5.2 — board-at-scale.spec.ts,
// whose load-model predicates this file re-asserts only in their sprint-scoped
// form, because the sprint scope is exactly what 3.5.2 cannot cover).
//
// ── How this spec reaches the at-scale states cheaply (the 4.7.1 harness) ─────
// The load model only shows its over-cap banner past `BOARD_ISSUE_CAP` (5,000)
// and only trims the Done column past `DONE_AGE_WINDOW_DAYS` (14). Subtask 4.7.1
// REUSES the 3.5.1 test seam (`BOARD_ISSUE_CAP_OVERRIDE` /
// `DONE_AGE_WINDOW_DAYS_OVERRIDE`, forwarded to the dev server by
// playwright.config.ts) — the scrum board is the SAME `getBoard` the seam
// governs, scoped to the sprint — and ships the SPRINT-shaped large seed
// (`seedLargeScrumSprint`): the 3.5.1 board-shaped distribution with the board
// flipped to scrum, a large `active` sprint holding most of the issues (with a
// story-point spread, some NULL), a backlog slice left OUTSIDE the sprint, and a
// `planned` carry-over target. Like board-at-scale.spec.ts, this spec REQUIRES
// the seam (see the beforeAll guard): it is excluded from the default
// `pnpm test:e2e` run and runs in the dedicated seam-configured CI step.

import { expect, test, type Page } from '@playwright/test';
import { BoardSwimlaneGroupBy, BoardType } from '@prisma/client';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  getBoard,
  columnByStatus,
  columnCardNodes,
  columnTotalBadge,
  columnPointPill,
  expectActiveSprintScope,
  expectColumnVirtualized,
  expectNoLoadMore,
  overCapBanner,
  gotoLoadedBoard,
  signInScrumSeedOwnerAndOpenScrumBoard,
} from './_helpers/board';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyForAppend } from '@/lib/workItems/positioning';
import {
  seedLargeScrumSprint,
  SEED_LARGE_OWNER_EMAIL,
  SEED_LARGE_OWNER_PASSWORD,
  type SeedLargeScrumSprintManifest,
} from '../../scripts/seedLargeBoard';

// The sprint-shaped seed loads tens of cards over real HTTP and renders them
// (virtualized) — generous headroom for the seed in beforeAll + the per-test
// loads, well above the 30s default.
test.describe.configure({ timeout: 120_000 });

// ── The 3.5.1 cap/Done-age test seam — REQUIRED for this spec (reused, 4.7.1) ─
// Read the same envs playwright.config.ts forwards to the dev server, so the
// spec and the server agree on the in-effect cap/window.
function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : null;
}
const CAP = positiveIntEnv('BOARD_ISSUE_CAP_OVERRIDE');
const WINDOW_DAYS = positiveIntEnv('DONE_AGE_WINDOW_DAYS_OVERRIDE');

// The sprint-shaped seed sizing. The board-shaped spread (93 cards — same maths
// as board-at-scale.spec.ts) is partitioned by `backlogSliceEvery: 7` into ~80
// in-sprint issues (comfortably OVER the lowered cap, so the banner shows on the
// SPRINT-scoped board) + ~13 left in the backlog (the scope slice). 1-in-4
// sprint issues stays unestimated (`storyPoints` NULL — the contributes-0 path);
// the rest cycle the point deck so the header totals are at scale.
const SEED_OPTS = {
  epics: 3,
  storiesPerEpic: 6,
  rootStories: 12,
  tallColumnExtra: 60,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
  backlogSliceEvery: 7,
  unestimatedEvery: 4,
};

interface BigSeed {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  manifest: SeedLargeScrumSprintManifest;
}

// Recreate the `SEED_SHAPE=scrum pnpm db:seed:large` sprint-shaped tenant (the
// same owner the at-scale helpers sign in as) at TEST scale, through the 4.7.1
// fixture — `seedLargeScrumSprint` composes the board-shaped distribution, flips
// the board to scrum, and builds the large active sprint + the backlog slice +
// the point spread + the planned carry-over target. Pins the owner's active
// project so the active-project-scoped `/boards` route resolves it.
async function seedBigScrum(): Promise<BigSeed> {
  const owner = await usersService.createUser({
    email: SEED_LARGE_OWNER_EMAIL,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Scrum Seed Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Scrum at scale WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Scrum at scale',
    identifier: 'BIG',
  });
  // Six members for the assignee lanes (one bucket left unassigned by the seed).
  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await usersService.createUser({
      email: `scrum-at-scale-m${i}@example.com`,
      password: SEED_LARGE_OWNER_PASSWORD,
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: workspace.id });
    memberIds.push(m.id);
  }
  const manifest = await seedLargeScrumSprint(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      projectIdentifier: 'BIG',
      ownerId: owner.id,
      memberIds,
    },
    SEED_OPTS,
  );
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ownerId: owner.id, workspaceId: workspace.id, projectId: project.id, manifest };
}

// A second, tiny SCRUM tenant whose active sprint is comfortably UNDER the cap —
// the "banner absent" case — and whose sprint is OVERDUE (endDate in the past →
// `daysRemaining` floored to 0 → "Ended") with a CONTROLLED point spread:
//   A todo 5pts · B todo NULL · C done-category 3pts
// → committed 8 · completed 3 · remaining 5, with the NULL estimate provably
// contributing 0 (exact figures, no NaN). A separate owner keeps it fully
// isolated from the BIG seed.
interface SmallSeed {
  email: string;
  projectId: string;
  workspaceId: string;
  points: { committed: number; completed: number; remaining: number };
}
async function seedSmallScrum(): Promise<SmallSeed> {
  const email = 'scrum-at-scale-undercap@example.com';
  const owner = await usersService.createUser({
    email,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'Under-cap Scrum Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Under-cap scrum WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Under cap scrum',
    identifier: 'SML',
  });
  // Flip the seeded default board to scrum (columns/mappings untouched) — the
  // same direct flip the 4.7.1 fixture and the 4.5.x projection tests use.
  await db.board.updateMany({ where: { projectId: project.id }, data: { type: BoardType.scrum } });
  // An ACTIVE but OVERDUE sprint: started 10 days ago, ended 2 days ago.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sprint = await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Overdue sprint',
      goal: 'Prove Ended + exact aggregate points',
      state: 'active',
      startDate: new Date(Date.now() - 10 * DAY_MS),
      endDate: new Date(Date.now() - 2 * DAY_MS),
      sequence: 1,
    },
  });
  const statuses = await workflowsService.listStatusesByProject(project.id, workspace.id);
  const todoKey = statuses.find((s) => s.category === 'todo')!.key;
  const doneKey = statuses.find((s) => s.category === 'done')!.key;
  // Controlled in-sprint issues (root tasks, direct rows — the 3.5.2 small-seed
  // pattern). Positions are VALID fractional-index keys (memory: padded numbers
  // 500 on a later move; harmless here but the sibling 4.7.3 reuses patterns).
  let pos: string | null = null;
  const rows = [
    { title: 'Estimated todo', status: todoKey, storyPoints: 5 },
    { title: 'Unestimated todo', status: todoKey, storyPoints: null },
    { title: 'Estimated done', status: doneKey, storyPoints: 3 },
  ];
  await db.workItem.createMany({
    data: rows.map((r, i) => ({
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task' as const,
      key: i + 1,
      identifier: `SML-${i + 1}`,
      title: r.title,
      status: r.status,
      reporterId: owner.id,
      position: (pos = keyForAppend(pos)),
      sprintId: sprint.id,
      storyPoints: r.storyPoints,
    })),
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    email,
    projectId: project.id,
    workspaceId: workspace.id,
    points: { committed: 8, completed: 3, remaining: 5 },
  };
}

// A third tenant whose SCRUM board has NO active sprint (only a completed one) —
// the 4.5.2 `sprint: null` path: the board area must show the no-active-sprint
// empty state + the Backlog CTA, never an empty six-column board.
interface NoSprintSeed {
  email: string;
}
async function seedNoActiveSprint(): Promise<NoSprintSeed> {
  const email = 'scrum-at-scale-nosprint@example.com';
  const owner = await usersService.createUser({
    email,
    password: SEED_LARGE_OWNER_PASSWORD,
    name: 'No-sprint Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'No-sprint WS',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'No active sprint',
    identifier: 'NAS',
  });
  await db.board.updateMany({ where: { projectId: project.id }, data: { type: BoardType.scrum } });
  // The sprint is COMPLETED — the common post-complete state, stronger than
  // "no sprint row at all" (a completed sprint must NOT be resolved as active).
  await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Done sprint',
      state: 'complete',
      startDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      sequence: 1,
    },
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { email };
}

// Switch the active swimlane group-by via the board-header Segmented control,
// waiting for the PATCH /api/board that persists it. Mirrors board-at-scale.spec.ts.
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

// The terminal (category `done`) columns of the BIG board, with each column's
// IN-SPRINT cards partitioned by the Done-age cutoff — so the spec asserts the
// EXACT aged-out cards are absent and in-window cards present (the proof the
// window is AGE-based, not count-based: the partition is by `updatedAt` against
// the configured cutoff, and both buckets are non-empty — a count cap would keep
// the most-recent N regardless of age; mirrors the 3.5.2 mandate's proof, since
// the seam env is fixed for the server's lifetime and cannot shrink mid-run).
async function terminalColumnsWithAge(big: BigSeed) {
  const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
  const terminalKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const cutoff = new Date(Date.now() - WINDOW_DAYS! * 24 * 60 * 60 * 1000);
  const out: Array<{
    statusKey: string;
    agedOut: string[];
    inWindow: string[];
    sprintTotal: number;
  }> = [];
  for (const statusKey of terminalKeys) {
    // SPRINT-scoped rows only — the scrum board never shows out-of-sprint cards,
    // so the present/absent expectations are computed over the sprint's set.
    const rows = await db.workItem.findMany({
      where: { projectId: big.projectId, status: statusKey, sprintId: big.manifest.activeSprintId },
      select: { identifier: true, updatedAt: true },
    });
    out.push({
      statusKey,
      agedOut: rows.filter((r) => r.updatedAt < cutoff).map((r) => r.identifier),
      inWindow: rows.filter((r) => r.updatedAt >= cutoff).map((r) => r.identifier),
      sprintTotal: rows.length,
    });
  }
  return out;
}

/** The sprint-scoped SUM of `storyPoints` (NULL → 0) for the given status keys —
 *  the DB-side aggregate the header/pill figures must equal (never a page sum). */
async function sprintPointsAggregate(big: BigSeed, statusKeys?: string[]): Promise<number> {
  const agg = await db.workItem.aggregate({
    where: {
      projectId: big.projectId,
      sprintId: big.manifest.activeSprintId,
      ...(statusKeys ? { status: { in: statusKeys } } : {}),
    },
    _sum: { storyPoints: true },
  });
  return Number(agg._sum.storyPoints ?? 0);
}

let big: BigSeed;
let small: SmallSeed;
let noSprint: NoSprintSeed;

test.beforeAll(async () => {
  // The spec structurally requires the 3.5.1/4.7.1 cap/Done-age seam (it can't
  // reach the over-cap state with tens of rows otherwise). When unset — e.g. a
  // plain local `pnpm test:e2e` — SKIP the whole block visibly rather than fail:
  // CI excludes it from the default run and runs it in the seam-configured step.
  test.skip(
    CAP === null || WINDOW_DAYS === null,
    'board-scrum-at-scale needs the 3.5.1/4.7.1 seam — run `BOARD_ISSUE_CAP_OVERRIDE=40 ' +
      'DONE_AGE_WINDOW_DAYS_OVERRIDE=7 pnpm test:e2e --grep board-scrum-at-scale` (or the dedicated CI step).',
  );
  await resetDatabase();
  big = await seedBigScrum();
  small = await seedSmallScrum();
  noSprint = await seedNoActiveSprint();
  // A set-but-too-high cap is an explicit misconfiguration of THIS run — fail
  // loud. The over-cap state must come from the SPRINT-scoped total (the scrum
  // board never sees the backlog slice), so the gate is sprintIssueCount.
  if (big.manifest.sprintIssueCount <= CAP!) {
    throw new Error(
      `board-scrum-at-scale: the seeded ACTIVE-SPRINT total (${big.manifest.sprintIssueCount}) must ` +
        `EXCEED the lowered cap (BOARD_ISSUE_CAP_OVERRIDE=${CAP}) so the over-cap banner shows on the ` +
        'sprint-scoped board. Lower the cap override.',
    );
  }
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Reset both tenants' boards to the FLAT layout before every test. `setGroupBy`
// PERSISTS the swimlane group-by on the board row (PATCH /api/board), so a test
// that switches to Assignee would otherwise leak swimlanes into the next test —
// whose `gotoLoadedBoard` waits on the flat board's `board` testid and times
// out. (The kanban twin, board-at-scale.spec.ts, has exactly this leak: its
// Done-window test fails on the first attempt in CI and only passes because the
// retry spawns a fresh worker that re-runs beforeAll's reseed — a retry-masked
// flake, logged as a finding. This beforeEach keeps every test here order- and
// retry-independent instead.)
test.beforeEach(async () => {
  if (!big) return; // seam unset → the whole block is skipped
  await db.board.updateMany({
    where: { projectId: { in: [big.projectId, small.projectId] } },
    data: { swimlaneGroupBy: BoardSwimlaneGroupBy.none },
  });
});

test.describe('board-scrum-at-scale — load model + scope + header (4.7.2)', () => {
  test('renders ONLY the active sprint — the backlog slice is absent, counts are sprint-scoped', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    // The projection took the 4.5.2 scrum path: type scrum, the seeded active
    // sprint resolved (never the unscoped backlog masquerading as a sprint).
    expect(board.type).toBe('scrum');
    expect(board.sprint?.id, 'the seeded active sprint scopes the board').toBe(
      big.manifest.activeSprintId,
    );

    // A representative in-sprint issue IS on the board; a backlog-slice issue
    // (left OUTSIDE the sprint by the seed) is ABSENT — the scope filter holds
    // over a large set. Projection-level, so independent of virtualization.
    // Both samples come from a NON-tall column: that column's sprint set loads
    // in full (well under the cap), so the in-sprint card is provably loaded and
    // the out-of-sprint card's absence is provably the SCOPE filter — never the
    // cap truncating the tall column.
    const inSprint = await db.workItem.findFirst({
      where: {
        projectId: big.projectId,
        sprintId: big.manifest.activeSprintId,
        status: { not: big.manifest.tallStatusKey },
      },
      select: { id: true },
    });
    const outOfSprint = await db.workItem.findFirst({
      where: {
        projectId: big.projectId,
        sprintId: null,
        status: { not: big.manifest.tallStatusKey },
      },
      select: { id: true },
    });
    expect(outOfSprint, 'the seed left a backlog slice outside the sprint').toBeTruthy();
    expectActiveSprintScope(board, { present: inSprint!.id, absent: outOfSprint!.id });

    // Every column's totalCount is the SPRINT-scoped count (the backlog slice is
    // not in any denominator), and the whole board sums to the sprint set —
    // bounded by the cap, the column totals are the full sprint distribution.
    for (const col of board.columns) {
      const dbCount = await db.workItem.count({
        where: {
          projectId: big.projectId,
          sprintId: big.manifest.activeSprintId,
          status: { in: col.statusKeys },
        },
      });
      expect(col.totalCount, `sprint-scoped total for ${col.name}`).toBe(dbCount);
    }
    expect(
      board.columns.reduce((n, c) => n + c.totalCount, 0),
      'the column totals sum to the sprint set, not the project',
    ).toBe(big.manifest.sprintIssueCount);
  });

  test('loads the whole bounded sprint set with NO "Load more"; badges show full sprint totals', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    // The retired 3.8.3 per-column cursor paging is gone on the SCRUM board too:
    // no "Load more" button and no scroll-sentinel footer anywhere on the flat
    // sprint-scoped board.
    await expectNoLoadMore(page);

    // Each column's count badge is its FULL sprint-scoped totalCount (the
    // denominator is the whole sprint set, not the loaded window), and cards
    // actually render.
    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated`).toBeGreaterThan(0);
      expect(await columnTotalBadge(page, col.id), `badge for ${col.name}`).toBe(col.totalCount);
    }
    const anyCol = board.columns.find((c) => c.totalCount > 0)!;
    await expect(columnCardNodes(page, anyCol.id).first()).toBeVisible();
  });

  test('virtualizes a tall sprint column — bounded DOM, later cards reachable by scrolling not paging', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    // The seed's tall column (most cards), far past the row window even after
    // the sprint scope removed the backlog slice.
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
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    // Sanity: the seam put the SPRINT-scoped board over the (lowered) cap.
    expect(board.cap, 'projection echoes the lowered cap').toBe(CAP);
    expect(board.truncated, 'sprint total exceeds the cap → truncated').toBe(true);

    // Flat scrum board: the banner shows above it, names the cap, pairs hue with
    // the alert-triangle icon + copy (not colour-alone, finding #35), role=status.
    const banner = overCapBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toContainText(String(CAP)); // copy names the cap number
    await expect(banner.locator('svg').first()).toBeVisible(); // the AlertTriangle, not colour-alone

    // Swimlane layout (group-by Assignee): the banner is mounted above BOTH
    // layouts (3.8.4 — it lives in BoardContainer), so it stays visible on the
    // sprint-scoped lanes; no per-lane "Load more" either (3.8.5).
    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(overCapBanner(page)).toBeVisible();
    await expectNoLoadMore(page);
  });

  test('hides the over-cap banner on an under-cap scrum board (flat AND swimlane)', async ({
    page,
  }) => {
    // The small tenant's sprint is well under the cap → truncated false → no banner.
    await signIn(page, small.email, SEED_LARGE_OWNER_PASSWORD);
    await gotoLoadedBoard(page);
    const board = await getBoard(page.request);
    expect(board.type).toBe('scrum');
    expect(board.truncated, 'under-cap sprint is not truncated').toBe(false);
    await expect(overCapBanner(page)).toHaveCount(0);

    await setGroupBy(page, 'Assignee');
    await expect(page.getByTestId('swimlane-board')).toBeVisible();
    await expect(overCapBanner(page)).toHaveCount(0);
  });

  test('windows the Done column to the recent sprint set — old resolved absent, full count on the badge', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);
    const terminals = await terminalColumnsWithAge(big);

    // Seed sanity: the Done-age spread actually produced both buckets INSIDE the
    // sprint, so the assertion below is meaningful (some trimmed, some kept).
    const totalAgedOut = terminals.reduce((n, t) => n + t.agedOut.length, 0);
    const totalInWindow = terminals.reduce((n, t) => n + t.inWindow.length, 0);
    expect(totalAgedOut, 'some in-sprint terminal cards aged out of the window').toBeGreaterThan(0);
    expect(totalInWindow, 'some in-sprint terminal cards inside the window').toBeGreaterThan(0);

    for (const term of terminals) {
      const col = columnByStatus(board, term.statusKey);

      // The count badge shows the FULL sprint-scoped terminal total (incl. the
      // aged-out ones)…
      expect(await columnTotalBadge(page, col.id), `badge for ${term.statusKey}`).toBe(
        col.totalCount,
      );
      expect(col.totalCount).toBe(term.sprintTotal);

      // …but every in-sprint card resolved OUTSIDE the window is windowed out of
      // the DOM…
      for (const id of term.agedOut) {
        await expect(page.getByTestId(`board-card-${id}`), `aged-out ${id} absent`).toHaveCount(0);
      }
      // …while recently-resolved in-sprint cards are loaded + rendered. The
      // column is short (terminal cards are not the tall column), so no
      // virtualization hides them: their absence above is AGE-based, not a count
      // cap (a count cap would keep the most-recent-by-position N regardless of
      // resolved age — here the partition is strictly by the cutoff timestamp).
      for (const id of term.inWindow) {
        await expect(page.getByTestId(`board-card-${id}`), `in-window ${id} present`).toBeVisible();
      }
    }
  });

  test('sprint header points come from bounded aggregates over the WHOLE sprint — never page sums', async ({
    page,
  }) => {
    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);
    const sprint = board.sprint!;

    // The header figures equal the DB-side sprint-scoped aggregates (NULL → 0)…
    const statuses = await workflowsService.listStatusesByProject(big.projectId, big.workspaceId);
    const doneKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
    const committed = await sprintPointsAggregate(big);
    const completed = await sprintPointsAggregate(big, doneKeys);
    expect(committed, 'manifest committed matches the DB aggregate').toBe(
      big.manifest.committedPoints,
    );
    expect(sprint.points.committed).toBe(committed);
    expect(sprint.points.completed).toBe(completed);
    expect(sprint.points.remaining).toBe(committed - completed);

    // …and STRICTLY exceed the sum over the bounded loaded card page: the board
    // is truncated (over the cap), so estimated sprint issues exist beyond the
    // loaded set — a page sum could never reproduce the aggregate. This is the
    // finding-#57 proof that the figures are SUM aggregates, not client sums.
    const loadedSum = board.columns
      .flatMap((c) => c.cards)
      .reduce((n, card) => n + (card.storyPoints ?? 0), 0);
    expect(board.truncated).toBe(true);
    expect(committed, 'aggregate exceeds any loaded-page sum').toBeGreaterThan(loadedSum);

    // The per-column point pills (4.5.3) each equal the column's sprint-scoped
    // aggregate (`SprintSummaryDto.columnPoints`), at scale. The map is TOTAL
    // over the columns (a column with no estimated sprint issues carries 0 and
    // renders a "0 pts" pill — the estimated-sprint gate is board-level), so the
    // equality holds for every column.
    for (const col of board.columns) {
      const colAggregate = await sprintPointsAggregate(big, col.statusKeys);
      expect(sprint.columnPoints[col.id], `columnPoints for ${col.name}`).toBe(colAggregate);
      expect(await columnPointPill(page, col.id), `point pill for ${col.name}`).toBe(colAggregate);
    }
  });

  test('header shows exact figures with NULL→0 (no NaN) and "Ended" for an overdue sprint', async ({
    page,
  }) => {
    // The controlled small tenant: committed 8 (5 + 3; the NULL estimate
    // contributes 0, not NaN) · completed 3 (the done-category issue) ·
    // remaining 5 — exact numbers, readable from the header aria-label.
    await signIn(page, small.email, SEED_LARGE_OWNER_PASSWORD);
    await gotoLoadedBoard(page);
    const board = await getBoard(page.request);
    expect(board.sprint?.points).toEqual(small.points);

    const header = page.getByTestId('sprint-header');
    await expect(header).toBeVisible();
    const summary = header.locator('[aria-label*="committed"][aria-label*="completed"]');
    await expect(summary).toHaveAttribute(
      'aria-label',
      `Story points: ${small.points.committed} committed, ${small.points.completed} completed, ${small.points.remaining} remaining`,
    );
    await expect(header.getByText(/NaN/)).toHaveCount(0);

    // The sprint's endDate is in the past → `daysRemaining` floored at 0 → the
    // header reads "Ended" (the peach chip), never a negative day count.
    expect(board.sprint?.daysRemaining).toBe(0);
    await expect(header.getByText('Ended', { exact: true })).toBeVisible();
    await expect(header.getByText(/-\d+ days?/)).toHaveCount(0);
  });

  test('shows the no-active-sprint empty state + Backlog CTA for a completed sprint — not an empty board', async ({
    page,
  }) => {
    await signIn(page, noSprint.email, SEED_LARGE_OWNER_PASSWORD);
    await page.goto('/boards');

    // The 4.5.2 `sprint: null` path on a scrum board: the EmptyState replaces
    // the board (no six-column shell, no sprint header), with the Backlog CTA.
    await expect(page.getByRole('heading', { name: 'No active sprint' })).toBeVisible();
    const cta = page.getByRole('link', { name: 'Go to Backlog' });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/backlog');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.getByTestId('sprint-header')).toHaveCount(0);

    // The projection agrees: scrum board, sprint null (the completed sprint was
    // not resolved as active).
    const board = await getBoard(page.request);
    expect(board.type).toBe('scrum');
    expect(board.sprint).toBeNull();
  });

  test('never calls the retired per-column cursor / "Load more" route', async ({ page }) => {
    const offending: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      // The retired 3.8.3 affordance was GET /api/board/columns/[id]/cards (+ a
      // ?cursor= page token). The scrum board read is the same single GET /api/board.
      if (/\/api\/board\/columns\/[^/?]+\/cards/.test(url) || url.includes('cursor=')) {
        offending.push(`${r.method()} ${url}`);
      }
    });

    await signInScrumSeedOwnerAndOpenScrumBoard(page);
    const board = await getBoard(page.request);

    // Exercise the surfaces that historically would have paged: scroll the tall
    // sprint column and switch into the swimlane layout.
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
