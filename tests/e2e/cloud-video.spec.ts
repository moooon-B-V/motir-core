import { request as apiRequest, type Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import {
  seedBillingOwner,
  setOrgBillingState,
  resetBillingFixture,
  freeOrgState,
  paidOrgState,
} from './_helpers/billing';
import {
  seedInReviewStory,
  seedPendingEvidence,
  setProjectAcceptanceVideo,
} from './_helpers/acceptance-seed';
import { acceptanceSection, decideAcceptanceInOverlay } from './_helpers/acceptance-decide';

// The story-acceptance E2E + the SELF-TEST DOGFOOD (Story MOTIR-1627 · Subtask
// MOTIR-1638). Runs under playwright.acceptance.config.ts (cloud-on + video:'on'):
// the green happy-path run is recorded as a chaptered video and the uploader
// (MOTIR-1632) publishes it to MOTIR-1627's OWN acceptance panel — the feature
// validating itself. Every persisted-state assertion waits on the AUTHORITATIVE
// signal (the reconciled response / a committed reload), never a waitForTimeout
// or an optimistic-only assert (the CLAUDE.md E2E discipline).

// ── Locators ─────────────────────────────────────────────────────────────────
//
// MOTIR-5116: every page-rooted read in this file addresses a `Pill` or a body
// `<span>` with no role of its own, so the remedy is a SCOPE rather than a role.
// Both scopes below are themselves resolved through the accessibility tree,
// which is what buys them the immunity a page-rooted locator lacks.

/** The item page's live route subtree — the acceptance panel streams inside it. */
const acceptance = (page: Page) => page.getByRole('main');
/** `BoardContainer`'s scroll row: `role="group"` + `aria-label`. */
const boardRegion = (page: Page) => page.getByRole('group', { name: 'Board columns' });

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── The dogfood: the recorded, chaptered happy path ──────────────────────────
test('paid + on → the reviewer plays the video and Approves → the story goes Done', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // This IS the MOTIR-1627 self-test dogfood — pin the recorded clip to MOTIR-1627
  // (MOTIR-1684). The uploader reads this over the PR-derived key, so the dogfood
  // always publishes to its own panel and is never mis-attributed to an unrelated
  // PR's story.
  acceptanceStory('MOTIR-1627');
  const seed = await seedBillingOwner(page, 'dogfood@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Acceptance dogfood');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await chapter('Open the story in review', async () => {
    await page.goto(`/items/${story.identifier}`);
    // First test in the file → first hit of /items/[id]; `next dev` compiles the
    // route on demand, so give this initial assertion cold-compile headroom
    // (the default 20s can be tight under CI load). Later tests hit it warm.
    await expect(page.getByRole('heading', { name: 'Acceptance', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // The chaptered player + the question's one DOOR are present (State A). The page
    // hands the decision to the approval overlay (MOTIR-5229 · MOTIR-5790), so what it
    // shows here is the band, never a verb.
    await expect(
      acceptanceSection(page).getByRole('link', { name: 'Review & approve' }),
    ).toBeVisible();
    // BY ROLE: a chapter marker is a `<button>` in `AcceptancePanel`'s chapter
    // list, so the accessibility tree excludes the streamed copy that a
    // page-rooted `getByText` resolves (MOTIR-4822). The name matches on a
    // substring, so the marker's index and timestamp do not interfere.
    await expect(page.getByRole('button', { name: 'Open the story' })).toBeVisible();
  });
  await beat();

  await chapter('Review the evidence + Approve', async () => {
    // Through the ONE door, which is where every decision in the product is submitted.
    await decideAcceptanceInOverlay(page, 'approve');
    // The panel keeps the RECORD — the shared approval frame since MOTIR-5792, so the
    // decision reads back on the page it was made from.
    // SCOPED TO `main`: the item page streams its late stack behind an in-page
    // `<Suspense>`, so React leaves a resolved copy in `<div hidden id="S:0">` at the end
    // of `<body>` — outside `main`, which is what this scope drops (`CLAUDE.md` § *a
    // boundary makes every unscoped locator a race*).
    await expect(acceptance(page).getByText('Approved', { exact: true })).toBeVisible();
  });
  await beat();

  await chapter('The story is Done', async () => {
    // Committed-state read: reload and confirm the story reached Done.
    await page.reload();
    await expect(acceptance(page).getByText('Approved', { exact: true })).toBeVisible();
    const persisted = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(persisted.status).toBe('done');
  });
  await beat();
});

// MOTIR-1665 / MOTIR-1670 — the story's OWN acceptance: the video is served
// through the AUTHENTICATED content route (access-controlled), not a
// world-readable blob URL. Seeing it is the acceptance; seeing it because it's
// public is a FAILURE.
test('the acceptance video is served through the authenticated content route — not world-readable', async ({
  page,
  baseURL,
}) => {
  const seed = await seedBillingOwner(page, 'access@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Access controlled');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/items/${story.identifier}`);

  // The player's <video> src is the APP content path — never a raw blob URL.
  const video = page.locator('video');
  await expect(video).toBeVisible({ timeout: 20_000 });
  const src = await video.getAttribute('src');
  expect(src).toMatch(/^\/api\/attachments\/[^/]+\/content$/);

  // The authorized reviewer's own session resolves that route (302 → signed URL,
  // or 200) — arm on the route response, don't follow the redirect to the blob.
  const authed = await page.request.get(src!, { maxRedirects: 0 });
  expect([200, 302]).toContain(authed.status());

  // A logged-OUT client is REFUSED — the private blob is not world-readable.
  const anon = await apiRequest.newContext({ baseURL: baseURL ?? undefined });
  const anonRes = await anon.get(src!, { maxRedirects: 0 });
  expect([401, 403]).toContain(anonRes.status());
  await anon.dispose();
});

test('paid + on → Request changes records the decision and moves the story NOWHERE', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'revise@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Needs changes');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/items/${story.identifier}`);
  await decideAcceptanceInOverlay(page, 'request_changes');
  // ⚠️ THIS ASSERTION WAS ABOUT THE TOAST, and the toast belonged to the panel's own
  // verbs — which MOTIR-5790 retired when the decision moved to the approval overlay.
  // What replaces it is not a retreat: the panel now keeps the RECORD in the shared
  // approval frame (MOTIR-5792), so the decision is readable on the page it was made
  // from, by the same words, and it SURVIVES — where a toast is gone in seconds and
  // could only ever be caught in flight.
  await expect(acceptance(page).getByText('Changes requested', { exact: true })).toBeVisible();
  await page.reload();
  // ⚠️ `in_review`, NOT `in_progress` (Story MOTIR-4949 · Subtask MOTIR-4950). The bespoke
  // acceptance path moved the story back on a send-back; joining the ONE approve language
  // retired that write, because every kind's *Request changes* records a decision and
  // moves nothing (`approval-gates.md` §3). The committed read is kept, and now pins the
  // ABSENCE of the write — which is the half a future regression would break silently.
  const persisted = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
  expect(persisted.status).toBe('in_review');
});

test('paid + on, no evidence yet → the pending "waiting for the video" state', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'pending@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'No video yet');

  await page.goto(`/items/${story.identifier}`);
  // BY ROLE — `AcceptancePanel` renders each state's title as an `<h3>`; an
  // unscoped `getByText` also matches the hidden streamed copy of the subtree
  // and loses strict mode (MOTIR-4822; `CLAUDE.md`, the loading-boundary rule).
  await expect(
    page.getByRole('heading', { name: 'Waiting for the acceptance video' }),
  ).toBeVisible();
  await expect(acceptanceSection(page).getByRole('link', { name: 'Review & approve' })).toHaveCount(
    0,
  );
});

test('paid + toggle OFF (admin) → the Turn-on switch, and Go to settings lands ON the switch', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'toggleoff@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  // ⚠️ THE TWO TIERS STILL DISAGREE, AND NOW NOTHING CAN MAKE THEM AGREE
  // (MOTIR-4925 · MOTIR-5168 · MOTIR-5172). The switch is a PROJECT setting, so
  // this seeds the project OFF while the organisation's retired column keeps its
  // `@default(true)`: the panel may only reach its off state by reading the
  // project. This used to set the org column ON explicitly; MOTIR-5172 removed
  // every application writer of that column, and its seed helper with them.
  await setProjectAcceptanceVideo(seed.projectId, false);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Toggle off');

  await page.goto(`/items/${story.identifier}`);
  // BY ROLE — the panel's `<h3>` (MOTIR-4822, as above).
  await expect(page.getByRole('heading', { name: 'Acceptance video is off' })).toBeVisible();
  await expect(page.getByRole('switch')).toBeVisible();
  // ⚠️ FOLLOWED, NOT COMPARED (MOTIR-5172 criterion 5). This asserted the href
  // matched `/settings/organization` — and after the switch moved, that string
  // comparison would have kept passing against a page that no longer held the
  // control. A link is right when it LANDS on the thing it names, so the walk
  // clicks it and asserts the switch is rendered inside the element the anchor
  // targets.
  await acceptance(page).getByRole('link', { name: 'Go to settings' }).click();
  await expect(page).toHaveURL(/\/settings\/project\/approvals#acceptance-video$/);
  await expect(
    acceptance(page)
      .locator('#acceptance-video')
      .getByRole('switch', { name: 'Acceptance video approval' }),
  ).toBeVisible();
});

test('no plan → the Upgrade CTA (no player)', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'noplan@example.com');
  setOrgBillingState(seed.organizationId, freeOrgState());
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Free plan');

  await page.goto(`/items/${story.identifier}`);
  // BY ROLE — the panel's `<h3>` (MOTIR-4822, as above).
  await expect(
    page.getByRole('heading', { name: 'Get a video receipt for every story' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
    'href',
    '/settings/organization/billing',
  );
  await expect(acceptanceSection(page).getByRole('link', { name: 'Review & approve' })).toHaveCount(
    0,
  );
});

// MOTIR-4908 (MOTIR-5877) RETIRED the board's "Awaiting acceptance" pill into the
// decision-waiting marker: the pending receipt raises an `acceptance_result` gate
// (`seedPendingEvidence` → `reconcileGatesFor`), routed to the story's owner, so the
// card now carries the LOUD marker — the same fact, stated once.
test('the board shows the decision-waiting marker for the receipt, cleared on approve', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'board@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'On the board');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/boards`);
  // SCOPED TO THE BOARD: the marker is a `Pill` on a `BoardCard`, so there is no
  // role to ask for — but `BoardContainer`'s scroll row IS `role="group"` +
  // `aria-label`, and reading the marker through it also says what the assertion
  // is actually about (the marker is ON THE BOARD).
  const marker = boardRegion(page).locator(
    '[data-decision-marker="yours"][data-decision-kind="acceptance_result"]',
  );
  await expect(marker).toBeVisible();
  await expect(marker).toHaveText('Awaiting you');

  // Approve from the detail page, then the badge clears on the board.
  await page.goto(`/items/${story.identifier}`);
  await decideAcceptanceInOverlay(page, 'approve');
  await expect(acceptance(page).getByText('Approved', { exact: true })).toBeVisible();
  await page.goto(`/boards`);
  await expect(boardRegion(page).locator('[data-decision-marker]')).toHaveCount(0);
});
