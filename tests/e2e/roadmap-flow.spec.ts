// Roadmap view E2E (Subtask 7.20.8 / MOTIR-1015) — the browser-level proof of
// the project Roadmap view (Story 7.20): reach it from the "Roadmap" PRIMARY
// LEFT-NAV entry (the access path — NOT a Board↔Roadmap toggle, per the
// MOTIR-1011 correction / notes.html #99/#100), see the epics on the road with
// the MOTIR-1013 markers (the planning-origin cluster, the "you are here"
// frontier, a per-epic progress meter), DRILL into an epic to its children and
// come BACK via the breadcrumb, and confirm both the EMPTY and POPULATED states.
//
// Drives the REAL stack (Next + Postgres) end to end. The fixture seeds a whole
// tenant + roadmap tree through the shipped services (roadmap-seed.ts). Waits on
// AUTHORITATIVE signals — the per-level roadmap GET (`/api/projects/<key>/roadmap`,
// MOTIR-1010) and rendered DOM state — never fixed sleeps (the E2E discipline in
// motir-core/CLAUDE.md; notes.html #37). NB: levels are CLIENT-CACHED, so the
// drill (a cache miss) awaits its fetch, but going BACK to root is a cache hit
// (no network) — there we await the authoritative DOM state, not a response.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedRoadmap, seedEmptyRoadmapProject } from './_helpers/roadmap-seed';

// Service-side seeding of a whole tenant + tree, the sign-in flow, and the
// canvas render comfortably exceed the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The "Roadmap" primary left-nav entry (scoped to the Primary nav so it never
// collides with the page's own <h1>Roadmap</h1>).
const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

// A roadmap LEVEL fetch — the root level (no `parentId`) or a drill (`parentId=…`).
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

test('Roadmap: open from the left-nav entry, see the markers, drill into an epic and back', async ({
  page,
}) => {
  const seed = await seedRoadmap('roadmap-view@example.com');
  await signIn(page, seed.email, seed.password);

  // ── 1. Reach the roadmap via the "Roadmap" PRIMARY LEFT-NAV entry ──────────
  // Arm the root-level fetch BEFORE the click so we wait on the authoritative
  // load, never the optimistic first paint.
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = rootLevelLoad(page);
  await nav.click();

  // Route + active nav state (the access-path assertion).
  await page.waitForURL('**/roadmap');
  await expect(nav).toHaveAttribute('aria-current', 'page');
  await rootLoaded;

  // ── 2. The populated road: the canvas + the MOTIR-1013 markers ─────────────
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  // The planning-origin cluster pinned at the road's start.
  await expect(page.getByTestId('planning-origin')).toBeVisible();
  // The two root epics on the road.
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toBeVisible();
  // The "you are here" frontier marker on the in-progress epic.
  await expect(page.getByText('You are here')).toBeVisible();
  // A per-epic subtree progress meter (the in-progress epic has done + to-do
  // children, so its meter is present).
  await expect(page.getByRole('progressbar', { name: 'Subtree progress' }).first()).toBeVisible();

  // ── 3. Drill into the in-progress epic ─────────────────────────────────────
  // Clicking a node SELECTS it (the drill is the explicit "Open" affordance that
  // then appears on the selected card).
  const activeEpicNode = page.locator('[data-node-id]').filter({ hasText: seed.activeEpicTitle });
  await activeEpicNode.click();

  const openButton = page.getByTestId('drill-button');
  await expect(openButton).toBeVisible();

  // The drill is a per-level fetch (cache miss) → wait on its 200 before
  // asserting the children.
  const childrenLoaded = drillLevelLoad(page);
  await openButton.click();
  await childrenLoaded;

  // The breadcrumb appears, and the epic's children are now on the road; the
  // sibling epic from the root level is gone.
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(page.getByText(seed.todoChildTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.doneChildTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toHaveCount(0);

  // ── 4. Back to the root via the breadcrumb ─────────────────────────────────
  // Going back is a client cache HIT (no network), so we await the authoritative
  // DOM state: the breadcrumb collapses and the root epics return.
  await breadcrumb.getByRole('button', { name: 'Back' }).click();
  await expect(breadcrumb).toHaveCount(0);
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toBeVisible();
});

test('Roadmap: empty project shows the empty state', async ({ page }) => {
  const seed = await seedEmptyRoadmapProject('roadmap-empty@example.com');
  await signIn(page, seed.email, seed.password);

  // Same access path — the left-nav entry — for the empty project.
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  await nav.click();
  await page.waitForURL('**/roadmap');
  await expect(nav).toHaveAttribute('aria-current', 'page');

  // The empty state is SERVER-rendered (the page reads the root level and, when
  // empty, renders the EmptyState instead of mounting the canvas) — so it is
  // present without any client fetch to race.
  await expect(page.getByText('Nothing on the roadmap yet')).toBeVisible();
  await expect(page.getByText(/Work items will appear here as the plan takes shape/)).toBeVisible();
  // The populated-canvas affordances are absent.
  await expect(page.getByTestId('planning-canvas')).toHaveCount(0);
});
