// E2E: the Story-4.6 charts journey (the closing test Subtask 4.6.7) — the
// burndown + velocity analytics over the real stack (Next routes + Postgres).
//
// The per-subtask layers are proven in isolation already: the aggregates in
// tests/integration/reports/* (4.6.3 / 4.6.4), the SVG primitives in
// tests/components/charts.test.tsx (4.6.2), the mounted slots in
// tests/components/{scrum-board,sprint-report}.test.tsx (4.6.5 / 4.6.6). THIS
// spec proves them composed: a signed-in user sees the live in-sprint burndown
// in the scrum header BESIDE the numeric remaining, watches the actual line
// reflect a new burn, completes the sprint, and reads the completed-sprint
// burndown + the velocity bars + the average on the sprint report — plus the
// low-history (fresh project) and unestimated degraded states, rendered
// without errors. The at-scale combined Scrum journey is Story 4.7's
// (board-scrum-at-scale*), not duplicated here.
//
// One seeded tenant (workers=1, serial — later tests build on earlier sprint
// completions, the velocity history). The fixture seeds through the SHIPPED
// services (tests/e2e/_helpers/scrum-board-seed.ts — the real 4.4 start path);
// follow-up sprints are minted the same way in-process. Marking issues done
// walks the real workflow transitions via `workItemsService.updateStatus`
// (todo → in_progress → in_review → done), so every burn writes a real 1.4.6
// revision — the trail the burndown derives from.
// Run: `pnpm test:e2e --grep charts`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedScrumBoard, type ScrumSeed } from './_helpers/scrum-board-seed';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { workItemsService } from '@/lib/services/workItemsService';

// Service-seeded tenant + several cold route compiles + real sign-ins; the
// same headroom the sibling board/lifecycle specs take.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const OWNER_EMAIL = 'charts-owner@prodect.dev';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The real 4.5/4.6 done-path: walk the defaultWorkflow's legal transitions so
 *  each step writes a revision (the burndown's source trail). */
async function markDone(seed: ScrumSeed, workItemId: string): Promise<void> {
  await workItemsService.updateStatus(workItemId, 'in_progress', seed.ctx);
  await workItemsService.updateStatus(workItemId, 'in_review', seed.ctx);
  await workItemsService.updateStatus(workItemId, 'done', seed.ctx);
}

/** Mint a sprint with issues through the shipped services, start it, mark the
 *  requested issues done, and complete it — a full lifecycle pass that leaves
 *  one more completed sprint in the velocity history. */
async function runCompletedSprint(
  seed: ScrumSeed,
  name: string,
  issues: Array<{ points: number | null; done: boolean }>,
): Promise<string> {
  const sprint = await sprintsService.createSprint(seed.projectId, { name }, seed.ctx);
  const created: Array<{ id: string; done: boolean }> = [];
  for (const [i, iss] of issues.entries()) {
    const dto = await backlogService.createBacklogIssue(
      seed.projectId,
      { kind: 'story', title: `${name} issue ${i + 1}`, sprintId: sprint.id },
      seed.ctx,
    );
    if (iss.points !== null) {
      // Estimate directly so the aggregates read as numbers — the same
      // sanctioned setup shortcut the sibling seeds take.
      await db.workItem.update({ where: { id: dto.id }, data: { storyPoints: iss.points } });
    }
    created.push({ id: dto.id, done: iss.done });
  }
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 5 * DAY_MS).toISOString() },
    seed.ctx,
  );
  for (const c of created) {
    if (c.done) await markDone(seed, c.id);
  }
  await sprintsService.completeSprint(sprint.id, {}, seed.ctx);
  return sprint.id;
}

/** The compact header chart hides its legend for density; its numbers live in
 *  the data-table fallback. Open the <details> and return the table. */
async function openDataTable(scope: Locator): Promise<Locator> {
  await scope.getByText('View data table').click();
  const table = scope.getByRole('table');
  await expect(table).toBeVisible();
  return table;
}

