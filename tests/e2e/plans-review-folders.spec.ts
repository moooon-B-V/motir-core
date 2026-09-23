// FOLDERS ON THE PLAN-REVIEW CANVAS — the assembled journey (Bug MOTIR-5782 ·
// MOTIR-5796; design `design/ai-planning/design-notes.md` Part XVIII). The code is
// MOTIR-5795's (`PlanReviewCanvas`), and its component tests prove the logic; this
// spec walks it in a real browser against a real server, on `/plans/[id]`:
//
//   • ARRIVAL (§18.2): a plan with one add filed into "Archive" and one unfiled
//     root add ties 1–1, and the tie goes to the DEEPER level — so it opens ON
//     Archive, behind a navigable folder crumb;
//   • THE ROOT (decision 1): folder cards, no filed committed item loose, the
//     unfiled proposal beside the epics, and Archive BADGED as holding a change
//     (decision 3);
//   • A FOLDER (decisions 1–2): its child folder, its filed items and the filed
//     proposal; one deeper, and the folder crumb navigates back (decision 5).
//
// The plan is seeded through the shipped plan services (`seedFolderPlan`) — no
// planner turn. Every step waits on the level's roadmap GET (`folders=1` /
// `folderId=`) or the rendered DOM, never a fixed sleep, and every locator is
// scoped to the canvas (MOTIR-5037).

import { expect, test, type Locator, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedFolderPlan, seedFolderRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const isRoadmapGet = (url: string) => url.includes('/api/projects/') && url.includes('/roadmap');
const rootLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      r.url().includes('folders=1') &&
      !r.url().includes('folderId') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
const folderLoad = (page: Page, folderId: string) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      r.url().includes(`folderId=${folderId}`) &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

const canvasOf = (page: Page) => page.getByRole('main').getByTestId('roadmap-canvas');
const folderCard = (canvas: Locator, folderId: string) =>
  canvas.locator(`[data-node-id="folder:${folderId}"]`);
const crumbs = (canvas: Locator) => canvas.getByRole('navigation', { name: 'Breadcrumb' });

/** Select a folder card and press its door. The review canvas keeps no level
 *  cache, so every drill is a real read, awaited by its response. */
async function drill(page: Page, card: Locator, folderId: string) {
  const level = folderLoad(page, folderId);
  await card.click();
  await canvasOf(page).getByTestId('drill-button').click();
  await level;
}

test('plan review draws folders: arrival on the folder, the root, a folder, and its crumb', async ({
  page,
}) => {
  // MOTIR-5816: pin the viewport where the plan-detail rail leaves the canvas
  // narrow enough for a three-crumb trail to meet its top-right controls.
  await page.setViewportSize({ width: 1280, height: 720 });
  const seed = await seedFolderRoadmap('plans-review-folders@example.com');
  const plan = await seedFolderPlan(seed);
  await signIn(page, seed.email, seed.password);

  // ── 1. ARRIVAL: the tie goes to the deeper level — Archive (§18.2) ──────────
  const arrived = folderLoad(page, seed.archiveId);
  await page.goto(`/plans/${plan.planId}?view=canvas`);
  await arrived;
  const canvas = canvasOf(page);
  await expect(canvas).toBeVisible();
  await expect(crumbs(canvas).getByRole('button', { name: 'Folder: Archive' })).toBeVisible();
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toHaveCount(0);

  // ── 2. THE ROOT: folder cards, nothing filed loose, the badge (decisions 1, 3) ─
  const backToRoot = rootLoad(page);
  await crumbs(canvas).getByRole('button', { name: 'Roadmap' }).click();
  await backToRoot;
  const archive = folderCard(canvas, seed.archiveId);
  await expect(archive).toBeVisible();
  await expect(folderCard(canvas, seed.laterId)).toBeVisible();
  await expect(archive.getByTestId('folder-changes')).toHaveText('1 change');
  await expect(folderCard(canvas, seed.laterId).getByTestId('folder-changes')).toHaveCount(0);
  for (const title of seed.epicTitles) {
    await expect(canvas.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toBeVisible();
  for (const title of [...seed.archivedTitles, seed.deepBugTitle, plan.filedTitle]) {
    await expect(canvas.getByText(title, { exact: true })).toHaveCount(0);
  }

  // ── 3. DRILL A FOLDER: its child folder, its filed items, the filed proposal ──
  await drill(page, archive, seed.archiveId);
  await expect(folderCard(canvas, seed.importsId)).toBeVisible();
  for (const title of seed.archivedTitles) {
    await expect(canvas.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(plan.rootTitle, { exact: true })).toHaveCount(0);

  // ── 4. ONE DEEPER, then the FOLDER CRUMB navigates back (decision 5) ─────────
  await drill(page, folderCard(canvas, seed.importsId), seed.importsId);
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toBeVisible();
  const backToArchive = folderLoad(page, seed.archiveId);
  // Pointer activation is the regression: before MOTIR-5816 the search input
  // painted over this visible crumb and intercepted the click.
  await crumbs(canvas).getByRole('button', { name: 'Folder: Archive' }).click();
  await backToArchive;
  await expect(canvas.getByText(plan.filedTitle, { exact: true })).toBeVisible();
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toHaveCount(0);
});
