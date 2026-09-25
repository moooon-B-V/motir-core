// Planning workspace — the ANCHOR reaches the CANVAS (Bug MOTIR-2070), and the
// canvas opens INSIDE it (MOTIR-6160, Story MOTIR-6154).
//
// Opening the planning workspace FROM a work item used to land the canvas on the
// project's ROOT level: the anchor was spent on the conversation (the pre-filled
// `@`-mention target + the MOTIR-909 thread) and dropped on the canvas, which
// seeded itself from `parentId = null`. MOTIR-2070 fixed that by seeding the
// anchor's ANCESTORS, so the workspace opened on the anchor's OWN level.
//
// ⚠️ MOTIR-6154 OVERTURNED THAT SECOND CHOICE. A person planning a story wants to
// look at the story's WORK while they talk about it, and at the level its
// proposals will land on — so a CONTAINER anchor now opens INSIDE itself, and the
// target stays named as the last crumb rather than ringed on a node one level up.
// A `subtask` has no inside, so it keeps MOTIR-2070's arrival and its ring: that
// is the first test below, and it is unchanged.
//
// This is the browser-level proof, on a REAL `epic → story → subtask` tree. The
// unit tests prove the rule (`tests/planning/surfaceArrival.test.ts`) and the
// overlay test proves the seam; only this proves what the user actually SEES.
//
// Drives the real stack (Next + Postgres). Waits on AUTHORITATIVE signals — the
// per-level roadmap GET (MOTIR-1010) and rendered DOM — never fixed sleeps
// (`motir-core/CLAUDE.md` § E2E discipline; `notes.html` #37).
import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree } from './_helpers/planning-anchor-seed';
import { SPLIT_MIN_CONTAINER_PX } from '@/lib/planning/railWidth';
import en from '@/messages/en.json';

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

