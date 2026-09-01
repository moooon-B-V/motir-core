import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { plansService } from '@/lib/services/plansService';

import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPlansSurface,
  APPROVED_PLAN_COUNT,
  PLANS_SURFACE_PASSWORD,
} from './_helpers/plans-surface-seed';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

// ACCEPTANCE — the PLANS LIST, refined (Story MOTIR-3232 · Subtask MOTIR-3243).
// The story's verification recipe, steps 1–6, driven through the real stack, and
// recorded as the receipt Yue watches to accept the list half of the story.
//
// ⚠️ IT SITS BESIDE `plans-review.spec.ts`, and does not extend it — a decision
// the card asks to be stated rather than assumed. That spec is Story 7.21's
// proof of the REVIEW journey: a stale plan, the approve-anyway confirm, the
// decline branch. Every assertion in it is still true and still wanted, and
// none of it is about a tab, a page boundary, an attribution or a view switch.
// Folding this story's legs into it would have made one 400-line spec whose
// failure names neither story, on a fixture that has to satisfy both — and the
// receipt half cannot live there at all, because that spec is not in this lane.
//
// ⚠️ AND THE OTHER BOUNDARY: recipe steps 7–8 — the canvas arriving where the
// plan is, the Show-changes control, the list-by-default rule for a plan that
// straddles containers — belong to the SIBLING spec (MOTIR-3263) and to nothing
// here. This file touches the plan detail exactly once, for the SWITCHER, on a
// plan deliberately seeded under a SINGLE parent so its default view is the
// canvas and the leg tests the control rather than the sibling's default rule.
// The story's receipt is therefore TWO clips, one from each card's own run.
//
// ── The two tests, and why they are two ──────────────────────────────────────
//
// The first is the RECORDING: steps 1–6, paced for a person, chaptered. The
// second is the pageerror sweep and the empty / concurrent-decision states — it
// runs at a 600px-high viewport and resizes a list mid-flight, which is a thing
// to ASSERT and not a thing to watch. Recording it would put a jarring
// window-shrink in the middle of the receipt and teach a reviewer nothing about
// the story. Only the first calls `chapter()`, so only the first writes the
// sidecars the uploader globs for — the second is a test, not a take.
//
// DETERMINISM: every wait is on an authoritative signal — a row count, a URL, a
// response, a rendered outcome. There is no bare timeout in this file. The two
// PACING helpers (`chapter`'s hold and `beat()`) are not waits and never stand
// in for one: each runs AFTER the assertion that already proved the state, and
// removing every one of them leaves the assertions identical. See the note at
// `CHAPTER_HOLD_MS` in `_helpers/acceptance-video.ts`.

// ⚠️ THE BUDGET IS THE SEED, not the walk, and it is VOLATILE. Each test mints a
// tenant and takes TWENTY-TWO plans through `createPlan → addProposals →
// markPlanned → approvePlan` — every one a real transaction, every approve a real
// materialization — because the paging leg needs more than two cursor pages in
// ONE status and there is no cheaper way to get them through the shipped
// services. Measured locally against a production build: **3.0 minutes for the
// whole file** on a quiet box, where the recorded walk's own ~60s of pacing is
// the largest single item. But every materialized work item emits an embedding
// job, motir-ai is a dead host in this lane, and the executor retries — so on a
// runner already holding a backlog the same seed took THREE TIMES as long. The
// ceiling is set for that case rather than for the good one. A timeout is a
// CEILING, not a wait: a green run pays nothing for the headroom.
test.describe.configure({ timeout: 900_000 });

/** The clip's viewport. Wide enough for the top bar to render its Plan-with-AI
 *  pill (it is `hidden md:inline-flex`), which step 6 asserts is the ONLY one. */
const CLIP_VIEWPORT = { width: 1280, height: 720 };

/** The states test's viewport — SHORT on purpose (the card's ~600px).
 *
 *  ⚠️ THE HEIGHT IS THE INSTRUMENT. `<main>` is the only scroller on a signed-in
 *  surface (`AppLayout`), so a short one is what makes a ten-row page overflow
 *  it, `useRowWindow` window rather than degrade to render-all, and the bottom
 *  sentinel sit below the fold instead of firing on mount. All three of those
 *  are conditions this file's assertions depend on. */
const SHORT_VIEWPORT = { width: 1280, height: 600 };

