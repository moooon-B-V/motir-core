// Acceptance E2E — AI expand & re-plan (Subtask 7.11.9 / MOTIR-906).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on') so the
// CI acceptance-video lane records a chaptered clip; the uploader resolves the
// subtask key up to the parent story MOTIR-811 via authorizeAcceptancePublish.
//
// Drives the operation surfaces from the user's seat in a real browser:
// expand (click on stub → review → approve) and replan (completion-aware →
// locked items → approve). Each operation is submitted, reviewed in the
// diff-review dock, and approved; the tree reflects each change. The nudge
// smoke (test 3) drives the ready set low and asserts the expansion-nudge
// banner appears and the inline review opens.
//
// The one-shot "Augment from prompt" leg was RETIRED by MOTIR-1731 along with
// the button it drove — changing a plan is a CONVERSATION, so that flow's
// coverage is MOTIR-1733's conversational acceptance spec. The `/api/ai/augment`
// job path itself is untouched; only the per-surface button is gone.
//
// motir-ai is absent from CI, so the browser→ai boundary is STUBBED via
// `page.route` — the same open-core seam `ai-plan-generation.spec.ts` uses. Only
// the SUBMIT and its SSE are stubbed: what a run proposes is seeded as a real
// `Plan` (the shipped `plansService.createPlan → addProposals → markPlanned`,
// exactly what the handler's callbacks do), the dock READS it through the real
// `GET /api/plans/:id`, and the approve runs the real
// `POST /api/plans/:id/approve → materialize`. So the spec asserts real DB state,
// not a stub echo.
//
// It used to stub a `planDelta` on `GET /api/ai/jobs/:id` and confirm through
// `POST /api/ai/plan-delta/approve` — a shape the app no longer has (MOTIR-1747):
// every planner returns an EMPTY delta, so that path could only ever propose
// nothing, and it is now deleted.

import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  seedPlanChangeProposal,
  EXPAND_JOB_ID,
  REPLAN_JOB_ID,
} from './_helpers/ai-augment-replan-seed';

test.describe.configure({ timeout: 180_000 });

// ── Stub constants ───────────────────────────────────────────────────────────

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

function doneSse(): string {
  return `event: done\ndata: {}\n\n`;
}

// ── Stub the browser→motir-ai boundary ───────────────────────────────────────

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/** Stub both job-submit + SSE endpoints (shared by the expand/replan tests).
 *  The submit echoes the `planId` of the Plan the run's proposals were seeded
 *  into — the same `{ jobId, planId }` pair the real submit returns since
 *  MOTIR-1743, and what the dock addresses its review + confirm to. */
async function stubEditsJobs(
  page: Page,
  plans: { expand?: string; replan?: string },
): Promise<void> {
  // Expand
  await page.route('**/api/ai/expand', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: EXPAND_JOB_ID, planId: plans.expand }),
    });
  });
  await page.route(`**/api/ai/expand/${EXPAND_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: doneSse(),
    });
  });

  // Replan
  await page.route('**/api/ai/replan', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: REPLAN_JOB_ID, planId: plans.replan }),
    });
  });
  await page.route(`**/api/ai/replan/${REPLAN_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: doneSse(),
    });
  });
}

// ── Locator helpers ──────────────────────────────────────────────────────────

const reviewHeader = 'h2:has-text("Review proposed changes")';
const doneTitle = 'h3:has-text("Work items updated")';

/** Open the actions menu on a table row identified by its item key, then click a menuitem. */
async function clickRowAction(page: Page, itemKey: string, actionLabel: string): Promise<void> {
  const row = page.getByRole('row', { name: new RegExp(itemKey) });
  // The trigger is the ⋯ button with aria-label "Actions for {key}".
  await row.getByLabel(`Actions for ${itemKey}`).click();
  await page.getByRole('menuitem', { name: actionLabel }).click();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The expand leg is the recorded happy path (it carries the chapter markers the
// acceptance video's timeline is built from — the augment leg used to, until
// MOTIR-1731 retired it).
test('expand — click Expand on childless stub, review, approve, children appear', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-811');
  const seed = await seedAiAugmentReplan(`ai-expand-${Date.now()}@example.com`);
  await stubAiAccess(page);
  // What the expand run PROPOSED: the stub's children, seeded as the real Plan
  // the handler would have appended them to.
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: EXPAND_JOB_ID,
    title: 'Expand Notifications',
    adds: ['In-app notifications', 'Email notifications', 'Push notifications'],
    addShape: { kind: 'task', type: 'code', parentRef: seed.notifId },
  });
  await stubEditsJobs(page, { expand: planId });

  await signIn(page, seed.email, seed.password);
  await page.goto('/items');

  await chapter('Expand a childless stub', async () => {
    // Find the "Notifications" stub row and click Expand in its actions menu.
    await clickRowAction(page, seed.notifKey, 'Expand');

    // The review dock appears — with stubs the entire job life cycle completes
    // in one tick, so wait for the authoritative signal directly.
    await expect(page.locator(reviewHeader)).toBeVisible({ timeout: 15_000 });
  });

  await chapter('Review and approve', async () => {
    // Assert all three children are proposed (page-level search — the delta
    // sits in a sibling of the header, not inside it).
    for (const title of ['In-app notifications', 'Email notifications', 'Push notifications']) {
      await expect(page.getByText(title)).toHaveCount(1);
    }

    // Approve — the REAL plan approve route (materialize), the one write path.
    const approveResponse = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Approve — add/ }).click();
    expect((await approveResponse).status()).toBe(200);

    await expect(page.locator(doneTitle)).toBeVisible({ timeout: 10_000 });

    // Assert DB: the three children were created.
    const children = await db.workItem.findMany({
      where: {
        projectId: seed.projectId,
        parentId: { not: null },
        title: { in: ['In-app notifications', 'Email notifications', 'Push notifications'] },
      },
    });
    expect(children).toHaveLength(3);
    for (const c of children) expect(c.kind).toBe('task');
  });
});

