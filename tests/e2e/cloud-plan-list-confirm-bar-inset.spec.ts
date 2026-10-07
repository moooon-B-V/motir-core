import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import {
  finishSessionPlanWithCards,
  latestPlanningSession,
} from './_helpers/planChangeConversation';
import en from '@/messages/en.json';

// MOTIR-7726 — on the planning surface the confirm bar must never cover the end
// of the plan's LIST.
//
// The bar FLOATS over the pane's bottom edge (MOTIR-6186, Part XXI 21.8) and the
// host publishes its height as `--canvas-foot-inset`. The list's scroller used to
// ignore it, so its scroll range ended at the pane's edge, under the bar. Two
// shapes, and this spec pins both:
//
//   • A list that FITS the box but not the space above the bar never overflowed:
//     no scrollbar, the wheel did nothing, and the last rows sat behind the bar.
//     This is the one the owner reported ("I can't scroll"), on a 12-row plan.
//   • A list that DOES overflow scrolled, but ended with its last row still
//     half behind the bar.
//
// ── Why this cannot be a lower tier ─────────────────────────────────────────
// Both claims are about LAYOUT — what overflows, and where a row ends relative to
// a box absolutely positioned over another box. happy-dom lays nothing out, so
// `PlanProposalList.test.tsx` can only pin the class wiring; this measures it.
//
// ── Why the viewport is SIZED, not picked ───────────────────────────────────
// "Fits the box but not the space above the bar" is a band one bar tall, and a
// row's height depends on fonts and wrapping. So the first test measures the
// list's natural extent and sizes the viewport to put it in the middle of that
// band, then CHECKS the precondition (the last row starts out under the bar)
// before asserting anything — a spec that silently stopped exercising the bug
// would otherwise keep passing.

const planReview = en.planReview;

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const viewButton = (page: Page, name: string) =>
  workspace(page)
    .getByRole('group', { name: planReview.viewSwitchAria })
    .getByRole('button', { name, exact: true });
const list = (page: Page) => workspace(page).getByTestId('plan-proposal-list');
const rows = (scope: Locator) => scope.locator('section > ul > li');
const overlayOpen = (url: URL) => url.searchParams.has('plan');

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** The lane's motir-ai mock proposes nothing; the run is finished by the shipped
 *  services instead, which is what `finishSessionPlanWithCards` does. */
function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
}

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

/** Ask Motir AI from the story's card, then finish the run with `count` proposed
 *  cards and re-open the surface on the proposed plan, in List view. */
async function openProposedPlanInList(page: Page, count: number): Promise<void> {
  const email = `plan-list-inset-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const story = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: seed.storyKey },
    select: { id: true },
  });

  await page.goto(`/items/${seed.storyKey}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  // The anchored door appends AND submits in one call; its 200 is the
  // authoritative "the session holds this turn".
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill('Break this story into small cards.');
  await composer(page).press('Enter');
  await answered;

  const session = await latestPlanningSession(email);
  const titles = Array.from({ length: count }, (_, i) => `Proposed card ${i + 1}`);
  await finishSessionPlanWithCards(session.id, story.id, titles);

  await page.reload();
  await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(bar(page)).toBeVisible();
  await viewButton(page, planReview.viewList).click();
  await expect(rows(list(page))).toHaveCount(count);
}

/** Where the list's last row and the bar's top edge are, in viewport pixels. */
async function geometry(page: Page) {
  const listBox = (await list(page).boundingBox())!;
  const barBox = (await bar(page).boundingBox())!;
  const lastBox = (await rows(list(page)).last().boundingBox())!;
  const scroll = await list(page).evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  return {
    listTop: listBox.y,
    listHeight: listBox.height,
    barTop: barBox.y,
    barHeight: barBox.height,
    lastRowBottom: lastBox.y + lastBox.height,
    ...scroll,
  };
}

/** Wheel over the list until it reports it is at its end — the wheel, not a
 *  scripted `scrollTop`, because "the wheel does nothing" is the symptom. */
async function wheelToEnd(page: Page): Promise<void> {
  const box = (await list(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(80, box.height / 4));
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 400);
        return list(page).evaluate(
          (el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight,
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a list that fits the pane but not the space above the bar still scrolls its last row clear of the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openProposedPlanInList(page, 6);

  // Size the pane so the rows' NATURAL extent sits half a bar into the strip the
  // bar covers: it fits the whole box, and it does not fit the space above it.
  const at = await geometry(page);
  const restingPadding = 12; // `p-3` — the list's own end padding without the inset
  const naturalExtent = at.lastRowBottom - at.listTop + at.scrollTop + restingPadding;
  const wantedListHeight = Math.round(naturalExtent + at.barHeight / 2);
  await page.setViewportSize({
    width: 1280,
    height: 800 + (wantedListHeight - Math.round(at.listHeight)),
  });
  await expect
    .poll(async () => Math.round((await geometry(page)).listHeight))
    .toBe(wantedListHeight);

  // THE PRECONDITION — at rest, the last row starts out under the bar. Without it
  // this test would not be exercising the defect at all.
  const before = await geometry(page);
  expect(before.scrollTop).toBe(0);
  expect(before.lastRowBottom).toBeGreaterThan(before.barTop);

  // The list overflows (so there is a scrollbar), and the wheel reaches its end…
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  await wheelToEnd(page);

  // …where the last row is fully above the bar.
  const after = await geometry(page);
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(after.lastRowBottom).toBeLessThanOrEqual(after.barTop);
});

test('a long list, scrolled to its end, ends with its last row above the bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openProposedPlanInList(page, 40);

  const before = await geometry(page);
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

  await wheelToEnd(page);

  const after = await geometry(page);
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(after.lastRowBottom).toBeLessThanOrEqual(after.barTop);
});
