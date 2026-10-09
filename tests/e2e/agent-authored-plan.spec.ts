import type { Locator } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
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

/** The whole conversation ROW a plan sits in (`/plans` lists conversations since
 *  MOTIR-6025; an MCP plan opens its own). An agent's conversation has no first
 *  turn, so the row's title link is named by the plan's title.
 *
 *  ⚠️ FOUND BY ITS TITLE LINK, not by an `a[href="/plans/<id>"]` (Story MOTIR-7883 ·
 *  MOTIR-7889, 2026-10-08): an UNDECIDED plan's row and chip are overlay doors, whose
 *  href is the overlay address, so no link on the row names the plan's id. */
const conversationRow = (page: Parameters<typeof signIn>[0], planTitle: string) =>
  page
    .getByRole('list', { name: 'Planning conversations' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: planTitle, exact: true }) });

/** A row's state chip — the plan's door, named for the plan's state. */
const planChip = (row: Locator) => row.getByRole('link', { name: /^Open the plan — / });

const PLAN_TITLE = 'Marketplace payouts for sellers';

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
    title: PLAN_TITLE,
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
  });
  await client.close();

  await signInAsReviewer(page, seed);
  // The planning overlay the undecided plan is reviewed in (Story MOTIR-7883),
  // shared by the two chapters that read its proposed tree.
  let overlay: Locator | undefined;

  // ── Step 2–3 — the person finds it in Plans, and sees WHOSE it is ────────
  await chapter('The plan an agent wrote is waiting in Plans', async () => {
    // Reached by CLICKING the shipped access path, never by typing a URL.
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await expect(plansNav).toBeVisible();
    await plansNav.click();
    await page.waitForURL('**/plans');

    await expect(planChip(conversationRow(page, PLAN_TITLE))).toHaveAccessibleName(
      'Open the plan — Waiting for approval',
    );
    await beat();

    // The point of the whole story: WHO asked, and that an AGENT wrote it, on the
    // row where a reviewer decides which plan to open. The row is the agent's
    // conversation (MOTIR-6025): its starter is the token's owner, its origin
    // reads `Agent plan`, and the harness by name is the plan page's to show.
    const row = conversationRow(page, PLAN_TITLE);
    await expect(row).toContainText(seed.reviewerName);
    await expect(row).toContainText('Agent plan');
    await beat();
  });

  await chapter('Open it — the proposed tree', async () => {
    // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7889), 2026-10-08: the chip of an
    // undecided plan opens it in the planning overlay IN PLACE, over the Plans list —
    // the URL gains the overlay's session and the overlay's plan pane renders.
    await planChip(conversationRow(page, PLAN_TITLE)).click();
    await page.waitForURL(
      (url) => url.pathname === '/plans' && url.searchParams.has('planSession'),
    );
    overlay = page.getByRole('dialog', { name: /plan/i });
    await expect(overlay.getByTestId('plan-proposal-views')).toBeVisible();

    // ⚠️ THE CANVAS IS NOW ASKED FOR (MOTIR-3262, Story MOTIR-3232). The plan
    // detail's default body is DERIVED from the plan's shape: the LIST when its
    // proposals sit under more than one distinct container, because no single
    // canvas level can show such a plan. An agent-authored plan is exactly that —
    // a story under a committed parent, its children hung off the story by
    // temp-ref — so it opens on the list now.
    //
    // The URL is the single source of truth for which body is showing, so the
    // spec says which one it came to see instead of relying on a default that now
    // depends on the fixture's shape. That much is an ADDRESS change and nothing
    // more — the claim it guards is unchanged.
    //
    // ⚠️ THE NEXT TWO CHAPTERS ARE NOT PURELY THAT, and the difference is worth
    // reading before trusting this comment: MOTIR-3260 changed WHERE the canvas
    // arrives, so one assertion here genuinely moved with the product. It is
    // marked at the line it affects.
    //
    // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: the plan is
    // undecided, so it is reviewed in the planning overlay, which renders the same
    // proposal views; the canvas is asked for through its own switch (the overlay
    // never reads `?view=`). The plan page's header attribution — the rail's, which
    // the overlay does not draw — is asserted on the DECIDED page in the Approve
    // chapter below.
    await overlay
      .getByRole('group', { name: 'Plan view' })
      .getByRole('button', { name: 'Canvas', exact: true })
      .click();
    await expect(overlay.getByTestId('planning-canvas')).toBeVisible();

    // The tree the agent proposed, rendered from the PlanItems. The canvas shows
    // ONE LEVEL AT A TIME (`ProjectRoadmapCanvas` — never a whole-tree dump), and
    // the level it opens on is the one THE PLAN FILLS (MOTIR-3260, Story
    // MOTIR-3232): for this plan that is INSIDE the proposed story, so the
    // reviewer is greeted by the story's own crumb rather than by its card.
    await expect(
      overlay.getByRole('application', { name: 'Marketplace payouts plan' }),
    ).toBeVisible();
    await expect(
      overlay.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', {
        name: `New · ${authored.storyTitle}`,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await beat();
  });

  await chapter('The children the agent hung off it are already here', async () => {
    // This is the payoff of the append-order/temp-ref contract, shown rather
    // than asserted off-screen: the second `add_plan_items` batch named ids the
    // FIRST call returned, and here are its proposals, nested under that parent.
    //
    // ⚠️ THE CLAIM IS UNCHANGED; THE GESTURE IS GONE, and that is a product
    // change rather than a test convenience (MOTIR-3260, Story MOTIR-3232). This
    // chapter used to click the story's card and press Drill to reach them,
    // because the canvas opened at the top of the tree however deep the plan sat
    // — the reviewer had to go and find their own plan. It now ARRIVES on the
    // level the plan fills, so the children are on screen already and there is
    // no card to click, which is why the click was removed rather than
    // re-targeted.
    //
    // What replaces it is STRONGER about the nesting, not weaker: the leaves are
    // asserted as NODES on this level (`data-node-id`, not merely text that a
    // breadcrumb could satisfy), and the crumb asserted above says the level they
    // are on IS the proposed story. Together those state "these leaves hang off
    // that parent" more exactly than a drill gesture did.
    if (!overlay) throw new Error('the proposed tree was never opened');
    for (const title of authored.leafTitles) {
      await expect(overlay.locator('[data-node-id]').filter({ hasText: title })).toHaveCount(1);
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
    // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: an undecided
    // plan is approved in the overlay's decision footer.
    const decide = await openUndecidedPlan(page, authored.planId);
    const approve = decide
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Approve', exact: true });
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

    await page.goto(`/plans/${authored.planId}`); // decided: the plan page renders
    const main = page.getByRole('main');
    await expect(main.getByTestId('plan-status-pill')).toContainText('Approved');
    // The header spells the roles out, and adds the model the row omits — on the
    // plan's record, which keeps who asked and which agent wrote it.
    await expect(main.getByText(`Requested by ${seed.reviewerName}`)).toBeVisible();
    await expect(main.getByText(`written by ${AGENT_HARNESS}`)).toBeVisible();
    await expect(main.getByText(AGENT_MODEL)).toBeVisible();
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

test('the list renders the states the happy path skips — a long title, and no author at all', async ({
  page,
  baseURL,
}) => {
  const seed = await seedAgentAuthoredPlan('agent-plan-states@example.com');

  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Invoicing pipeline migration',
    harness: LONG_HARNESS,
  });
  await client.close();

  await signInAsReviewer(page, seed);
  await page.goto('/plans');

  // An agent's conversation has no first turn, so its row is titled by its
  // plan (MOTIR-6025 AC 1) and names the door that opened it. The long
  // self-reported harness is the plan page's attribution now, not the row's.
  const longRow = conversationRow(page, 'Invoicing pipeline migration');
  await expect(longRow).toBeVisible();
  await expect(longRow).toContainText('Invoicing pipeline migration');
  await expect(longRow).toContainText('Agent plan');
  await expect(longRow).not.toContainText(LONG_HARNESS);

  // A plan nobody is recorded as asking for: the starter entry is ABSENT — no
  // placeholder, no dash, nothing that reads as a value.
  const legacyRow = conversationRow(page, 'Crypto wallet checkout');
  await expect(legacyRow).toBeVisible();
  await expect(planChip(legacyRow)).toHaveAccessibleName('Open the plan — Waiting for approval');
  await expect(legacyRow).toContainText('Generated plan');
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
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: an undecided plan
  // is declined in the overlay's decision footer.
  const overlay = await openUndecidedPlan(page, authored.planId);

  const declined = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${authored.planId}/decline`) && r.request().method() === 'POST',
  );
  await overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Decline', exact: true })
    .click();
  // An ASKED plan's Decline confirms once, with an OPTIONAL reason (MOTIR-6037).
  await overlay
    .getByTestId('plan-decline-confirm')
    .getByRole('button', { name: 'Yes, decline' })
    .click();
  expect((await declined).status()).toBe(200);
  await page.goto(`/plans/${authored.planId}`); // decided: the plan page renders
  await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText('Declined');

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
