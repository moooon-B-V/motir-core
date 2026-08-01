// Roadmap AUTO-DRILL acceptance E2E (Subtask MOTIR-1809 / Story MOTIR-1803) —
// the browser-level proof that a sprint whose work all sits under ONE story opens
// on the WORK, not on one lonely card, AND this story's acceptance receipt.
//
// It runs in the ACCEPTANCE lane (`playwright.acceptance.config.ts`, video:'on'),
// not the bulk shards: this is the story's closing E2E, so it IS the story's
// acceptance test (notes.html — the MOTIR-906 lesson). Hence the
// `acceptance*.spec.ts` name that lane's `testMatch` discovers, the
// `_helpers/acceptance-video` import (not plain `@playwright/test`), the
// `acceptanceStory('MOTIR-1803')` declaration that publishes the clip to THIS
// story, and `chapter()` markers on the recorded happy path. No new workflow —
// the acceptance leg already exists in `ci.yml`.
//
// THE FLOW (the story's `verification_recipe`):
//   1. Open /roadmap — Whole project, the multi-epic road.
//   2. Switch to Active sprint → the canvas arrives ALREADY DRILLED on the
//      story's subtasks, with the skipped story in the breadcrumb.
//   3. Click the breadcrumb root → the single-parent level renders AND STAYS
//      (the re-descend trap; it must survive a manual refresh too).
//   4. Switch back to Whole project → the multi-root level, no descend.
// Plus a MULTI-ROOT negative control, so the feature can never become "always
// drill into the first thing".
//
// The fixture's project is ONBOARDED (MOTIR-1824), so every root level it renders
// also carries the pinned planning-origin cluster. That is deliberate: while the
// descent counted a level's whole node array, the cluster made the sprint root two
// nodes and this feature did nothing at all for an onboarded project — the shape
// this spec could not cover until the count became "the level's WORK".
//
// AUTHORITATIVE SIGNALS ONLY — no fixed-duration sleep anywhere in this file.
// Each level is a roadmap GET, and the auto-descend adds a SECOND fetch (the
// `parentId` drill) before the final paint, so waiting on the scope switch's ROOT
// response alone would assert against the intermediate single-card level and pass
// for the wrong reason. Every step awaits the response of the level it lands ON.
// The `chapter()`/`beat()` holds are the harness's VIDEO PACING, taken only after
// the assertions above them have already proven the state (see the note on
// CHAPTER_HOLD_MS in `_helpers/acceptance-video.ts`) — never synchronisation.

import { test, expect } from './_helpers/acceptance-video';
import type { Page, Request } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedSingleStorySprintRoadmap, seedSprintRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

const scopeToggle = (page: Page) => page.getByRole('group', { name: 'Roadmap scope' });
const breadcrumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

// A roadmap LEVEL fetch, by scope + level (the same predicates the shipped
// scope-toggle spec uses): the whole-project root carries NEITHER `parentId` NOR
// `scope=sprint`; the sprint root carries `scope=sprint` and no `parentId`; a
// sprint DRILL — which is what the auto-descend issues — carries both.
const isRoadmapGet = (url: string) => url.includes('/api/projects/') && url.includes('/roadmap');
const isSprintDrill = (url: string) =>
  isRoadmapGet(url) && url.includes('parentId') && url.includes('scope=sprint');

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
  page.waitForResponse((r) => isSprintDrill(r.url()) && r.request().method() === 'GET' && r.ok());

/** Pin the active WORKSPACE too: the page resolves its workspace from the active
 *  project, but a `getWorkspaceContext`-gated request resolves from this cookie
 *  (falling back to "the user's first workspace" when unset). */
async function pinWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'workspace_id', value: workspaceId, domain: 'localhost', path: '/' }]);
}

