// E2E — AI plan GENERATION, the generation-side slice (Subtask 7.4.7 / MOTIR-849).
//
// Drives the 7.4 generation ENTRY (7.4.9 / MOTIR-1396) in a real browser: from the
// onboarding hand-off the user triggers "Generate plan", and proposed `add`
// PlanItems stream LIVE onto the canvas as the engine appends them — epics first,
// then the frontier — bundled into a `planned` Plan that is NEVER dispatchable
// (the proposals are PlanItems, not work items; nothing reaches the ready set /
// board until a separate approve, which is Story 7.21's surface — out of scope).
//
// motir-ai is server-to-server infrastructure absent from CI, so the browser→ai
// boundary is STUBBED via `page.route` — exactly the open-core seam (the browser
// only ever talks to motir-core's /api/ai/* routes), the same mechanism
// `onboarding-discovery.spec.ts` uses. There is NO live model. The REAL per-node
// append is driven by `plansService.addProposals` against the seeded Plan (the
// service the internal append seam wraps), so the running app's reveal poll
// (`GET /api/plans/:id`) surfaces REAL persisted `PlanItem` rows — the test asserts
// the live-generation loop + the real substrate, not model quality.
//
// The resume / no-duplicate-PlanItems guarantee is motir-ai's `generate_tree`
// handler (7.4.2 / MOTIR-844) and is covered there (MOTIR-1444) — a motir-core E2E
// that stubs motir-ai cannot assert it, so it is deliberately NOT here.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiPlanGeneration,
  AI_GEN_JOB_ID,
  type AiPlanGenerationSeed,
} from './_helpers/ai-plan-generation-seed';
import { plansService, TEMP_REF_PREFIX } from '@/lib/services/plansService';

// Seeding + sign-in + cold-compiled /onboarding + /plans (dev mode compiles each
// route on first hit), a warm-up mount of the generation surface, plus the
// reveal-poll cadence (2.5s) — well beyond the 30s default.
test.describe.configure({ timeout: 180_000 });

// ── The stubbed browser→motir-ai boundary ──────────────────────────────────────

// A tiers-complete pre-plan snapshot: `status: 'tiers_complete'` makes
// `isTiersComplete` true so the hub shows "Go to plan phase"; `currentGate`
// resolves to no active tier, so hydrate lands on the HUB (not a review gate).
const TIERS = ['discovery', 'vision', 'feasibility', 'validation'] as const;
const TIERS_COMPLETE_PREPLAN = {
  session: {
    classification: 'startup',
    platform: 'web',
    designStarter: null,
    validationTiming: 'standard',
    docSkipSet: [] as string[],
    currentGate: 'tiers_complete',
    status: 'tiers_complete',
    conversation: [],
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  },
  docs: TIERS.map((kind) => ({
    kind,
    currentBody: `# ${kind} (Tier)\n\nReady.`,
    currentVersion: 1,
    summary: [] as string[],
    versions: [
      {
        version: 1,
        changeReason: null,
        changeKind: null,
        diff: null,
        createdAt: '2026-06-21T00:00:00.000Z',
      },
    ],
  })),
  catalog: null,
};

// The AI-boundary paywall read: not applicable (no metering in this stubbed lane),
// so the chat rail never renders an upsell.
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

// The terminal-outcome stream is the FAILURE channel only (the poll owns success);
// a `running` frame then a clean close = no failure, so success is left to the poll.
const GENERATE_SSE = `event: status\ndata: ${JSON.stringify({ status: 'running' })}\n\n`;

async function stubGenerationBoundary(page: Page, planId: string): Promise<void> {
  await page.route('**/api/ai/pre-plan', async (route) => {
    if (route.request().method() !== 'GET') {
      // The hub's best-effort theme-preview save — accept and ignore.
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TIERS_COMPLETE_PREPLAN),
    });
  });

  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });

  // POST /api/ai/plan/generate → open-a-job stub: hand back the SEEDED generating
  // Plan (a real, pollable row) + the known job id, so the reveal poll reads real
  // PlanItem rows the test appends.
  await page.route('**/api/ai/plan/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: AI_GEN_JOB_ID, planId }),
    });
  });

  await page.route('**/api/ai/plan/generate/*/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: GENERATE_SSE,
    });
  });
}

// ── The proposed tree the engine "appends" (epics → frontier, with an edge) ─────
const AUTH = 'Authentication';
const BILLING = 'Billing';
const LOGIN = 'Login form';
const STRIPE = 'Stripe setup';
const ALL_TITLES = [AUTH, BILLING, LOGIN, STRIPE];

