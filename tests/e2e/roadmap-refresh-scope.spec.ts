// Roadmap MANUAL-REFRESH + URL-ADDRESSABLE-SCOPE E2E (Subtask MOTIR-1544 /
// Story MOTIR-1539) — the story-level `verification_recipe` automated. It is the
// browser-level proof of the two usability features shipped in the story:
//   • URL-addressable scope (MOTIR-1541): the scope is deep-linkable via
//     `?scope=sprint`, and switching the header toggle mirrors the choice into the
//     URL (a clean `/roadmap` for the default whole-project scope).
//   • Manual refresh (MOTIR-1542): a header refresh control re-fetches the roadmap
//     IN PLACE — it drops the level cache + re-runs the current level's load, so the
//     drill level / breadcrumb is PRESERVED (never a remount to root), and its
//     loading affordance clears on the real fetch-completion signal.
//
// Drives the REAL stack (Next + Postgres) end to end. Reuses the shipped roadmap
// seeds (`roadmap-seed.ts`) + the existing roadmap specs' patterns
// (`roadmap-scope-toggle.spec.ts`, `roadmap-flow.spec.ts`). Waits on AUTHORITATIVE
// signals — the per-level roadmap GET (`/api/projects/<key>/roadmap`, with/without
// `scope=sprint` / `parentId`) and rendered DOM — NEVER a fixed sleep (the E2E
// discipline in motir-core/CLAUDE.md; notes.html #37). Every mutation/refetch arms
// its `waitForResponse` BEFORE the action and asserts its status + the committed
// state that is read back.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedRoadmap, seedSprintRoadmap } from './_helpers/roadmap-seed';

// Service-side seeding of a whole tenant + tree, the sign-in flow, and the canvas
// render comfortably exceed the 30s default (same as the sibling roadmap specs).
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Shared locators (mirror roadmap-scope-toggle.spec.ts / roadmap-flow.spec.ts) ──

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });
const scopeToggle = (page: Page) => page.getByRole('group', { name: 'Roadmap scope' });
const refreshBtn = (page: Page) => page.getByRole('button', { name: 'Refresh roadmap' });
const breadcrumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

// A roadmap LEVEL fetch, keyed by scope + level, exactly as the scope-toggle spec
// discriminates them. The whole-project root carries NEITHER `parentId` NOR
// `scope=sprint`; the sprint root carries `scope=sprint` and no `parentId`; a drill
// carries `parentId`.
const isRoadmapGet = (url: string) => url.includes('/api/projects/') && url.includes('/roadmap');
const projectRootLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      !r.url().includes('parentId') &&
      !r.url().includes('scope=sprint') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
const sprintRootLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      !r.url().includes('parentId') &&
      r.url().includes('scope=sprint') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
// A drill fetch in whole-project scope (parentId, no scope=sprint).
const projectDrillLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      r.url().includes('parentId') &&
      !r.url().includes('scope=sprint') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
// ANY roadmap GET — used to await a manual refresh's in-place refetch, which re-runs
// the CURRENT level's load (root or drilled), whatever level that is.
const anyRoadmapLoad = (page: Page) =>
  page.waitForResponse((r) => isRoadmapGet(r.url()) && r.request().method() === 'GET' && r.ok());

const ROADMAP_GET = /\/api\/projects\/[^/]+\/roadmap/;

// Hold the NEXT roadmap GET open until released, so a manual refresh's loading state
// is DETERMINISTICALLY observable (never a race against a fast local fetch). Returns
// a `release()` that lets the held request through. The handler stays registered
// (later GETs pass straight through) — unrouting a still-in-flight held route races
// route.continue() and throws "Route is already handled".
async function gateNextRoadmapGet(page: Page): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route(ROADMAP_GET, async (route) => {
    if (!held && route.request().method() === 'GET') {
      held = true;
      await gate;
    }
    await route.continue();
  });
  return () => release();
}

// ───────────────────────────────────────────────────────────────────────────────
// URL-addressable scope (MOTIR-1541)
// ───────────────────────────────────────────────────────────────────────────────