test('re-plan — completion-aware: done leaves locked, not-done portion changes', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-811');
  const seed = await seedAiAugmentReplan(`ai-replan-${Date.now()}@example.com`);
  await stubAiAccess(page);
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: REPLAN_JOB_ID,
    title: 'Re-plan Settings',
    adds: ['Billing plans', 'API management'],
    addShape: { parentRef: seed.settingsEpicId },
  });
  await stubEditsJobs(page, { replan: planId });

  // Snapshot the done leaves so we can assert byte-identity after approve.
  const doneItemsBefore = await db.workItem.findMany({
    where: { projectId: seed.projectId, identifier: { in: [seed.themeKey, seed.profileKey] } },
    orderBy: { identifier: 'asc' },
  });

  await signIn(page, seed.email, seed.password);
  await page.goto('/items');

  // Find the "Settings" epic row and click Re-plan.
  await clickRowAction(page, seed.settingsEpicKey, 'Re-plan');

  // The review dock appears — with stubs the entire job life cycle completes
  // in one tick, so wait for the authoritative signal directly.
  await expect(page.locator(reviewHeader)).toBeVisible({ timeout: 15_000 });

  // Assert the new stories for the not-done portion are proposed.
  await expect(page.getByText('Billing plans')).toHaveCount(1);
  await expect(page.getByText('API management')).toHaveCount(1);

  // The run MUST NOT propose changes to done (terminal) items — no `modify`
  // proposals targeting Theme toggle or Profile page. Assert no "Change" chip.
  await expect(page.getByText('Change', { exact: true })).toHaveCount(0);

  // Approve — the REAL plan approve route (materialize), the one write path.
  const approveResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Approve — add/ }).click();
  expect((await approveResponse).status()).toBe(200);

  await expect(page.locator(doneTitle)).toBeVisible({ timeout: 10_000 });

  // Assert DB: done items are byte-identical.
  const doneItemsAfter = await db.workItem.findMany({
    where: { projectId: seed.projectId, identifier: { in: [seed.themeKey, seed.profileKey] } },
    orderBy: { identifier: 'asc' },
  });
  expect(doneItemsAfter).toHaveLength(2);
  for (let i = 0; i < doneItemsBefore.length; i++) {
    expect(doneItemsAfter[i]!.title).toBe(doneItemsBefore[i]!.title);
    expect(doneItemsAfter[i]!.status).toBe('done');
    expect(doneItemsAfter[i]!.kind).toBe(doneItemsBefore[i]!.kind);
  }

  // Assert DB: new items created under Settings.
  const newItems = await db.workItem.findMany({
    where: { projectId: seed.projectId, title: { in: ['Billing plans', 'API management'] } },
  });
  expect(newItems).toHaveLength(2);
  for (const item of newItems) expect(item.kind).toBe('story');
});

test('nudge — near-drained project shows expansion-nudge banner and opens inline review', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-811');
  const seed = await seedAiAugmentReplan(`ai-nudge-${Date.now()}@example.com`);

  // Stub the nudge endpoint — the banner fetches this on mount.
  await page.route('**/api/ready/nudge', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        readyCount: 1,
        nominatedKey: seed.notifKey,
        nominatedTitle: 'Notifications',
        threshold: 3,
      }),
    });
  });

  // The banner's Expand button drives the real expand flow: only the submit +
  // SSE are stubbed, and the proposals it then polls for are a real Plan.
  // (We do NOT approve — the nudge test stops at the review.)
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: EXPAND_JOB_ID,
    title: 'Expand Notifications',
    adds: ['In-app notifications', 'Email notifications', 'Push notifications'],
    addShape: { kind: 'task', type: 'code', parentRef: seed.notifId },
  });
  await stubAiAccess(page);
  await page.route('**/api/ai/expand', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: EXPAND_JOB_ID, planId }),
    });
  });
  await page.route(`**/api/ai/expand/${EXPAND_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: doneSse(),
    });
  });

  await signIn(page, seed.email, seed.password);
  await page.goto('/ready');

  // The nudge banner appears — it names the nominated stub. `.first()` for the
  // same reason as the title below: the key appears BOTH in the banner sentence
  // ("… expand ARP-4 (Notifications)") and in its own font-mono key chip, so a
  // bare text= locator is a strict-mode violation as soon as both have rendered.
  await expect(page.locator(`text=${seed.notifKey}`).first()).toBeVisible({ timeout: 10_000 });
  // The nudge body also contains the nominated title — use .first() to avoid
  // strict-mode collision with the items-list row that also has "Notifications".
  await expect(page.locator('text=Notifications').first()).toBeVisible();

  // The "Expand" button is present in the banner.
  const expandBtn = page.getByRole('button', { name: 'Expand' });
  await expect(expandBtn).toBeVisible();

  // Click Expand — the banner auto-starts the expand job, polls, and shows
  // the inline ExpansionNudgeReview with the proposed children.
  await expandBtn.click();

  // The inline review renders "Proposed children" heading + child list.
  await expect(page.getByText('In-app notifications')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Email notifications')).toBeVisible();
  await expect(page.getByText('Push notifications')).toBeVisible();
});
