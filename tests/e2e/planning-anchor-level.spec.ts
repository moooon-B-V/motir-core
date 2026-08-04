// Planning workspace — the ANCHOR reaches the CANVAS (Bug MOTIR-2070).
//
// Opening the planning workspace FROM a work item used to land the canvas on the
// project's ROOT level: the anchor was spent on the conversation (the pre-filled
// `@`-mention target + the MOTIR-909 thread) and dropped on the canvas, which
// seeded itself from `parentId = null`. On a real tree that meant three manual
// drills to reach the item you were already looking at — and the anchor's target
// ring was drawn on a level nobody was on, indistinguishable from no anchor.
//
// This is the browser-level proof, on a REAL `epic → story → subtask` tree: the
// workspace opens ALREADY DRILLED to the level that CONTAINS the anchor, ringed.
// The unit tests prove the seed mechanics and the integration seam proves the page
// derives the trail from the real ancestor chain; only this proves what the user
// actually SEES on arrival.
//
// Drives the real stack (Next + Postgres). Waits on AUTHORITATIVE signals — the
// per-level roadmap GET (MOTIR-1010) and rendered DOM — never fixed sleeps
// (`motir-core/CLAUDE.md` § E2E discipline; `notes.html` #37).

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree } from './_helpers/planning-anchor-seed';

// Service-side seeding of a whole tenant + tree, the sign-in flow and the canvas
// render comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The workspace's own entry href — the launcher's `work-item` context. */
const anchoredHref = (itemKey: string) =>
  `/planning?mode=contextual&from=work-item&item=${encodeURIComponent(itemKey)}`;

/** A CANVAS node by its title. Scoped to the canvas's node layer on purpose: the
 *  anchor's title also appears in the chat's target CHIP, so a bare text lookup
 *  is ambiguous — and it is the CANVAS this bug is about. */
const canvasNode = (page: Page, title: string) =>
  page.getByTestId('planning-canvas').locator('[data-node-id]').filter({ hasText: title });

/** A roadmap LEVEL fetch for a DRILLED level (the arrival carries a `parentId`). */
const drilledLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('the workspace opens on the ANCHOR’s own level, with the anchor ringed', async ({ page }) => {
  const seed = await seedPlanningAnchorTree('planning-anchor@example.com');
  await signIn(page, seed.email, seed.password);

  // Arm the level fetch BEFORE navigating: the ARRIVAL itself must request a
  // drilled level (`parentId=<the story>`). Before the fix the first — and only —
  // roadmap request carried no `parentId` at all, so this response never came.
  const arrived = drilledLevelLoad(page);
  await page.goto(anchoredHref(seed.subtaskKey));
  await arrived;

  // ── The level the canvas landed on IS the anchor's ────────────────────────
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  // The anchor is on screen, without a single drill…
  await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
  // …and so is its SIBLING — which is what makes this the CONTAINING level rather
  // than the anchor's own children (that level holds neither).
  await expect(canvasNode(page, seed.siblingTitle)).toBeVisible();
  // The root level's epics are NOT drawn — the arrival is genuinely drilled.
  await expect(canvasNode(page, 'Growth experiments')).toHaveCount(0);

  // ── The breadcrumb reads as an ordinary drilled view ──────────────────────
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText(`${seed.epicKey} · ${seed.epicTitle}`);
  await expect(breadcrumb).toContainText(`${seed.storyKey} · ${seed.storyTitle}`);

  // ── The target ring is now on a level the user is actually looking at ─────
  const target = page.getByTestId('planning-target-node');
  await expect(target).toBeVisible();
  await expect(target).toContainText(seed.subtaskTitle);

  // ── And it is a normal drilled view: Back climbs out of it ────────────────
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(canvasNode(page, seed.storyTitle)).toBeVisible();
  await expect(canvasNode(page, seed.subtaskTitle)).toHaveCount(0);
});

test('a ROOT-level anchor (an epic) still opens at the root, undrilled', async ({ page }) => {
  const seed = await seedPlanningAnchorTree('planning-anchor-epic@example.com');
  await signIn(page, seed.email, seed.password);

  await page.goto(anchoredHref(seed.epicKey));

  // The epic is already ON the root level, so there is nothing to drill to: both
  // root epics are drawn and there is no breadcrumb at all.
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
  await expect(canvasNode(page, 'Growth experiments')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
});

test('an UNRESOLVABLE ?item= opens the workspace at the root, never an error', async ({ page }) => {
  const seed = await seedPlanningAnchorTree('planning-anchor-unknown@example.com');
  await signIn(page, seed.email, seed.password);

  // A hand-edited / deleted / other-tenant key. The page swallows the failed
  // resolve into "no anchor", and the workspace must still open — at the root.
  await page.goto(anchoredHref('ANCH-9999'));

  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
  await expect(page.getByTestId('planning-target-node')).toHaveCount(0);
});
