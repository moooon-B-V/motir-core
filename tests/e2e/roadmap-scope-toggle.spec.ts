// Roadmap SCOPE-TOGGLE E2E (Subtask MOTIR-1384 / Story MOTIR-1379) — the
// browser-level proof of the sprint-scope toggle: reach /roadmap, default to
// Whole project (full tree), switch to Active sprint (the canvas re-roots at the
// TOPMOST in-sprint items — a member story + the in-sprint subtask of a non-member
// story, with the epics elided), drill a member root, switch back (the full tree
// returns), and the no-active-sprint empty state.
//
// Drives the REAL stack (Next + Postgres). Waits on AUTHORITATIVE signals — the
// per-level roadmap GET (`/api/projects/<key>/roadmap`, with/without `scope=sprint`
// and `parentId`) and rendered DOM — never fixed sleeps (the E2E discipline in
// motir-core/CLAUDE.md; notes.html #37). Selectors key off the shipped i18n labels
// ("Whole project" / "Active sprint"), scoped to the toggle group so they never
// collide. Switching scope REMOUNTS the canvas (client island) → a fresh root
// fetch in the new scope, which we await; the no-active-sprint case is client-only
// (the empty state, no fetch), so there we await the authoritative DOM.

import { expect, test, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSprintRoadmap, seedRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

const scopeToggle = (page: Page) => page.getByRole('group', { name: 'Roadmap scope' });

// A roadmap LEVEL fetch, by scope + level. The whole-project root carries NEITHER
// `parentId` NOR `scope=sprint`; the sprint root carries `scope=sprint` and no
// `parentId`; a sprint drill carries both.
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
const sprintDrillLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      isRoadmapGet(r.url()) &&
      r.url().includes('parentId') &&
      r.url().includes('scope=sprint') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('Roadmap scope: Whole project → Active sprint narrows the canvas, drill, and back', async ({
  page,
}) => {
  const seed = await seedSprintRoadmap('roadmap-scope@example.com');
  await signIn(page, seed.email, seed.password);

  // ── 1. Default scope = Whole project: the full root level ──────────────────
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = projectRootLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;

  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  const wholeProjectBtn = scopeToggle(page).getByRole('button', { name: 'Whole project' });
  const activeSprintBtn = scopeToggle(page).getByRole('button', { name: 'Active sprint' });
  await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
  // Both epics on the road in whole-project scope.
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.backlogEpicTitle, { exact: true })).toBeVisible();

  // ── 2. Switch to Active sprint → the canvas re-roots at the TOPMOST members ──
  const sprintLoaded = sprintRootLoad(page);
  await activeSprintBtn.click();
  await sprintLoaded;
  await expect(activeSprintBtn).toHaveAttribute('aria-pressed', 'true');
  // The sprint subtitle marks the scope.
  await expect(scopeToggle(page)).toBeVisible();
  await expect(page.getByText('Sprint scope')).toBeVisible();
  // Roots = the member story + the in-sprint subtask of the non-member story.
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.memberSubtaskTitle, { exact: true })).toBeVisible();
  // The epics and the non-member parent story are elided (never "pulled in").
  await expect(page.getByText(seed.epicTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(seed.backlogEpicTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(seed.nonMemberStoryTitle, { exact: true })).toHaveCount(0);

  // ── 3. Drill the member-story root → its NORMAL (unscoped) child shows ──────
  const memberNode = page.locator('[data-node-id]').filter({ hasText: seed.memberStoryTitle });
  await memberNode.click(); // select → reveals the Open affordance
  const openButton = page.getByTestId('drill-button');
  await expect(openButton).toBeVisible();
  const drilled = sprintDrillLoad(page);
  await openButton.click();
  await drilled;
  await expect(page.getByText(seed.memberStoryChildTitle, { exact: true })).toBeVisible();

  // ── 4. Switch back to Whole project → the full tree returns ────────────────
  const backToProject = projectRootLoad(page);
  await wholeProjectBtn.click();
  await backToProject;
  await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.backlogEpicTitle, { exact: true })).toBeVisible();
});

test('Roadmap scope: with no active sprint, Active sprint shows the empty state; default unaffected', async ({
  page,
}) => {
  // A POPULATED project with NO active sprint (seedRoadmap creates no sprint).
  const seed = await seedRoadmap('roadmap-no-sprint@example.com');
  await signIn(page, seed.email, seed.password);

  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = projectRootLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();

  // Switch to Active sprint → no sprint running → the no-active-sprint empty state
  // (client-only; the canvas is not mounted, so there is no fetch to await).
  await scopeToggle(page).getByRole('button', { name: 'Active sprint' }).click();
  await expect(page.getByText('No active sprint')).toBeVisible();
  await expect(
    page.getByText(/Start a sprint from the board to see its slice of the roadmap/),
  ).toBeVisible();
  await expect(page.getByTestId('planning-canvas')).toHaveCount(0);

  // Default scope is unaffected — switching back restores the full tree.
  const backToProject = projectRootLoad(page);
  await scopeToggle(page).getByRole('button', { name: 'Whole project' }).click();
  await backToProject;
  await expect(page.getByText(seed.activeEpicTitle, { exact: true })).toBeVisible();
});