/**
 * Every uncaught client error the page threw, for the WHOLE test.
 *
 * ⚠️ THIS IS THE ASSERTION THE SPEC EXISTS FOR (MOTIR-3241). A virtualized list
 * that SHRINKS — thirty rows deep in `Approved`, then a two-row tab — renders one
 * frame against `useRowWindow`'s previous, larger window, and an unguarded
 * `views[index]!` there takes the whole page down. **A happy-dom component test
 * cannot reach it**: with no measurable viewport the hook degrades to render-all,
 * `indices` is always in range, and the test passes green while a real browser
 * crashes. Only a real viewport with enough rows to window can fail.
 *
 * So it is registered on EVERY test in the file rather than around the one leg:
 * a page error anywhere in this walk is a finding, and scoping the listener to
 * the leg that was expected to produce one is how the next one gets missed.
 */
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack ?? ''}`));
});

test.afterEach(() => {
  expect(pageErrors, `uncaught client errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
});

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Locators, by role and accessible name wherever the design gives one ───────
//
// A copy change then fails loudly instead of silently selecting nothing — the
// card asks for this explicitly, and the tab strip is where it matters most:
// `PlanStatusTabs` is a labelled GROUP of `aria-pressed` buttons, deliberately
// not an ARIA tablist (the rows are a URL-addressable filter, not a tabpanel),
// so `getByRole('tab')` would find zero and read as "the strip is gone".

const tabStrip = (page: Page) => page.getByRole('group', { name: 'Filter plans by status' });
const tab = (page: Page, name: string) => tabStrip(page).getByRole('button', { name });
const planRows = (page: Page) => page.getByRole('list', { name: 'Plans' }).getByRole('listitem');
const rowFor = (page: Page, planId: string) => page.locator(`a[href="/plans/${planId}"]`);

/** Scroll `<main>` — the shell's one scroller — to its bottom. An ACTION, and the
 *  signal it produces is awaited by the caller. */
async function scrollMainToBottom(page: Page): Promise<void> {
  await page.locator('#main').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
}

/**
 * Back to the top of the list.
 *
 * ⚠️ REQUIRED BEFORE READING A ROW NEAR THE TOP, and `scrollIntoViewIfNeeded` is
 * NOT a substitute: a row outside `useRowWindow`'s window is not in the DOM at
 * all, so the locator has nothing to scroll and simply waits until the whole test
 * times out. The scroller has to move FIRST; the row mounts because of it.
 */
async function scrollMainToTop(page: Page): Promise<void> {
  await page.locator('#main').evaluate((el) => el.scrollTo({ top: 0 }));
}

/** The next cursor page's server action landing — the authoritative signal that
 *  a streamed page has arrived, armed BEFORE the scroll that triggers it.
 *
 *  ⚠️ USE IT ONLY FOR THE FIRST LOAD, where the assertion right before it has
 *  just proved nothing is in flight. Once rows are streaming, a load can start
 *  before the wait is armed and the wait then sits out a request that already
 *  happened — so every LATER page is awaited on the OLDEST ROW instead
 *  ({@link loadWholeHistory}), which is equally authoritative and cannot be missed. */
function nextPageLanded(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/plans') && res.ok(),
  );
}

/**
 * Scroll until the list has streamed its whole history — proved by the OLDEST
 * seeded plan's row existing.
 *
 * ⚠️ A ROW COUNT CANNOT ANSWER THIS, and the reason is the very mechanism the
 * pageerror leg exists for: the list is VIRTUALIZED, so the DOM holds the rows
 * in the WINDOW and never all of the loaded ones. `toHaveCount(22)` measures the
 * window (13 of them at this viewport) and reads as *"the pages never arrived"*
 * when every page has in fact arrived. The oldest row is a fact about what has
 * been LOADED, and it is the last row there is.
 */
async function loadWholeHistory(page: Page, oldestPlanId: string): Promise<void> {
  await expect
    .poll(async () => {
      await scrollMainToBottom(page);
      return rowFor(page, oldestPlanId).count();
    })
    .toBe(1);
}

