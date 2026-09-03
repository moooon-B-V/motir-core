// Acceptance E2E — AI expand & re-plan (Subtask 7.11.9 / MOTIR-906).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on') so the
// CI acceptance-video lane records a chaptered clip; the uploader resolves the
// subtask key up to the parent story MOTIR-811 via authorizeAcceptancePublish.
//
// ⚠️ REDUCED TO ONE LEG BY MOTIR-4258 — see the block above the surviving test
// for what went and why. It used to drive three: expand and replan from the
// `/items` row's ⋯ menu, plus the nudge smoke. The ⋯ is gone, so the two
// menu-driven legs had no entrance to drive and were retired with it; the nudge
// smoke is what remains, and it still covers the EXPAND job end-to-end from
// `/ready` — the ready set is driven low, the expansion-nudge banner appears,
// the inline review opens and the approve writes real rows.
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

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  seedPlanChangeProposal,
  EXPAND_JOB_ID,
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

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ⚠️ THE `expand` AND `re-plan` LEGS ARE RETIRED (MOTIR-4258).
//
// Both drove the `/items` row's ⋯ menu — `Actions for <key>` → `Expand` /
// `Re-plan` → the in-place plan-edits dock. MOTIR-4258 removed that menu (the
// row's own click already opens the quick view, which carries the item's
// doors), and it was the ONLY mount passing `planEdits` to
// `WorkItemActionsMenu`, so the flow those two legs drove has no entrance in
// the product any more. A spec cannot be re-pointed at a door that does not
// exist, and leaving them here to fail on a missing locator would report a
// broken app rather than a retired one.
//
// WHAT STILL HAS COVERAGE, and what does not:
//   * EXPAND — covered end-to-end by the nudge leg below, which is a DIFFERENT
//     entrance to the same job (`/ready`'s ExpansionNudgeBanner calls
//     `submitExpandJob` directly, MOTIR-904) and asserts real DB state through
//     the real `POST /api/plans/:id/approve`.
//   * RE-PLAN — covered NOWHERE. `submitReplanJob` / `streamReplanJob` have no
//     caller left. That is a product question, not a test one, and it is
//     MOTIR-4261: retire the in-place replan, or give it an entrance. Do not
//     write a replacement leg here until that card decides which.
//
// The acceptance VIDEO consequence is named on MOTIR-4261 too — this spec runs
// under playwright.acceptance.config.ts and publishes story MOTIR-811's clip,
// which loses two of its three chapters until that card lands.

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
