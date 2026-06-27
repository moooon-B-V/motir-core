// Roadmap locate E2E (Story MOTIR-1421 / Subtask MOTIR-1429) — the browser-level
// proof of the Locate control (MOTIR-1428): from the populated roadmap, the Locate
// button centres + highlights the actionable node — the "you are here" frontier
// FIRST, else the ready nodes, cycling + wrapping when there are several.
//
// Drives the REAL stack (Next + Postgres) end to end; the fixture seeds a tenant
// shaped for both paths (seedLocateRoadmap). Waits on AUTHORITATIVE signals — the
// per-level roadmap GET and the rendered highlight state (`[data-highlighted]`, the
// same treatment the search-locate uses) — never fixed sleeps (the E2E discipline
// in motir-core/CLAUDE.md). Exactly one node is highlighted at a time, so the
// single `[data-highlighted]` element's text identifies the located node.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedLocateRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

const rootLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
const drillLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

// The single highlighted (located) node — its text identifies which node is centred.
const located = (page: Page) => page.locator('[data-highlighted]');
// The single SELECTED node — locate selects the located card (surfacing its actions).
const selected = (page: Page) => page.locator('[data-selected]');

// The canvas world transform's scale (matrix.a) — the live zoom level.
const worldScale = (page: Page) =>
  page
    .getByTestId('canvas-world')
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

test('Roadmap: Locate centres the frontier first, then cycles the ready nodes with wrap', async ({
  page,
}) => {
  const seed = await seedLocateRoadmap('roadmap-locate@example.com');
  await signIn(page, seed.email, seed.password);

  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = rootLevelLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;
  await expect(page.getByTestId('planning-canvas')).toBeVisible();

  const locate = page.getByTestId('locate-button');
  const hint = page.getByTestId('locate-hint');

  // ── 1. Frontier priority + zoom-to-readable-default ──────────────────────────────
  await expect(locate).toBeEnabled();
  await expect(located(page)).toHaveCount(0); // nothing highlighted until located
  // Zoom out first so the located card would otherwise be small — locate must snap the
  // zoom back to the readable 1× default.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' });
  await zoomOut.click();
  await zoomOut.click();
  await zoomOut.click();
  expect(await worldScale(page)).toBeLessThan(1);

  await locate.click();
  await expect(located(page)).toHaveCount(1);
  await expect(located(page)).toContainText(seed.frontierTitle); // the "you are here" node
  await expect(selected(page)).toContainText(seed.frontierTitle); // ...and selected
  await expect(hint).toHaveCount(0); // a single frontier target → no cycling hint
  await expect.poll(() => worldScale(page)).toBeCloseTo(1, 5); // reset to the readable default

  // ── 2. Drill into the to-do epic (no frontier there → ready cycling) ─────────────
  const readyEpicNode = page.locator('[data-node-id]').filter({ hasText: seed.readyEpicTitle });
  await readyEpicNode.click();
  const openButton = page.getByTestId('drill-button');
  await expect(openButton).toBeVisible();
  const childrenLoaded = drillLevelLoad(page);
  await openButton.click();
  await childrenLoaded;
  await expect(page.getByText(seed.readyChildTitles[0], { exact: true })).toBeVisible();

  // ── 3. Cycle the three ready children, in order, wrapping after the last ─────────
  await locate.click();
  await expect(located(page)).toContainText(seed.readyChildTitles[0]);
  await expect(hint).toHaveText('1 / 3');

  await locate.click();
  await expect(located(page)).toContainText(seed.readyChildTitles[1]);
  await expect(selected(page)).toContainText(seed.readyChildTitles[1]); // selection follows
  await expect(hint).toHaveText('2 / 3');

  await locate.click();
  await expect(located(page)).toContainText(seed.readyChildTitles[2]);
  await expect(hint).toHaveText('3 / 3');

  // wrap-around → back to the first
  await locate.click();
  await expect(located(page)).toContainText(seed.readyChildTitles[0]);
  await expect(hint).toHaveText('1 / 3');
});