test('Plans: the tabs, ten at a time, both people on a decided plan, the list view, and a stuck plan discarded', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // ⚠️ THE CLIP IS THE STORY'S, NOT THIS CARD'S. The uploader publishes to the
  // story the recording declares, from THIS card's own pull-request run — so it
  // reaches MOTIR-3232 while the pull request is open, and the sibling spec's
  // clip joins it there. Neither is the whole receipt.
  acceptanceStory('MOTIR-3232');

  await page.setViewportSize(CLIP_VIEWPORT);
  const seed = await seedPlansSurface('plans-surface-acceptance@example.com');
  await signIn(page, seed.email, PLANS_SURFACE_PASSWORD);

  // ── 1 — the surface opens on a TAB, and the header holds no second door ────
  await chapter('Plans opens on the plans waiting for you', async () => {
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await plansNav.click();
    await page.waitForURL('**/plans');

    // ⚠️ ONE TAB PER `PlanStatusDto`, DERIVED — never a literal count. The strip
    // maps `PLAN_STATUS_DTO_VALUES`, so MOTIR-3560's fifth member (`stale`) made
    // a hardcoded `4` wrong the moment it landed, and this spec went red on
    // `main` rather than on the pull request that added it. Deriving the number
    // from the same constant the component maps is what stops a sixth status
    // costing another red lane (drive-by fix, MOTIR-3622).
    await expect(tabStrip(page)).toBeVisible();
    await expect(tabStrip(page).getByRole('button')).toHaveCount(PLAN_STATUS_DTO_VALUES.length);
    await expect(tab(page, 'Planned')).toHaveAttribute('aria-pressed', 'true');
    for (const other of ['Generating', 'Stale', 'Approved', 'Declined']) {
      await expect(tab(page, other)).toHaveAttribute('aria-pressed', 'false');
    }

    // …and the DEFAULT writes no parameter. `/plans` and `?status=planned` must
    // not be two addresses for one view, so every link written before this story
    // still resolves byte-identically.
    expect(new URL(page.url()).search).toBe('');
    await beat();

    // ── RECIPE STEP 6 — ONE Plan-with-AI door, and it is the top bar's.
    // The page header used to render its own about 200px below the identical one
    // the shell puts on every authed screen (MOTIR-3237). Asserted as a COUNT
    // over the whole page rather than as an absence inside the header: a pill
    // that moved a few pixels out of the header and stayed on the page would
    // satisfy an absence check and none of the reason for it.
    const pill = page.getByRole('link', { name: 'Plan with AI' });
    await expect(pill).toHaveCount(1);
    await expect(pill).toBeVisible();
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Plan with AI' }),
    ).toBeVisible();
    await beat();
  });

  // ── 2 — TEN A PAGE, and the next ten arrive because you scrolled ──────────
  await chapter('Approved holds a long history — it arrives ten at a time', async () => {
    await tab(page, 'Approved').click();
    await page.waitForURL('**/plans?status=approved');

    // The first cursor page, and only it. The read's own default is ten; the
    // page never states a number of its own — and the tab says how many there
    // are in total, which is the honest, windowing-proof statement of the size
    // the ten is a slice of.
    await expect(planRows(page)).toHaveCount(10);
    await expect(tab(page, 'Approved')).toContainText(String(APPROVED_PLAN_COUNT));

    // ⚠️ AND NO BUTTON ANYWHERE. `Load more` had exactly one caller and it was a
    // button; the story replaced it with a sentinel. A regression that brought
    // it back would still stream correctly and still pass a row-count assertion.
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);
    await beat();

    const landed = nextPageLanded(page);
    await scrollMainToBottom(page);
    await landed;

    // THE NEXT TEN ARRIVED, and the scroll is what fetched them: the response
    // above landed only after it, and the list now MOUNTS more rows than the
    // whole first page held — which nothing but a second page can produce.
    //
    // ⚠️ AND NOT AS `toHaveCount(20)`, which this spec cannot honestly assert and
    // the card's wording assumes it can. Three properties of the shipped surface,
    // none of them of the test: (1) the list is VIRTUALIZED, so the DOM holds the
    // WINDOW — 17 rows at this viewport — and never the twenty that are loaded;
    // (2) a row outside the window is not in the DOM at all, so it cannot even be
    // scrolled to by locator, which rules out naming a page-two plan and reaching
    // for it; and (3) the sentinel looks 600px AHEAD, so arriving at the bottom to
    // count immediately streams page THREE. "Exactly twenty are loaded" is a state
    // no observer can hold still, and an assertion on it is a race by
    // construction. What IS stable is the pair below plus the tail that follows.
    await expect.poll(() => planRows(page).count()).toBeGreaterThan(10);
    await beat();

    // The tail, so the list is shown to END rather than to keep going.
    await loadWholeHistory(page, seed.oldestApprovedPlanId);
  });

  // ── 3 — a decided plan names BOTH people, and says which is which ─────────
  await chapter('A decided plan says who asked and who approved', async () => {
    // Back to the top, where the newest plan is — the list is still scrolled to
    // the end of its history from the chapter before, and the top rows are not
    // mounted while it is.
    await scrollMainToTop(page);
    const decided = rowFor(page, seed.decidedPlanId);
    await expect(decided).toBeVisible();

    // BOTH, by name — not "two names are present". The roles are legible because
    // they sit in different entries: the decider rides the WHEN entry behind the
    // verb that already labels it, the requester rides the attribution entry
    // behind their face.
    await expect(decided).toContainText(`approved`);
    await expect(decided).toContainText(`by ${seed.ownerName}`);
    await expect(decided).toContainText(seed.requesterName);
    await expect(decided).toContainText('Approved');
    await beat();

    // …and the UNDECIDED row still shows the requester. Before this story a
    // decided row named nobody at all, and the fix has a symmetrical failure
    // mode — showing the decider by DROPPING the requester — which only an
    // assertion on both states can catch.
    await tab(page, 'Planned').click();
    await page.waitForURL('**/plans');
    const waiting = rowFor(page, seed.detailPlanId);
    await expect(waiting).toContainText(seed.requesterName);
    await expect(waiting).not.toContainText('by ' + seed.ownerName);
    await beat();
  });

  // ── 4 — the same plan, read as a SET ──────────────────────────────────────
  await chapter('A plan can be read as a list of exactly what it changes', async () => {
    await rowFor(page, seed.detailPlanId).click();
    await page.waitForURL(`**/plans/${seed.detailPlanId}`);

    // It opens on the CANVAS — every proposal sits under one parent, so there is
    // a level that can show it. (WHICH plans open on the list instead is the
    // sibling spec's; this one is seeded single-parent so the switcher is what
    // is under test.)
    await expect(page.getByLabel('Proposed plan canvas')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    await beat();

    const switcher = page.getByRole('group', { name: 'Plan view' });
    await switcher.getByRole('button', { name: 'List' }).click();
    await page.waitForURL(`**/plans/${seed.detailPlanId}?view=list`);

    const list = page.getByTestId('plan-proposal-list');
    await expect(list).toBeVisible();
    // The two sections the plan actually has, and the proposals in them by name.
    await expect(list).toContainText('Adds');
    await expect(list).toContainText(seed.detailAddTitle);
    await expect(list).toContainText('Updates');
    await expect(list).toContainText(seed.detailModifyTitle);
    await beat();

    // The URL is the single source of truth, so a RELOAD keeps the view…
    await page.reload();
    await expect(page.getByTestId('plan-proposal-list')).toBeVisible();

    // …and BACK returns to the canvas, because switching pushed history rather
    // than replacing it.
    await page.goBack();
    await page.waitForURL(`**/plans/${seed.detailPlanId}`);
    await expect(page.getByLabel('Proposed plan canvas')).toBeVisible();
    await beat();
  });

  // ── 5 — nothing is stranded mid-generation ────────────────────────────────
  await chapter('A plan stuck half-written can be ended, and says so', async () => {
    await page.goto('/plans?status=generating');
    await expect(tab(page, 'Generating')).toHaveAttribute('aria-pressed', 'true');
    await rowFor(page, seed.generatingPlanId).click();
    await page.waitForURL(`**/plans/${seed.generatingPlanId}`);

    // The rail's ONE live control while generating — a real affordance, not a
    // ghost beside a disabled Approve.
    const discard = page.getByTestId('plan-discard');
    await expect(discard).toBeEnabled();
    await discard.click();

    // The confirm names what is being thrown away, and what is not.
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Discard this plan?');
    await expect(confirm).toContainText('2 proposals');
    await beat();

    await confirm.getByRole('button', { name: 'Discard plan' }).click();

    // ⚠️ THE REASON-SPECIFIC LINE, not the generic declined one. A plan that
    // never finished being written is ENDED, not turned down, and
    // `decisionReason` is what keeps the two distinguishable for ever — an
    // implementation that reused the review copy would pass a status assertion
    // and lose the distinction the column exists for.
    await expect(page.getByTestId('plan-status-pill')).toContainText('Declined');
    await expect(
      page.getByText('Plan discarded before it finished — your work items are unchanged'),
    ).toBeVisible();
    await expect(page.getByText('Plan declined — your tree was left untouched')).toHaveCount(0);
    await beat();

    // And it left the tab it was stuck in, which is the reader-visible half of
    // the same fact.
    await page.goto('/plans?status=declined');
    await expect(rowFor(page, seed.generatingPlanId)).toBeVisible();
    await beat();
  });
});

