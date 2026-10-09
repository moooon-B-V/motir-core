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
// smoke is what remains: the ready set is driven low, the expansion-nudge banner
// appears, and — since story MOTIR-5266 — Expand opens the planning overlay over
// `/ready` on the stub rather than running an expand job and an inline review.
//
// The one-shot "Augment from prompt" leg was RETIRED by MOTIR-1731 along with
// the button it drove — changing a plan is a CONVERSATION, so that flow's
// coverage is MOTIR-1733's conversational acceptance spec. The `/api/ai/augment`
// job path itself is untouched; only the per-surface button is gone.
//
// motir-ai is absent from CI, so the browser→ai boundary is STUBBED via
// `page.route` — the same open-core seam `ai-plan-generation.spec.ts` uses. The
// leg stops at the overlay opening, so nothing it asserts depends on a planner.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedAiAugmentReplan } from './_helpers/ai-augment-replan-seed';

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
//   * EXPAND — `/ready`'s ExpansionNudgeBanner no longer submits the expand job
//     (story MOTIR-5266): it opens a planning conversation on the stub, and the
//     nudge leg below asserts that door. The job itself survives for the MCP
//     `expand_item` tool.
//   * RE-PLAN — RETIRED, not uncovered (MOTIR-4261). The in-place dock replan
//     had no caller left, and the card chose to retire it rather than give it
//     a second per-item door: the hook, the dock, `/api/ai/replan` and its
//     stream are deleted. Re-planning an item is `WorkItemPlanEntrance`'s
//     Re-plan pill → the planning workspace (MOTIR-910), a CONVERSATION, and
//     its acceptance coverage is the conversational spec's, not this one's.
//
// The acceptance VIDEO consequence: this spec publishes story MOTIR-811's clip,
// which now carries ONE chapter (the nudge) where it carried three. MOTIR-811's
// acceptance recipe was amended by MOTIR-4261 to describe that flow.

test('nudge — near-drained project shows the expansion nudge and Expand opens the planning overlay on its stub', async ({
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
  await stubAiAccess(page);

  await signIn(page, seed.email, seed.password);
  await page.goto('/ready');

  // The nudge banner appears — it names the nominated stub. `.first()`: the key
  // appears in the banner sentence AND in the Expand hint under the button.
  await expect(page.locator(`text=${seed.notifKey}`).first()).toBeVisible({ timeout: 10_000 });

  const expandBtn = page.getByRole('button', { name: 'Expand' });
  await expect(expandBtn).toBeVisible();

  // Expand OPENS THE PLANNING OVERLAY over `/ready` (story MOTIR-5266): no job, no
  // poll, no inline review. The dialog is asked for BY ROLE, which the
  // accessibility tree resolves to the one live copy (MOTIR-4822 / MOTIR-3929).
  // What the planner then does with "Plan <KEY>" is MOTIR-7878's journey.
  await expandBtn.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(
    new RegExp(`/ready\\?.*planFrom=work-item&planItem=${seed.notifKey}`),
  );
});