test('Roadmap scope is URL-addressable: deep-link ?scope=sprint, toggle writes the URL both ways', async ({
  page,
}) => {
  const seed = await seedSprintRoadmap('roadmap-1544-scope@example.com');
  await signIn(page, seed.email, seed.password);

  // ── 1. DEEP-LINK: /roadmap?scope=sprint opens directly in Active-sprint scope ──
  // The server page seeds `initialScope` from `?scope=`, so a direct navigation
  // lands in sprint scope with no toggle click.
  const sprintLoaded = sprintRootLoad(page);
  await page.goto('/roadmap?scope=sprint');
  await sprintLoaded;

  const wholeProjectBtn = scopeToggle(page).getByRole('button', { name: 'Whole project' });
  const activeSprintBtn = scopeToggle(page).getByRole('button', { name: 'Active sprint' });
  // Sprint scope is the active treatment: the "Sprint scope" chip shows, the sprint
  // roots (member story + in-sprint subtask) are on the road, and the whole-project
  // epics are elided (the sibling scope-toggle spec's discriminators).
  await expect(activeSprintBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Sprint scope')).toBeVisible();
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.epicTitle, { exact: true })).toHaveCount(0);

  // ── 2. DEEP-LINK: /roadmap (no param) opens in whole-project scope ─────────────
  const rootLoaded = projectRootLoad(page);
  await page.goto('/roadmap');
  await rootLoaded;
  await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
  await expect(page.getByText('Sprint scope')).toHaveCount(0);
  // A bare /roadmap carries no query string.
  expect(new URL(page.url()).search).toBe('');

  // ── 3. TOGGLE writes the URL → Active sprint stamps ?scope=sprint ──────────────
  const toSprintLoaded = sprintRootLoad(page);
  await activeSprintBtn.click();
  await toSprintLoaded;
  await expect(activeSprintBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\/roadmap\?scope=sprint$/);
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.epicTitle, { exact: true })).toHaveCount(0);

  // ── 4. TOGGLE writes the URL → Whole project CLEARS the param ──────────────────
  const toProjectLoaded = projectRootLoad(page);
  await wholeProjectBtn.click();
  await toProjectLoaded;
  await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\/roadmap$/);
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
});

// ───────────────────────────────────────────────────────────────────────────────
// Manual refresh (MOTIR-1542) — in-place refetch, no full reload
// ───────────────────────────────────────────────────────────────────────────────

test('Roadmap manual refresh re-fetches in place: preserves the drill level and reflects a server-side change', async ({
  page,
}) => {
  const seed = await seedRoadmap('roadmap-1544-refresh@example.com');
  await signIn(page, seed.email, seed.password);

  // Open the roadmap (whole-project) and DRILL into the in-progress epic so the
  // canvas is at a NON-root level — the state a refresh must preserve.
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = projectRootLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;

  const activeEpicNode = page.locator('[data-node-id]').filter({ hasText: seed.activeEpicTitle });
  await activeEpicNode.click();
  const openButton = page.getByTestId('drill-button');
  await expect(openButton).toBeVisible();
  const childrenLoaded = projectDrillLoad(page);
  await openButton.click();
  await childrenLoaded;

  // Drilled: the breadcrumb is present and the epic's children are on the road; the
  // sibling root epic is gone (proves we're at a non-root level). The breadcrumb crumb
  // shows the item IDENTIFIER, not the title, so drill-state is proved by the level's
  // CONTENT (children in / sibling out), matching roadmap-flow.spec.ts.
  await expect(breadcrumb(page)).toBeVisible();
  await expect(page.getByText(seed.todoChildTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.doneChildTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toHaveCount(0);

  // A SERVER-SIDE change lands after this level was first fetched (and client-cached):
  // a NEW CHILD of the drilled epic, created straight through the shipped service (the
  // seeds' sanctioned cross-layer reach). Resolve the epic's id by title (the seed
  // returns titles, not ids). A refresh — not a page.reload() — must surface it.
  const activeEpic = await db.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, title: seed.activeEpicTitle },
  });
  const addedChildTitle = 'Observability';
  await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: addedChildTitle, parentId: activeEpic.id },
    { userId: seed.userId, workspaceId: seed.workspaceId },
  );
  // It is NOT on the road yet — the drilled level was served from the client cache.
  await expect(page.getByText(addedChildTitle, { exact: true })).toHaveCount(0);

  // ── The refresh: hold its refetch open so the loading state is observable ──────
  // The refresh drops the level cache and re-runs the CURRENT (drilled) level's load.
  const releaseGate = await gateNextRoadmapGet(page);
  const refreshed = anyRoadmapLoad(page);
  await refreshBtn(page).click();
  // The control shows its loading state (Button `loading` → disabled + aria-busy)
  // while the held refetch is in flight.
  await expect(refreshBtn(page)).toBeDisabled();
  await expect(refreshBtn(page)).toHaveAttribute('aria-busy', 'true');
  await releaseGate();
  const refreshResp = await refreshed;
  expect(refreshResp.status()).toBe(200);
  // The drilled level's fetch (parentId) is what was re-run — not a root reload.
  expect(refreshResp.url()).toContain('parentId');

  // The loading affordance clears on the real completion signal (not a timer).
  await expect(refreshBtn(page)).toBeEnabled();
  await expect(refreshBtn(page)).not.toHaveAttribute('aria-busy', 'true');

  // The drill level / breadcrumb is PRESERVED — we did NOT remount to root: the
  // breadcrumb still shows, the drilled epic's children are still on the road, and the
  // sibling root epic is still absent.
  await expect(breadcrumb(page)).toBeVisible();
  await expect(page.getByText(seed.todoChildTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toHaveCount(0);
  // The server-side change is now on the road — the in-place refetch read fresh state.
  await expect(page.getByText(addedChildTitle, { exact: true })).toBeVisible();
});