function titleOf(items: { id: string; proposedFields: { title: string } | null }[], title: string) {
  const found = items.find((i) => i.proposedFields?.title === title);
  if (!found) throw new Error(`proposal not found: ${title}`);
  return found.id;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('generation streams proposed PlanItems live into a planned Plan; the proposals are never dispatchable', async ({
  page,
}) => {
  const seed: AiPlanGenerationSeed = await seedAiPlanGeneration(
    `ai-plan-gen-${Date.now()}@example.com`,
  );
  await stubGenerationBoundary(page, seed.planId);

  // Sign in + enter the immersive onboarding hub. The tiers-complete pre-plan stub
  // lands on the hub with the "Go to plan phase" exit. The hub is at
  // /onboarding/discovery now (/onboarding is the entrance fork, MOTIR-1462).
  await signIn(page, seed.email, seed.password);
  await page.goto('/onboarding/discovery');

  await page.getByRole('button', { name: 'Go to plan phase' }).click();
  // The pre-plan → generation hand-off, then the 7.4 generation trigger.
  await expect(page.getByTestId('generation-handoff')).toBeVisible();
  await page.getByRole('button', { name: 'Generate plan' }).click();

  // GenerationFlow mounts + auto-starts: the live "Generating your plan…" state.
  // (The auto-start is StrictMode-safe so it survives dev's double-mount — see the
  // GenerationFlow fix in this PR; otherwise the generate request is aborted and
  // never retried, and this never appears under `next dev`.)
  const progress = page.getByRole('status').filter({ hasText: 'Generating your plan' });
  await expect(progress).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('roadmap-canvas')).toBeVisible();

  // ── Epics first: append the top-level proposals (Billing blocked_by Auth) ──────
  const a = await plansService.addProposals(
    seed.planId,
    [{ op: 'add', proposedFields: { title: AUTH, kind: 'epic' } }],
    seed.ctx,
  );
  const authId = titleOf(a.items, AUTH);
  const b = await plansService.addProposals(
    seed.planId,
    [
      {
        op: 'add',
        proposedFields: { title: BILLING, kind: 'epic' },
        blockedByRefs: [`${TEMP_REF_PREFIX}${authId}`],
      },
    ],
    seed.ctx,
  );
  const billingId = titleOf(b.items, BILLING);

  // The two epics REVEAL live at the canvas root (the real reveal poll surfaces the
  // persisted rows — an authoritative wait, not the optimistic UI). The timeout
  // absorbs the 2.5s reveal-poll cadence under CI load (never a fixed sleep).
  const POLL_REVEAL = 15_000;
  await expect(page.getByTestId('plan-item-node')).toHaveCount(2, { timeout: POLL_REVEAL });
  await expect(progress).toContainText('2 items', { timeout: POLL_REVEAL });

  // ── Then drilling the frontier: a child under each epic ───────────────────────
  await plansService.addProposals(
    seed.planId,
    [
      {
        op: 'add',
        proposedFields: { title: LOGIN, kind: 'story' },
        parentRef: `${TEMP_REF_PREFIX}${authId}`,
      },
      {
        op: 'add',
        proposedFields: { title: STRIPE, kind: 'story' },
        parentRef: `${TEMP_REF_PREFIX}${billingId}`,
      },
    ],
    seed.ctx,
  );

  // The count climbs and the epics become drillable (they now have children).
  await expect(progress).toContainText('4 items', { timeout: POLL_REVEAL });
  await expect(page.getByTestId('drill-affordance').first()).toBeVisible({ timeout: POLL_REVEAL });

  // ── Complete generation → a `planned` Plan; the entry hands off to /plans/:id ──
  await plansService.markPlanned(seed.planId, seed.ctx);
  await page.waitForURL(`**/plans/${seed.planId}`);
  // The review surface renders the bundled, planned proposal forest (a cold-compiled
  // /plans route on first hit — allow headroom).
  await expect(page.getByTestId('plan-item-node').first()).toBeVisible({ timeout: POLL_REVEAL });

  // ── The proposals are REAL PlanItem rows, parented per the grammar with a
  //    blocked_by edge — and NONE is dispatchable (no WorkItem was materialized) ──
  const items = await db.planItem.findMany({ where: { planId: seed.planId } });
  expect(items).toHaveLength(4);
  const byTitle = new Map(
    items.map((i) => [(i.proposedFields as { title?: string } | null)?.title, i]),
  );
  const auth = byTitle.get(AUTH)!;
  const billing = byTitle.get(BILLING)!;
  expect(billing.blockedByRefs).toContain(`${TEMP_REF_PREFIX}${auth.id}`);
  expect(byTitle.get(LOGIN)!.parentRef).toBe(`${TEMP_REF_PREFIX}${auth.id}`);
  expect(byTitle.get(STRIPE)!.parentRef).toBe(`${TEMP_REF_PREFIX}${billing.id}`);
  // Non-dispatchable: every `add` is un-materialized (no work item), so nothing
  // can appear in the ready set / board / `motir next`.
  for (const item of items) expect(item.workItemId).toBeNull();
  const materialized = await db.workItem.count({
    where: { projectId: seed.projectId, title: { in: ALL_TITLES } },
  });
  expect(materialized).toBe(0);

  // The Plan is `planned` and bundles exactly the four proposals.
  const plan = await db.plan.findUniqueOrThrow({ where: { id: seed.planId } });
  expect(plan.status).toBe('planned');
});
