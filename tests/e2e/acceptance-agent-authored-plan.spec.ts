import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { plansService } from '@/lib/services/plansService';
import {
  agentSession,
  authorPlanOverMcp,
  seedAgentAuthoredPlan,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
  LONG_HARNESS,
  type AgentPlanSeed,
} from './_helpers/agent-authored-plan-seed';

// ACCEPTANCE — an agent AUTHORS a plan, a person reviews it and approves
// (Story MOTIR-2982 · Subtask MOTIR-2993). The story's `verification_recipe`,
// driven the way a person drives it, and recorded as the receipt Yue watches to
// accept the story.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing: the whole
// product change is that a tree an AGENT wrote shows up somewhere a PERSON can
// read it, labelled honestly, and becomes real only when they say so. A
// recording that races from "authored" to "approved" has met every acceptance
// criterion and shown none of that. So the proposal state gets its own chapter
// and its own beat — the tree is on screen, and the backlog is still empty —
// before anybody presses Approve.
//
// ── THE FLOW STARTS OUTSIDE THE BROWSER, and that is not a workaround ───────
// An agent authoring a plan is an HTTP call to `/api/mcp` carrying a bearer.
// The fixture mints a REAL project-scoped token with the two permissions
// `docs/decisions/agent-authored-plans.md` Q2 pins, and the tools are called
// through the REAL MCP SDK over the REAL streamable-HTTP transport against this
// lane's own server — the shape `cli-connect-seed.ts`'s `mcpBearerWorks` already
// proves reachable here. NO `page.route` stub: a stubbed transport would make
// the spec assert its own harness, and the entire claim under test is that an
// arbitrary token-holding agent can reach the substrate and that Motir gates it.
//
// WHICH TEST CARRIES THE CAMERA: only the first. The states the happy path
// skips — the long self-reported harness, a plan nobody authored, and DECLINE —
// are asserted in their own tests below, deliberately not narrated into the
// video: a reviewer accepts this Story by watching it work, not by watching
// three ways it can look different.

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/**
 * Playwright's own origin, asserted present.
 *
 * The MCP transport is the one part of this flow that does not go through the
 * `page`, so it has to be told where the server is — and the fixture is the only
 * runner-side authority for that (`MOTIR_BASE_URL` is the webServer's env, not
 * the runner's). Failing here names the cause; letting it default sends every
 * test to `TypeError: fetch failed` at the transport instead.
 */
function mcpOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  return baseURL;
}

/** The Plans list row for a plan, addressed by its link target. */
const planRow = (page: Parameters<typeof signIn>[0], planId: string) =>
  page.locator(`a[href="/plans/${planId}"]`);

async function signInAsReviewer(page: Parameters<typeof signIn>[0], seed: AgentPlanSeed) {
  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);
}