test('Plans: the empty tab, an empty list view, a list that SHRINKS, and a plan decided under you', async ({
  page,
}) => {
  await page.setViewportSize(SHORT_VIEWPORT);
  const seed = await seedPlansSurface('plans-surface-states@example.com');
  await signIn(page, seed.email, PLANS_SURFACE_PASSWORD);

  // ── EMPTY: a tab with no plans is NOT an empty project ────────────────────
  await page.goto('/plans?status=declined');
  // The strip STAYS. A reader whose tab is empty is one press from the plans,
  // and hiding the strip would strand them; the project-level empty state hides
  // it precisely because there is then nothing to press.
  await expect(tabStrip(page)).toBeVisible();
  await expect(page.getByText('Nothing declined')).toBeVisible();
  await expect(
    page.getByText("This project's other plans are in the remaining tabs."),
  ).toBeVisible();
  // …and it does NOT repeat the first-run call to action: "generate your first
  // plan" is false on its face in a project holding twenty-odd of them.
  await expect(page.getByRole('link', { name: 'Plan with AI' })).toHaveCount(1);

  // ── EMPTY, one altitude down: the LIST view of a plan with nothing to list ──
  await page.goto(`/plans/${seed.emptyPlanId}?view=list`);
  await expect(page.getByText('No proposals')).toBeVisible();
  await expect(page.getByTestId('plan-proposal-list')).toHaveCount(0);

  // ── THE SHRINK, IN BOTH DIRECTIONS ────────────────────────────────────────
  //
  // The card records the numbers this leg used, because they are what makes it
  // able to fail at all: 22 seeded `approved` plans (APPROVED_PLAN_COUNT), all
  // 22 loaded, at a 1280x600 viewport — where `<main>`'s ~540px of body is
  // comfortably shorter than 22 rows, so `useRowWindow` genuinely windows. That
  // it windows is not assumed: the DOM holds ~13 rows here while 22 are loaded,
  // which is exactly why `loadWholeHistory` cannot count them.
  await page.goto('/plans?status=approved');
  await expect(planRows(page)).toHaveCount(10);

  await loadWholeHistory(page, seed.oldestApprovedPlanId);

  // Deep — the window's bounds are now far from zero, which is the whole
  // precondition. Then a tab with two rows.
  await scrollMainToBottom(page);
  await tab(page, 'Generating').click();
  await page.waitForURL('**/plans?status=generating');
  await expect(planRows(page)).toHaveCount(3);

  // …and BACK the other way, because the bounds go stale in both directions: a
  // window sized for three rows, then ten.
  await tab(page, 'Approved').click();
  await page.waitForURL('**/plans?status=approved');
  await expect(planRows(page)).toHaveCount(10);

  // One more shrink, from the freshly re-mounted long tab to the shortest tab
  // there is — the empty one, where the list is not rendered at all.
  await tab(page, 'Declined').click();
  await page.waitForURL('**/plans?status=declined');
  await expect(page.getByText('Nothing declined')).toBeVisible();

  // ── ERROR: the plan was decided while the reader was looking at it ─────────
  //
  // ⚠️ LAST, AND THAT IS ORDER-DEPENDENT rather than arbitrary: it puts a plan
  // into `Declined`, which is the tab every leg above needs EMPTY. Run it
  // earlier and the two empty-state assertions become assertions about a
  // one-row list, which would still pass a `toBeVisible` on the strip and prove
  // nothing about the state they name.
  //
  // Staged for real rather than stubbed: the decision is taken THROUGH the
  // shipped service, from outside the browser, exactly as a colleague in another
  // tab would take it. The click that follows genuinely 409s.
  await page.goto(`/plans/${seed.concurrentlyDecidedPlanId}`);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');

  await plansService.declinePlan(seed.concurrentlyDecidedPlanId, {
    userId: seed.userId,
    workspaceId: seed.workspaceId,
  });

  await page.getByRole('button', { name: 'Decline' }).click();

  // ⚠️ A 409 IS NOT AN ERROR ON THIS SURFACE (MOTIR-3240). The plan moved between
  // render and click and the decision was still made, so the rail shows the
  // plan's REAL state — never "that didn't work" printed above the answer.
  await expect(page.getByTestId('plan-status-pill')).toContainText('Declined');
  await expect(page.getByText('Plan declined — your tree was left untouched')).toBeVisible();
  // ⚠️ SCOPED TO THE RAIL, because a bare `getByRole('alert')` is never zero in an
  // App Router document: Next mounts `#__next-route-announcer__` with
  // `role="alert"` after the first client navigation and leaves it there for the
  // life of the page. The rail is where the error would be, and it is the only
  // place the assertion means anything.
  await expect(
    page.getByRole('complementary', { name: 'Plan review' }).getByRole('alert'),
  ).toHaveCount(0);

  // The verdict is `afterEach`'s: `pageErrors` empty for this whole walk.
});
