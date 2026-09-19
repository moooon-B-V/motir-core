// FOLDERS ON THE ROADMAP — the assembled journey (Bug MOTIR-5710 · MOTIR-5743;
// design MOTIR-5713, `design/roadmap/roadmap--folder-node.mock.html` sheets 3–6
// and decision 6). Each producer ships its own unit tests; this spec walks the
// whole path in a real browser against a real server: the root draws folder cards
// ahead of "Not in an epic", a folder drills to its folders then its items, a
// folder crumb navigates back, an empty folder says so, a folder level survives a
// reload, and sprint scope draws no folder at all.
//
// Drives the REAL stack (Next + Postgres) and waits on AUTHORITATIVE signals — the
// per-level roadmap GET for each level and the rendered DOM — never fixed sleeps
// (the E2E discipline in motir-core/CLAUDE.md). A level served from the canvas's
// own cache issues no request, so there the DOM is the signal.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedFolderRoadmap } from './_helpers/roadmap-seed';

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
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

async function drill(page: Page, card: Locator, folderId: string, fetches = true) {
  const level = fetches ? folderLoad(page, folderId) : null;
  await card.click();
  // Scoped to the LIVE canvas — never page-rooted (MOTIR-5037).
  await canvasOf(page).getByTestId('drill-button').click();
  if (level) await level;
}

test('folders on the roadmap: the root, a folder, its crumb, an empty folder, a reload and sprint scope', async ({
  page,
}) => {
  const seed = await seedFolderRoadmap('roadmap-folders@example.com');
  await signIn(page, seed.email, seed.password);

  // ── 1. THE ROOT: folder cards lead the loose band, ahead of Not in an epic ──
  const rootLoaded = rootLoad(page);
  await page.goto('/roadmap');
  await rootLoaded;
  const canvas = canvasOf(page);
  for (const title of seed.epicTitles) {
    await expect(canvas.getByText(title, { exact: true })).toBeVisible();
  }
  const archive = folderCard(canvas, seed.archiveId);
  const later = folderCard(canvas, seed.laterId);
  await expect(archive).toBeVisible();
  await expect(archive).toContainText('1 folder · 3 items');
  await expect(later).toContainText('Empty');
  const group = canvas.getByTestId('level-group-node');
  await expect(group).toBeVisible();
  // No filed work item is drawn at the root; the unfiled bug sits in the group.
  for (const title of [...seed.archivedTitles, seed.deepBugTitle, seed.looseBugTitle]) {
    await expect(canvas.getByText(title, { exact: true })).toHaveCount(0);
  }
  // Folders LEAD the loose band: laid out in order, so each folder sits before the
  // grouped node in reading order (earlier row, or the same row further left).
  const [a, g] = [await archive.boundingBox(), await group.boundingBox()];
  expect(a && g).toBeTruthy();
  expect(a!.y < g!.y || (a!.y === g!.y && a!.x < g!.x)).toBe(true);

  // ── 2. DRILL A FOLDER: its child folder first, then its filed items ──────────
  await drill(page, archive, seed.archiveId);
  const imports = folderCard(canvas, seed.importsId);
  await expect(imports).toBeVisible();
  for (const title of seed.archivedTitles) {
    await expect(canvas.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(canvas.getByTestId('level-group-node')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`folder=${seed.archiveId}`));

  // ── 3. ONE DEEPER, then the FOLDER CRUMB navigates back ──────────────────────
  await drill(page, imports, seed.importsId);
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toBeVisible();
  await crumbs(page).getByRole('button', { name: 'Folder: Archive' }).click();
  // Served from the canvas's cache — the DOM is the signal.
  await expect(canvas.getByText(seed.archivedTitles[2], { exact: true })).toBeVisible();
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toHaveCount(0);

  // ── 4. A RELOAD reopens a folder level with its crumb chain ──────────────────
  await drill(page, folderCard(canvas, seed.importsId), seed.importsId, false);
  await expect(canvas.getByText(seed.deepBugTitle, { exact: true })).toBeVisible();
  const reloaded = folderLoad(page, seed.importsId);
  await page.reload();
  await reloaded;
  await expect(canvasOf(page).getByText(seed.deepBugTitle, { exact: true })).toBeVisible();
  await expect(crumbs(page).getByRole('button', { name: 'Folder: Archive' })).toBeVisible();
  await expect(crumbs(page).getByRole('button', { name: 'Folder: Imports' })).toBeVisible();

  // ── 5. AN EMPTY FOLDER says so in folder words ──────────────────────────────
  // The reload OPENED on Imports, so the root was never read in this page: going
  // back to it is a real read, awaited by its response.
  const backToRoot = rootLoad(page);
  await crumbs(page).getByRole('button', { name: 'Roadmap' }).click();
  await backToRoot;
  await drill(page, folderCard(canvasOf(page), seed.laterId), seed.laterId);
  await expect(canvasOf(page).getByText('This folder is empty')).toBeVisible();
  await expect(
    canvasOf(page).getByText('Work items filed into Later from Work items will show here.'),
  ).toBeVisible();

  // ── 6. SPRINT SCOPE draws no folder and ignores placement ────────────────────
  const sprintLoaded = page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      r.url().includes('scope=sprint') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
  await page.getByRole('group', { name: 'Roadmap scope' }).getByText('Active sprint').click();
  await sprintLoaded;
  await expect(canvasOf(page).getByText(seed.sprintBugTitle, { exact: true })).toBeVisible();
  await expect(canvasOf(page).locator('[data-node-id^="folder:"]')).toHaveCount(0);
});