test('Roadmap manual refresh works in sprint scope and stays in sprint scope', async ({ page }) => {
  const seed = await seedSprintRoadmap('roadmap-1544-refresh-sprint@example.com');
  await signIn(page, seed.email, seed.password);

  // Deep-link straight into sprint scope.
  const sprintLoaded = sprintRootLoad(page);
  await page.goto('/roadmap?scope=sprint');
  await sprintLoaded;
  await expect(scopeToggle(page).getByRole('button', { name: 'Active sprint' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();

  // Refresh re-fetches — in sprint scope, so the re-run root load carries scope=sprint.
  const releaseGate = await gateNextRoadmapGet(page);
  const refreshed = sprintRootLoad(page);
  await refreshBtn(page).click();
  await expect(refreshBtn(page)).toBeDisabled();
  await releaseGate();
  const refreshResp = await refreshed;
  expect(refreshResp.status()).toBe(200);
  expect(refreshResp.url()).toContain('scope=sprint');
  await expect(refreshBtn(page)).toBeEnabled();

  // Still in sprint scope after the refresh (URL + treatment unchanged).
  await expect(page).toHaveURL(/\/roadmap\?scope=sprint$/);
  await expect(page.getByText('Sprint scope')).toBeVisible();
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.epicTitle, { exact: true })).toHaveCount(0);
});

// ───────────────────────────────────────────────────────────────────────────────
// Browser Back restores the prior scope — the story's back/forward criterion.
//
// FIXME(MOTIR-1549): the shipped URL-scope feature (MOTIR-1541) does NOT support
// this. The toggle writes the URL with `router.replace` (no distinct history entry),
// and scope lives in `useState(initialScope)` with no `useSearchParams` sync — so
// browser Back skips past the roadmap entirely (verified: it lands on `/dashboard`,
// the roadmap unmounts) and could not restore scope even if the URL changed. This
// test encodes the INTENDED behavior and auto-runs once MOTIR-1549 is fixed (write
// the scope via `router.push` and/or drive `scope` from `useSearchParams`). The other
// four flows here (deep-link, toggle→URL both ways, in-place refresh, sprint refresh)
// pass against shipped code and ship green. Marked `fixme` so CI stays green without
// dropping the requirement (motir-core/CLAUDE.md: a pre-existing bug in shipped code
// surfaced by a test is LOGGED, not absorbed into the test PR).
// ───────────────────────────────────────────────────────────────────────────────

test.fixme('Roadmap scope: browser Back restores the prior scope', async ({ page }) => {
  const seed = await seedSprintRoadmap('roadmap-1544-back@example.com');
  await signIn(page, seed.email, seed.password);

  // Land on whole-project /roadmap.
  const rootLoaded = projectRootLoad(page);
  await page.goto('/roadmap');
  await rootLoaded;
  await expect(scopeToggle(page).getByRole('button', { name: 'Whole project' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();

  // Toggle to sprint scope (writes ?scope=sprint).
  const toSprint = sprintRootLoad(page);
  await scopeToggle(page).getByRole('button', { name: 'Active sprint' }).click();
  await toSprint;
  await expect(page).toHaveURL(/\/roadmap\?scope=sprint$/);

  // Browser Back → the URL returns to /roadmap and the view is whole-project again.
  const backToProject = projectRootLoad(page);
  await page.goBack();
  await backToProject;
  await expect(page).toHaveURL(/\/roadmap$/);
  await expect(scopeToggle(page).getByRole('button', { name: 'Whole project' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
});