test('an agent authors a plan over the MCP; a person reviews it and approves', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2982');

  const seed = await seedAgentAuthoredPlan('agent-plan@example.com');

  // ── Step 1 — the agent authors, over the real MCP ────────────────────────
  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const authored = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Marketplace payouts for sellers',
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
  });
  await client.close();

  await signInAsReviewer(page, seed);

  // ── Step 2–3 — the person finds it in Plans, and sees WHOSE it is ────────
  await chapter('The plan an agent wrote is waiting in Plans', async () => {
    // Reached by CLICKING the shipped access path, never by typing a URL.
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await expect(plansNav).toBeVisible();
    await plansNav.click();
    await page.waitForURL('**/plans');

    const row = planRow(page, authored.planId);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Planned');
    await expect(row).toContainText('3 items');
    await beat();

    // The point of the whole story: WHO asked and WHO wrote, on the row where a
    // reviewer decides which plan to open.
    await expect(row).toContainText(seed.reviewerName);
    await expect(row).toContainText(`via ${AGENT_HARNESS}`);
    await beat();
  });

  await chapter('Open it — the proposed tree, and the attribution again', async () => {
    await planRow(page, authored.planId).click();
    await page.waitForURL(`**/plans/${authored.planId}`);

    await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');
    // The header spells the roles out, and adds the model the row omits.
    await expect(page.getByText(`Requested by ${seed.reviewerName}`)).toBeVisible();
    await expect(page.getByText(`written by ${AGENT_HARNESS}`)).toBeVisible();
    await expect(page.getByText(AGENT_MODEL)).toBeVisible();
    await beat();

    // The tree the agent proposed, rendered from the PlanItems. The canvas shows
    // ONE LEVEL AT A TIME (`ProjectRoadmapCanvas` — never a whole-tree dump), so
    // the root proposal is what greets the reviewer.
    await expect(page.getByLabel('Proposed plan canvas')).toBeVisible();
    await expect(page.getByText(authored.storyTitle)).toBeVisible();
    await beat();
  });

  await chapter('Drill in — the children the agent hung off it', async () => {
    // This is the payoff of the append-order/temp-ref contract, shown rather
    // than asserted off-screen: the second `add_plan_items` batch named ids the
    // FIRST call returned, and here are its proposals, nested under that parent.
    await page.locator('[data-node-id]').filter({ hasText: authored.storyTitle }).first().click();
    const drill = page.getByTestId('drill-button');
    await expect(drill).toBeVisible();
    await drill.click();

    for (const title of authored.leafTitles) {
      await expect(page.getByText(title)).toBeVisible();
    }
    await beat();
  });

  // ── Step 4 (first half) — NOTHING is real yet ────────────────────────────
  await chapter('None of it exists yet — the backlog is untouched', async () => {
    // The single most important property of the story, shown rather than
    // asserted off-screen: the same titles that are on the canvas are nowhere in
    // the work-item tree.
    await page.goto('/items');
    for (const title of [authored.storyTitle, ...authored.leafTitles]) {
      await expect(page.getByText(title)).toHaveCount(0);
    }
    await beat();
  });

  // ── Step 4 (second half) — approve, and only now is it work ──────────────
  await chapter('Approve — and the proposals become real work', async () => {
    await page.goto(`/plans/${authored.planId}`);
    const approve = page.getByRole('button', { name: /Approve/ });
    await expect(approve).toBeVisible();

    // Arm the response wait BEFORE the click so the persisted flip cannot be
    // missed (the E2E discipline — never a fixed sleep).
    const approved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/plans/${authored.planId}/approve`) &&
        r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status()).toBe(200);

    await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');
    await beat();
  });

  await chapter('What the agent proposed is now the project’s tree', async () => {
    // `/items` renders LAZILY, one level at a time — the children are not in the
    // DOM until the parent row is expanded (the treegrid's ArrowRight, which is
    // what a keyboard user presses and what a coordinate click on the chevron
    // only approximates).
    await page.goto('/items');
    await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();
    const storyRow = page.getByRole('row').filter({ hasText: authored.storyTitle }).first();
    await expect(storyRow).toBeVisible();
    await beat();

    await storyRow.press('ArrowRight');
    for (const title of authored.leafTitles) {
      await expect(page.getByText(title).first()).toBeVisible();
    }
    await beat();
  });

  // ── Step 4 (the record) — the items say who planned them ────────────────
  await chapter('Each item records the agent that planned it', async () => {
    const created = await db.workItem.findFirstOrThrow({
      where: { projectId: seed.projectId, title: authored.storyTitle },
    });
    await page.goto(`/items/${created.identifier}`);

    // Provenance is COLLAPSED by default at the bottom of the rail
    // (work-item-provenance.md Decision 7) — open it, as a reader would.
    const disclosure = page.getByRole('button', { name: /Provenance/i });
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    await expect(page.getByText(AGENT_HARNESS).first()).toBeVisible();
    // `mcp`-sourced items EXPOSE their model, where a native one is stripped.
    await expect(page.getByText(AGENT_MODEL).first()).toBeVisible();
    await beat();
  });
});

test('the list renders the states the happy path skips — long harness, and no author at all', async ({
  page,
  baseURL,
}) => {
  const seed = await seedAgentAuthoredPlan('agent-plan-states@example.com');

  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const long = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Invoicing pipeline migration',
    harness: LONG_HARNESS,
  });
  await client.close();

  await signInAsReviewer(page, seed);
  await page.goto('/plans');

  // A long self-reported harness truncates rather than pushing the row around,
  // and the FULL value stays reachable on the element's title (design Part III §5).
  const longRow = planRow(page, long.planId);
  await expect(longRow).toBeVisible();
  const harness = longRow.getByTitle(LONG_HARNESS);
  await expect(harness).toBeVisible();
  const truncated = await harness.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated, 'the long harness is clipped rather than laid out full-width').toBe(true);
  // The plan TITLE is not shortened by it — it keeps its own ellipsis.
  await expect(longRow).toContainText('Invoicing pipeline migration');

  // A plan predating the columns: the attribution entry is ABSENT — no
  // placeholder, no dash, nothing that reads as a value.
  const legacyRow = planRow(page, seed.unattributedPlanId);
  await expect(legacyRow).toBeVisible();
  await expect(legacyRow).toContainText('Planned');
  await expect(legacyRow).not.toContainText('via ');
  await expect(legacyRow).not.toContainText(seed.reviewerName);
});

test('DECLINE leaves the tree exactly as it was', async ({ page, baseURL }) => {
  const seed = await seedAgentAuthoredPlan('agent-plan-decline@example.com');

  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const authored = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Refund flow',
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
  });
  await client.close();

  const before = await db.workItem.count({ where: { projectId: seed.projectId } });

  await signInAsReviewer(page, seed);
  await page.goto(`/plans/${authored.planId}`);

  const declined = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${authored.planId}/decline`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Decline/ }).click();
  expect((await declined).status()).toBe(200);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Declined');

  // A project-wide COUNT, not the absence of a particular title.
  expect(await db.workItem.count({ where: { projectId: seed.projectId } })).toBe(before);
  // …and the plan is still readable, with its attribution intact — declining is
  // a decision about the proposal, not an erasure of who made it.
  const review = await plansService.getPlan(authored.planId, {
    userId: seed.userId,
    workspaceId: seed.workspaceId,
  });
  expect(review.authorHarness).toBe(AGENT_HARNESS);
  expect(review.createdById).toBe(seed.userId);
});