test('roadmap auto-drill — a single-story sprint opens on its subtasks, and the skipped level stays put once you climb to it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1803');

  const seed = await seedSingleStorySprintRoadmap('roadmap-auto-drill@example.com');
  await signIn(page, seed.email, seed.password);
  await pinWorkspace(page, seed.workspaceId);

  const wholeProjectBtn = scopeToggle(page).getByRole('button', { name: 'Whole project' });
  const activeSprintBtn = scopeToggle(page).getByRole('button', { name: 'Active sprint' });
  const storyCrumb = breadcrumb(page).getByRole('button', {
    name: `${seed.storyIdentifier} · ${seed.storyTitle}`,
  });

  // ── 1. The whole-project road: several epics, nothing drilled ───────────────
  await chapter('Open the roadmap', async () => {
    const nav = roadmapNav(page);
    await expect(nav).toBeVisible();
    const rootLoaded = projectRootLoad(page);
    await nav.click();
    await page.waitForURL('**/roadmap');
    await rootLoaded;

    await expect(page.getByTestId('planning-canvas')).toBeVisible();
    await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toBeVisible();
    // Multi-root ⇒ no descend: the breadcrumb overlay is not even mounted.
    await expect(breadcrumb(page)).toHaveCount(0);
    await beat();
  });

  // ── 2. Active sprint → the canvas ARRIVES already drilled ──────────────────
  // THE load-bearing beat. The sprint's root level is a single drillable node
  // (the member story); the canvas descends instead of rendering it, so what
  // paints is the story's SUBTASKS. Both fetches are armed before the click —
  // the sprint root, then the auto-descend's drill — and the drill is the
  // settled-level signal we assert against.
  await chapter('Switch to the active sprint — it opens on the work', async () => {
    const sprintRootLoaded = sprintRootLoad(page);
    const autoDescended = sprintDrillLoad(page);
    await activeSprintBtn.click();
    await sprintRootLoaded;
    await autoDescended;

    await expect(activeSprintBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Sprint scope')).toBeVisible();

    // The story's subtasks — the level that actually holds the work.
    for (const title of seed.subtaskTitles) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
    // The seeded project is ONBOARDED (MOTIR-1824), so the level we descended
    // FROM held the pinned planning-origin cluster beside the lone story. That
    // second node is what used to make this level "not single" and stop the
    // descent dead; landing here at all is the browser-level proof it no longer
    // counts. (It belongs to the root level only, so it is gone from this one.)
    await expect(page.getByTestId('planning-origin')).toHaveCount(0);
    // …and the skipped story is NOT rendered as a card; it is in the breadcrumb.
    // Asserting node count alone would pass on any unrelated level, so this
    // pins the ancestor by name too (`Roadmap › <identifier · title>`).
    await expect(page.getByText(seed.storyTitle, { exact: true })).toHaveCount(0);
    await expect(breadcrumb(page)).toBeVisible();
    await expect(
      breadcrumb(page).getByRole('button', { name: 'Roadmap', exact: true }),
    ).toBeVisible();
    await expect(storyCrumb).toBeVisible();
    await expect(storyCrumb).toHaveAttribute('aria-current', 'page');
    await beat();
  });

  // ── 3. The skipped level is one click away — and it STAYS ──────────────────
  // The re-descend trap: if auto-descend fired again after an explicit climb, the
  // user would be thrown straight back down and the breadcrumb root would become
  // unclickable. This is the case most likely to regress, so it is proven THREE
  // ways, none of them a sleep:
  //
  //  (a) THE LEVEL PAINTS AT ALL. The auto-descend deliberately does not publish
  //      the level it skips (`setLevel` is not called before it descends), so a
  //      single-parent level that RENDERS its lone card is itself proof the
  //      canvas chose to stay — a re-descending canvas would keep the drilled
  //      level up and never paint this one.
  //  (b) THE REFRESH REFETCHES *THIS* LEVEL. The manual refresh re-runs the load
  //      for whatever level the canvas is CURRENTLY on, so the request it issues
  //      names that level: no `parentId` ⇒ still the single-parent root. Awaiting
  //      a root-shaped response after the refresh click is therefore a direct
  //      assertion about where the canvas sits, not just a wait.
  //  (c) NO DRILL REQUEST IS ISSUED after the climb. Asserted at the very end,
  //      after step 4's fetch has resolved — an ordering barrier, since any
  //      re-descend would have had to fire long before that.
  //
  // NOTE the deliberate absence of a response wait on the crumb click itself:
  // `WorkItemRoadmap` memoises each level per `projectKey:scope:parentId`, so
  // climbing back to a level already visited this refresh generation is served
  // from cache and makes NO request. Awaiting one would hang forever. The
  // authoritative signal there is the DOM (a), which no other level can produce.
  const drillsAfterClimb: string[] = [];
  const recordDrill = (req: Request) => {
    if (req.method() === 'GET' && isSprintDrill(req.url())) drillsAfterClimb.push(req.url());
  };
  page.on('request', recordDrill);

  await chapter('Climb to the skipped level — and it sits still', async () => {
    await breadcrumb(page).getByRole('button', { name: 'Roadmap', exact: true }).click();

    // (a) The single-parent level: the lone story card, no subtasks, no breadcrumb
    // — and, pinned beside it, the planning-origin cluster this onboarded project
    // draws (MOTIR-1824). Seeing BOTH here is the level whose two nodes used to
    // suppress the descent, now rendered only because the user asked for it.
    await expect(page.getByText(seed.storyTitle, { exact: true })).toBeVisible();
    await expect(page.getByTestId('planning-origin')).toBeVisible();
    await expect(page.getByText(seed.subtaskTitles[0], { exact: true })).toHaveCount(0);
    await expect(breadcrumb(page)).toHaveCount(0);
    await beat();

    // (b) A manual refresh (which clears the level cache, so this one IS a real
    // fetch) must not re-descend out from under someone who deliberately climbed
    // up — the refresh row of the design's re-descend table (refresh: no ·
    // explicit drill: yes · scope switch: yes).
    const refreshed = sprintRootLoad(page);
    await page.getByRole('button', { name: 'Refresh roadmap' }).click();
    await refreshed;
    await expect(page.getByText(seed.storyTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(seed.subtaskTitles[0], { exact: true })).toHaveCount(0);
    await expect(breadcrumb(page)).toHaveCount(0);
    await beat();
  });

  // ── 4. Back to Whole project → the multi-root level, no descend ────────────
  await chapter('Back to the whole project', async () => {
    const backToProject = projectRootLoad(page);
    await wholeProjectBtn.click();
    await backToProject;

    await expect(wholeProjectBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(seed.epicTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(seed.otherEpicTitle, { exact: true })).toBeVisible();
    await expect(breadcrumb(page)).toHaveCount(0);
  });

  // (c) Nothing tried to descend again at any point after the climb.
  page.off('request', recordDrill);
  expect(drillsAfterClimb).toEqual([]);
});

// The NEGATIVE CONTROL — the assertion that stops this feature from degrading
// into "always drill into the first thing". `seedSprintRoadmap` is the shipped
// multi-root sprint fixture (MOTIR-1384): its sprint scope resolves to TWO
// top-in-sprint roots — a member story (drillable) and an in-sprint subtask of a
// non-member story — so a level that offers a real choice must be left alone even
// though its first node is drillable. Not chaptered and not pinned to the story:
// the recorded acceptance clip is the happy path above (the harness's
// "call acceptanceStory once, in the recorded happy path" contract).
test('roadmap auto-drill — a multi-root sprint is left untouched', async ({ page }) => {
  const seed = await seedSprintRoadmap('roadmap-auto-drill-multi@example.com');
  await signIn(page, seed.email, seed.password);

  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = projectRootLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;

  // Any drill request here would BE the regression, so record from the start.
  const drills: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'GET' && isSprintDrill(req.url())) drills.push(req.url());
  });

  const sprintLoaded = sprintRootLoad(page);
  await scopeToggle(page).getByRole('button', { name: 'Active sprint' }).click();
  await sprintLoaded;

  // BOTH roots render as themselves — the canvas descended into neither. That
  // they PAINT at all is the decisive signal: a descending canvas never publishes
  // the level it skips, so a rendered multi-root level cannot be a pre-descend
  // frame that a later fetch would replace.
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.memberSubtaskTitle, { exact: true })).toBeVisible();
  // …and the member story's child (what a wrongful descend would have shown) is not here.
  await expect(page.getByText(seed.memberStoryChildTitle, { exact: true })).toHaveCount(0);
  await expect(breadcrumb(page)).toHaveCount(0);

  // A manual refresh refetches whichever level the canvas is on, so a root-shaped
  // request is a direct assertion that it is still at the root — and it doubles as
  // the ordering barrier that makes the "no drill was ever requested" check below
  // meaningful rather than racy.
  const refreshed = sprintRootLoad(page);
  await page.getByRole('button', { name: 'Refresh roadmap' }).click();
  await refreshed;
  await expect(page.getByText(seed.memberStoryTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.memberSubtaskTitle, { exact: true })).toBeVisible();
  await expect(breadcrumb(page)).toHaveCount(0);
  expect(drills).toEqual([]);
});