test('a LEAF anchor (a subtask) opens on its OWN level, with the anchor ringed', async ({
  page,
}) => {
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

test('a CONTAINER anchor (a story) opens INSIDE it — its children, not its siblings', async ({
  page,
}) => {
  // ⚠️ THE ARRIVAL THIS STORY CHANGED (MOTIR-6160, Story MOTIR-6154), and the
  // sharpest statement of it: the story's own SIBLINGS are what the old rule put
  // on screen, and they are exactly what must not be here now.
  const seed = await seedPlanningAnchorTree('planning-anchor-story@example.com');
  await signIn(page, seed.email, seed.password);

  const arrived = drilledLevelLoad(page);
  await page.goto(anchoredHref(seed.storyKey));
  await arrived;

  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();

  // ── The level is the story's CHILDREN ─────────────────────────────────────
  await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
  await expect(canvasNode(page, seed.siblingTitle)).toBeVisible();
  // The story itself is NOT on the level — you are standing inside it, so it is
  // the crumb rather than a node. This is the assertion that fails under the old
  // ancestors-only trail, where the story was a node among its siblings.
  await expect(canvasNode(page, seed.storyTitle)).toHaveCount(0);
  await expect(canvasNode(page, 'Growth experiments')).toHaveCount(0);

  // ── The breadcrumb ENDS at the story — the level you are standing in ──────
  const breadcrumb = workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText(`${seed.epicKey} · ${seed.epicTitle}`);
  await expect(breadcrumb).toContainText(`${seed.storyKey} · ${seed.storyTitle}`);
  // MOTIR-2070's objection, answered: the target is still NAMED, as the current
  // crumb, rather than being a ring on a node that is no longer drawn.
  //
  // ⚠️ By ATTRIBUTE, not by a `getByRole` option: `current` is Testing Library's
  // role filter, and Playwright's takes no such key. The two APIs read alike and
  // are not the same, which `tsconfig.e2e.json` is what catches — the product
  // `tsconfig.json` does not include `tests/`, so only `pnpm typecheck` (the
  // solution build) sees this file at all.
  await expect(breadcrumb.locator('[aria-current="page"]')).toContainText(
    `${seed.storyKey} · ${seed.storyTitle}`,
  );

  // ── Back climbs out to the story's own level, where it sits among siblings ─
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(canvasNode(page, seed.storyTitle)).toBeVisible();
  await expect(canvasNode(page, seed.subtaskTitle)).toHaveCount(0);
});

test('a ROOT-level container anchor (an epic) opens inside it, on its stories', async ({
  page,
}) => {
  // ⚠️ REVERSED BY MOTIR-6160. This test asserted the opposite — "still opens at
  // the root, undrilled, with no breadcrumb at all" — because an epic is already
  // ON the root level and the ancestors-only trail was therefore empty. Under the
  // arrival rule an epic is a CONTAINER like any other: having no ancestors makes
  // its trail one crumb long, not zero.
  const seed = await seedPlanningAnchorTree('planning-anchor-epic@example.com');
  await signIn(page, seed.email, seed.password);

  const arrived = drilledLevelLoad(page);
  await page.goto(anchoredHref(seed.epicKey));
  await arrived;

  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
  // The epic's STORY is drawn; the epic and its root-level sibling are not.
  await expect(canvasNode(page, seed.storyTitle)).toBeVisible();
  await expect(canvasNode(page, seed.epicTitle)).toHaveCount(0);
  await expect(canvasNode(page, 'Growth experiments')).toHaveCount(0);

  // A one-crumb trail: the epic alone, as the level being stood in.
  const breadcrumb = workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText(`${seed.epicKey} · ${seed.epicTitle}`);
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

// ── BELOW THE SPLIT BREAKPOINT THE CANVAS STILL HAS A HEIGHT (Bug MOTIR-6276) ──
//
// Under `md` the frame is ONE column, canvas first and conversation below it —
// MOTIR-6249's sheet 9, which chose the stack because it is "the only layout that
// leaves either pane usable". As shipped it left the canvas unusable: the stacked
// grid had no row template, so its two IMPLICIT `auto` rows were sized from their
// content, and a canvas whose drawing area is `min-h-0 flex-1` contributes only its
// chrome. The transcript, which has real content height, took the rest — and the
// drawn level between the canvas's top bar and its footer came out zero pixels tall.
//
// Nothing about this is visible to `toBeVisible()`: the nodes are laid out, they are
// merely CLIPPED by a box with no height. So the proof is geometry — the canvas
// viewport's own box, and a node of the opened level inside it — read from the
// elements, never from a screenshot.
test('below the split breakpoint the panes STACK and the canvas keeps a real height', async ({
  page,
}) => {
  const seed = await seedPlanningAnchorTree('planning-anchor-narrow@example.com');
  // One pixel under the breakpoint the product itself uses — the first width at
  // which the frame is no longer a split. Read from the module, never typed.
  const narrow = { width: SPLIT_MIN_CONTAINER_PX - 1, height: 720 };
  await page.setViewportSize(narrow);
  await signIn(page, seed.email, seed.password);

  const arrived = drilledLevelLoad(page);
  await page.goto(anchoredHref(seed.subtaskKey));
  await arrived;

  const frame = workspace(page).getByTestId('planning-resizable-frame');
  const viewport = workspace(page).getByTestId('planning-canvas');
  const anchorNode = canvasNode(page, seed.subtaskTitle);
  await expect(anchorNode).toBeAttached();

  // ── A conversation that has been going for a while ─────────────────────────
  // The collapse needs a transcript TALLER than the frame's free space: a fresh
  // conversation is short, and with it the canvas still got a slice (154px at
  // 767×720, measured on the base commit). It was observed after a plan had been
  // proposed, i.e. several turns in. A persisted session cannot be seeded for a
  // CARD-anchored workspace from this lane (the session door writes the project
  // scope), and what the frame sizes from is only the transcript's content HEIGHT,
  // not what the content says. So a block as tall as the frame itself stands in for
  // those turns, appended to the REAL transcript. On the base commit this took the
  // canvas's drawing area to exactly 0px.
  const rail = page.getByRole('complementary', { name: 'Motir AI' });
  await rail.getByRole('log').evaluate((log) => {
    const turns = document.createElement('div');
    turns.dataset['testid'] = 'stand-in-earlier-turns';
    turns.style.height = `${window.innerHeight}px`;
    turns.style.flexShrink = '0';
    log.prepend(turns);
  });
  await expect(rail.getByTestId('stand-in-earlier-turns')).toBeAttached();

  // ── The canvas's drawing area has a height, and the opened level is IN it ──
  await expect
    .poll(async () => (await viewport.boundingBox())?.height ?? 0, {
      message: 'the stacked canvas viewport has a non-zero height',
    })
    .toBeGreaterThan(0);
  const canvasBox = (await viewport.boundingBox())!;
  const nodeBox = (await anchorNode.boundingBox())!;
  const nodeMidX = nodeBox.x + nodeBox.width / 2;
  const nodeMidY = nodeBox.y + nodeBox.height / 2;
  expect(nodeMidX).toBeGreaterThanOrEqual(canvasBox.x);
  expect(nodeMidX).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
  expect(nodeMidY).toBeGreaterThanOrEqual(canvasBox.y);
  expect(nodeMidY).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);

  // ── Still the design's stack: canvas first, conversation below, no divider ──
  const stacked = await frame.evaluate((el) => {
    const f = el.getBoundingClientRect();
    const c = el.children[0]!.getBoundingClientRect();
    const r = el.children[1]!.getBoundingClientRect();
    return {
      frame: f.width,
      canvas: c.width,
      chat: r.width,
      canvasBottom: c.bottom,
      chatTop: r.top,
    };
  });
  expect(stacked.chatTop).toBeGreaterThanOrEqual(stacked.canvasBottom - 1);
  expect(Math.abs(stacked.canvas - stacked.frame)).toBeLessThanOrEqual(1);
  expect(Math.abs(stacked.chat - stacked.frame)).toBeLessThanOrEqual(1);
  await expect(
    workspace(page).getByRole('separator', { name: en.planningWorkspace.dividerAria }),
  ).toHaveCount(0);

  // ── The conversation's composer and Send are still reachable ──────────────
  const composer = rail.getByRole('textbox');
  await composer.scrollIntoViewIfNeeded();
  await expect(composer).toBeInViewport();
  await expect(rail.getByRole('button', { name: 'Send' })).toBeInViewport();

  // ── At the breakpoint the frame is the unchanged split ─────────────────────
  await page.setViewportSize({ width: SPLIT_MIN_CONTAINER_PX, height: narrow.height });
  await expect(
    workspace(page).getByRole('separator', { name: en.planningWorkspace.dividerAria }),
  ).toBeVisible();
  const split = await frame.evaluate((el) => {
    const c = el.children[0]!.getBoundingClientRect();
    const r = el.children[1]!.getBoundingClientRect();
    return { canvasRight: c.right, chatLeft: r.left, canvasTop: c.top, chatTop: r.top };
  });
  expect(split.chatLeft).toBeGreaterThanOrEqual(split.canvasRight - 1);
  expect(Math.abs(split.chatTop - split.canvasTop)).toBeLessThanOrEqual(1);
});
