import { request as apiRequest } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
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
  setOrgAcceptanceVideo,
} from './_helpers/acceptance-seed';

// The story-acceptance E2E + the SELF-TEST DOGFOOD (Story MOTIR-1627 · Subtask
// MOTIR-1638). Runs under playwright.acceptance.config.ts (cloud-on + video:'on'):
// the green happy-path run is recorded as a chaptered video and the uploader
// (MOTIR-1632) publishes it to MOTIR-1627's OWN acceptance panel — the feature
// validating itself. Every persisted-state assertion waits on the AUTHORITATIVE
// signal (the reconciled response / a committed reload), never a waitForTimeout
// or an optimistic-only assert (the CLAUDE.md E2E discipline).

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
  acceptanceStory,
}) => {
  // This IS the MOTIR-1627 self-test dogfood — pin the recorded clip to MOTIR-1627
  // (MOTIR-1684). The uploader reads this over the PR-derived key, so the dogfood
  // always publishes to its own panel and is never mis-attributed to an unrelated
  // PR's story.
  acceptanceStory('MOTIR-1627');
  const seed = await seedBillingOwner(page, 'dogfood@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setOrgAcceptanceVideo(seed.organizationId, true);
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
    // The chaptered player + the gate buttons are present (State A).
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByText('Open the story')).toBeVisible(); // a chapter marker
  });
  await page.waitForTimeout(2000);

  await chapter('Review the evidence + Approve', async () => {
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    // Authoritative: the server response reconciles the panel to the Approved
    // pill (the response IS the confirmation — the inline-edit rule).
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  });
  await page.waitForTimeout(2000);

  await chapter('The story is Done', async () => {
    // Committed-state read: reload and confirm the story reached Done.
    await page.reload();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    const persisted = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(persisted.status).toBe('done');
  });
  await page.waitForTimeout(2000);
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
  await setOrgAcceptanceVideo(seed.organizationId, true);
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

test('paid + on → Request changes sends the story back to In Progress', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'revise@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setOrgAcceptanceVideo(seed.organizationId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Needs changes');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/items/${story.identifier}`);
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByText('Changes requested', { exact: true })).toBeVisible();
  await page.reload();
  const persisted = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
  expect(persisted.status).toBe('in_progress');
});

test('paid + on, no evidence yet → the pending "waiting for the video" state', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'pending@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setOrgAcceptanceVideo(seed.organizationId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'No video yet');

  await page.goto(`/items/${story.identifier}`);
  await expect(page.getByText('Waiting for the acceptance video')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('paid + toggle OFF (admin) → the Turn-on switch + Go to settings', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'toggleoff@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setOrgAcceptanceVideo(seed.organizationId, false);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Toggle off');

  await page.goto(`/items/${story.identifier}`);
  await expect(page.getByText('Acceptance video is off')).toBeVisible();
  await expect(page.getByRole('switch')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to settings' })).toHaveAttribute(
    'href',
    /\/settings\/organization/,
  );
});

test('no plan → the Upgrade CTA (no player)', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'noplan@example.com');
  setOrgBillingState(seed.organizationId, freeOrgState());
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'Free plan');

  await page.goto(`/items/${story.identifier}`);
  await expect(page.getByText('Get a video receipt for every story')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
    'href',
    '/settings/organization/billing',
  );
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('the board shows the "Awaiting acceptance" badge, cleared on approve', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'board@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setOrgAcceptanceVideo(seed.organizationId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, 'On the board');
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/boards`);
  await expect(page.getByText('Awaiting acceptance')).toBeVisible();

  // Approve from the detail page, then the badge clears on the board.
  await page.goto(`/items/${story.identifier}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await page.goto(`/boards`);
  await expect(page.getByText('Awaiting acceptance')).toHaveCount(0);
});