async function openReport(page: Page, sprintId: string, sprintName: string): Promise<void> {
  await page.goto(`/sprints/${sprintId}/report`);
  await expect(
    page.getByRole('heading', { name: `${sprintName} report`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('charts (4.6.7)', () => {
  let seed: ScrumSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    // Active "Sprint Alpha": A (3, todo) · B (2, done) · C (5, todo) —
    // committed 10 / completed 2 / remaining 8.
    seed = await seedScrumBoard(OWNER_EMAIL);
  });

  test('the scrum header shows the live burndown beside the numeric remaining; a new done issue burns the actual line', async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/boards?board=${encodeURIComponent(seed.scrumBoardId)}`);

    const header = page.getByTestId('sprint-header');
    await expect(header).toBeVisible({ timeout: 30_000 });

    // The burndown slot renders BESIDE the numeric summary — both visible at
    // once (the 4.6.5 seam contract: the chart augments, never replaces).
    await expect(
      header.locator('[aria-label="Story points: 10 committed, 2 completed, 8 remaining"]'),
    ).toBeVisible();
    const slot = page.getByTestId('sprint-burndown');
    await expect(slot).toBeVisible();
    await expect(slot.getByText('Burndown', { exact: true })).toBeVisible();
    await expect(slot.getByText(/Day \d+ of \d+/)).toBeVisible();
    // The chart is a labelled role="img" SVG (the finding-#35 a11y contract).
    await expect(slot.getByRole('img', { name: 'Burndown' })).toBeVisible();

    // The compact chart's data-table fallback carries the numbers: today's
    // actual remaining is 8 (B's 2 of 10 burned before we arrived).
    let table = await openDataTable(slot);
    await expect(table.getByRole('row').filter({ hasText: '(today)' })).toContainText('8');

    // Burn A (3 pts) through the real workflow → the sprint remaining drops to
    // 5, and the redrawn actual line + table reflect it after a reload.
    await markDone(seed, seed.issueA.id);
    await page.reload();
    await expect(header).toBeVisible({ timeout: 30_000 });
    await expect(
      header.locator('[aria-label="Story points: 10 committed, 5 completed, 5 remaining"]'),
    ).toBeVisible();
    table = await openDataTable(page.getByTestId('sprint-burndown'));
    await expect(table.getByRole('row').filter({ hasText: '(today)' })).toContainText('5');
  });

  test('the completed sprint report shows the burndown; velocity shows the low-history state for a fresh project', async ({
    page,
  }) => {
    // Complete Alpha through the shipped lifecycle (C carries to the backlog).
    await sprintsService.completeSprint(seed.sprintId, {}, seed.ctx);

    await signIn(page, seed.email, seed.password);
    await openReport(page, seed.sprintId, 'Sprint Alpha');

    // The completed-sprint burndown renders in the report's chart seam: the
    // section heading, the labelled SVG, and the data-table fallback whose
    // Event column pins the start (committed 10) + completion markers.
    await expect(page.getByText('Burndown', { exact: true }).first()).toBeVisible();
    const burndownImg = page.getByRole('img', { name: 'Burndown' });
    await expect(burndownImg).toBeVisible();
    // The <desc> reads as the completed-sprint sentence (not the live "as of
    // today" form) — the series switched to its completed shape.
    await expect(burndownImg).toHaveAccessibleDescription(/Completed-sprint burndown/);
    const table = await openDataTable(page.locator('section').filter({ hasText: 'Burndown' }));
    await expect(table.getByRole('row').filter({ hasText: 'Sprint started' })).toContainText('10');

    // ONE completed sprint = not enough velocity history — the low-history
    // empty state renders, never an axis-of-one.
    await expect(page.getByText('Velocity', { exact: true })).toBeVisible();
    await expect(page.getByText('Not enough history yet')).toBeVisible();
  });

  test('a second completed sprint turns on the velocity bars with the average', async ({
    page,
  }) => {
    // Sprint Beta: 6 committed (4 + 2), the 4-pointer done → completed 4.
    const betaId = await runCompletedSprint(seed, 'Sprint Beta', [
      { points: 4, done: true },
      { points: 2, done: false },
    ]);

    await signIn(page, seed.email, seed.password);
    await openReport(page, betaId, 'Sprint Beta');

    // Two completed sprints → the grouped bars render (2 sprints × 2 series),
    // with the committed/completed TEXT legend + the average line + its legend
    // entry (never colour alone — finding #35).
    const velocitySection = page.locator('section').filter({ hasText: 'Velocity' });
    await expect(velocitySection.getByText('Last 2 completed sprints').first()).toBeVisible();
    for (const label of ['Committed', 'Completed', 'Average completed']) {
      await expect(velocitySection.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(velocitySection.locator('rect[fill*="--el-chart"]')).toHaveCount(4);
    // The average annotation draws on the chart: Alpha completed 5 (A + B
    // burned in the header journey), Beta completed 4 → avg 4.5.
    await expect(velocitySection.getByText('avg 4.5', { exact: true })).toBeVisible();
  });

  test('an unestimated sprint renders the degraded issue-count states without errors', async ({
    page,
  }) => {
    // Sprint Gamma: two wholly unestimated issues, one done — no point
    // baseline anywhere, so the burndown degrades to the issue-count series.
    const gammaId = await runCompletedSprint(seed, 'Sprint Gamma', [
      { points: null, done: true },
      { points: null, done: false },
    ]);

    await signIn(page, seed.email, seed.password);
    await openReport(page, gammaId, 'Sprint Gamma');

    // The burndown renders on the issue-count axis (the degraded statistic),
    // and the velocity window now spans 3 completed sprints with Gamma's 0s —
    // every figure stays a number, never NaN, and no chart error state shows.
    await expect(page.getByText('Issues remaining', { exact: true })).toBeVisible();
    await expect(page.getByText('Last 3 completed sprints').first()).toBeVisible();
    await expect(page.getByText("Couldn't load the chart")).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('NaN');
  });
});
