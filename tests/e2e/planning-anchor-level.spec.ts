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

// ⚠️ RE-POINTED FOR THE OVERLAY (MOTIR-4732, story MOTIR-4725). The planning
// workspace was a ROUTE at `/planning`; it is a full-screen OVERLAY on the page
// you are already on. So an address that used to BE the workspace is now a host
// page plus four namespaced parameters, and a `waitForURL` that matched the old
// path matches nothing. The assertions about what the workspace DOES are
// unchanged — only how it is reached and how its arrival is detected.
//
// (`/planning?…` still resolves: `app/(authed)/planning/page.tsx` forwards an old
// link to the host page it belonged to. Its own coverage is in
// `tests/integration/planning/planChangeSeams.test.ts`; these specs address the
// overlay directly, which is what a reader would write today.)

// Service-side seeding of a whole tenant + tree, the sign-in flow and the canvas
// render comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The address the per-item door writes — the overlay, over that item's page. */
const anchoredHref = (itemKey: string) =>
  `/items/${encodeURIComponent(itemKey)}?plan=contextual&planFrom=work-item&planItem=${encodeURIComponent(itemKey)}`;

/** The workspace itself — the shipped `Modal`, so a real `role=dialog`. */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });

/** A CANVAS node by its title. Scoped twice, and both scopes are load-bearing:
 *
 *  - to the canvas's NODE LAYER, because the anchor's title also appears in the
 *    chat's target chip and it is the CANVAS this bug is about;
 *  - ⚠️ and to the WORKSPACE, because an overlay leaves the host page MOUNTED
 *    underneath it (MOTIR-4725). Over `/roadmap` — which this file uses for the
 *    project-wide case — there are then TWO `planning-canvas` testids on the
 *    page, the roadmap's own and the workspace's, and an unscoped lookup is a
 *    strict-mode violation naming the same `data-node-id` twice. This is the
 *    locator hazard `motir-core/CLAUDE.md` records for a route-group boundary,
 *    in the shape an overlay gives it: `getByRole` is what disambiguates, so the
 *    scope is the dialog rather than a new testid. */
const canvasNode = (page: Page, title: string) =>
  workspace(page)
    .getByTestId('planning-canvas')
    .locator('[data-node-id]')
    .filter({ hasText: title });

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
  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
  // The anchor is on screen, without a single drill…
  await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
  // …and so is its SIBLING — which is what makes this the CONTAINING level rather
  // than the anchor's own children (that level holds neither).
  await expect(canvasNode(page, seed.siblingTitle)).toBeVisible();
  // The root level's epics are NOT drawn — the arrival is genuinely drilled.
  await expect(canvasNode(page, 'Growth experiments')).toHaveCount(0);

  // ── The breadcrumb reads as an ordinary drilled view ──────────────────────
  const breadcrumb = workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText(`${seed.epicKey} · ${seed.epicTitle}`);
  await expect(breadcrumb).toContainText(`${seed.storyKey} · ${seed.storyTitle}`);

  // ── The target ring is now on a level the user is actually looking at ─────
  const target = workspace(page).getByTestId('planning-target-node');
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
  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
  await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
  await expect(canvasNode(page, 'Growth experiments')).toBeVisible();
  await expect(workspace(page).getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
});

test('an UNRESOLVABLE ?item= opens the workspace at the root, never an error', async ({ page }) => {
  const seed = await seedPlanningAnchorTree('planning-anchor-unknown@example.com');
  await signIn(page, seed.email, seed.password);

  // A hand-edited / deleted / other-tenant key. The page swallows the failed
  // resolve into "no anchor", and the workspace must still open — at the root.
  await page.goto(anchoredHref('ANCH-9999'));

  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
  await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
  await expect(workspace(page).getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
  await expect(workspace(page).getByTestId('planning-target-node')).toHaveCount(0);
});

// The workspace contains a door back INTO itself: the canvas's own quick-view
// peek carries the same per-item Plan / Re-plan entrance (MOTIR-910), so that
// launch is a SAME-ROUTE navigation (`/planning?item=A` → `?item=B`) rather than
// a navigation into the route. The host is reconciled in place, so nothing it
// seeds in a `useState` initializer re-runs — the canvas stayed on whatever level
// it was on and the target set came up empty, while the chrome switched to the
// new item (MOTIR-2076). The other entrances could never catch this, and neither
// could a `page.goto`: only clicking the in-app door reproduces it.
test('re-entering from the canvas’s OWN peek re-seeds the level and the target', async ({
  page,
}) => {
  const seed = await seedPlanningAnchorTree('planning-anchor-reentry@example.com');
  await signIn(page, seed.email, seed.password);

  // Open project-scoped (root level) and drill to the story, so a deep item is on
  // screen to peek at — and so the canvas has a level it would WRONGLY keep.
  await page.goto('/roadmap?plan=replan&planFrom=project');
  await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
  await canvasNode(page, seed.epicTitle).click();
  await workspace(page).getByTestId('drill-button').click();
  await expect(canvasNode(page, seed.storyTitle)).toBeVisible();

  // …then drill once more, so the peeked item's own level is NOT the level the
  // canvas is currently on. Without the remount the canvas simply stays here.
  await canvasNode(page, seed.storyTitle).click();
  await workspace(page).getByTestId('drill-button').click();
  await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();

  // Peek the SUBTASK from inside the workspace and take its Plan door.
  await canvasNode(page, seed.subtaskTitle).click();
  await page.getByTestId('view-button').click();
  const entrance = page.getByTestId('work-item-plan-entrance');
  await expect(entrance).toBeVisible();
  await entrance.click();

  await page.waitForURL((url) => url.searchParams.get('planItem') === seed.subtaskKey);

  // The canvas re-seeded on the new anchor: its level, its ring…
  const target = workspace(page).getByTestId('planning-target-node');
  await expect(target).toBeVisible();
  await expect(target).toContainText(seed.subtaskTitle);
  await expect(canvasNode(page, seed.siblingTitle)).toBeVisible();
  const breadcrumb = workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toContainText(`${seed.storyKey} · ${seed.storyTitle}`);
  // …and the chat's target tray, which the same stale-seed bug left empty.
  await expect(workspace(page).getByTestId('planning-target-chip')).toContainText(seed.subtaskKey);
});
