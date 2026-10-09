import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  agentSession,
  seedAgentAuthoredPlan,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
} from './_helpers/agent-authored-plan-seed';
import { authorPlanWithEdits, stripContentTrail } from './_helpers/plan-timeline-seed';
import { plansService } from '@/lib/services/plansService';

// ACCEPTANCE — a plan's timeline records what CHANGED, not only that its status
// moved (Story MOTIR-3532 · Subtask MOTIR-3538). The story's
// `verification_recipe`, driven the way a person drives it, and recorded as the
// receipt Yue watches to accept the story.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. The product
// change is not "a list gained rows". It is that a person about to press Approve
// can see that the thing in front of them CHANGED, when, and who changed it —
// and that when an agent did it, the row says so without pretending to be a
// person. A recording that races from an empty timeline to a full one has met
// every acceptance criterion and shown none of that. So the timeline BEFORE gets
// its own beat, on screen, before anything is added to it.
//
// ⚠️ THE EDIT HAPPENS OUTSIDE THE BROWSER, and that is the product rather than a
// workaround. `design/ai-planning/design-notes.md` Part V §3 removed the
// plan-review edit modal in favour of a read-only quick view: a proposal is
// edited by the agent that wrote it, over `update_plan_item` on the real MCP.
// Driving a door the product does not have would make the spec assert its own
// harness — the same reason `acceptance-agent-authored-plan.spec.ts` refuses to
// stub the transport.
//
// WHICH TEST CARRIES THE CAMERA: only the first. The legacy state has its own
// test below and is shown INSIDE the narrated run as its final chapter, because
// "every plan you already have looks exactly as it did" is part of what a
// reviewer is being asked to accept.

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

function mcpOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  return baseURL;
}

/** The plan review rail's HISTORY list — the surface under test. */
const timeline = (page: Parameters<typeof signIn>[0]) =>
  page.getByRole('complementary', { name: 'Plan review' }).getByRole('list').first();

test('an agent edits a proposal, and the change arrives on the plan’s own timeline', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3532');

  const seed = await seedAgentAuthoredPlan('plan-timeline@example.com');
  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const authored = await authorPlanWithEdits(client, seed.projectKey, {
    title: 'Seller payouts',
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
  });

  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);

  // ── Steps 1–2 — open the plan, and READ the timeline as it stands ────────
  await chapter('Open the plan in the review queue', async () => {
    // Reached by CLICKING the shipped access path, never by typing a URL — this
    // Part adds no new door, and the clip should show that.
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await expect(plansNav).toBeVisible();
    await plansNav.click();
    await page.waitForURL('**/plans');

    const row = page.locator(`a[href="/plans/${authored.planId}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await page.waitForURL(`**/plans/${authored.planId}`);
    await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');
    await beat();
  });

  await chapter('Its history says what HAPPENED, not only that its status moved', async () => {
    const history = timeline(page);
    await expect(history).toBeVisible();

    // The lifecycle events that shipped before this story — still here, unchanged.
    await expect(history).toContainText('Generation started');
    await expect(history).toContainText('Plan ready');
    await beat();

    // …and the two acts they could never express. THREE proposals arrived in two
    // appends by one agent, and the timeline folds them into the ONE act they
    // were; the deepens fold the same way, and carry a time SPAN.
    await expect(history).toContainText('3 proposals appended');
    await expect(history).toContainText('2 proposals edited');
    await beat();
  });

  // ── Step 4 — who did it, and the agent is not dressed as a person ────────
  await chapter('Every change names the party that made it', async () => {
    const history = timeline(page);

    // The agent, by its HARNESS. Not an avatar, not an initial disc, not a
    // model identifier — a harness name is not a person's name.
    await expect(history).toContainText(`· ${AGENT_HARNESS}`);
    await expect(history.locator('img')).toHaveCount(0);
    await beat();

    // The MODEL is on the header, once, where it has room — never repeated on
    // every row.
    await expect(page.getByText(AGENT_MODEL)).toBeVisible();
    await expect(history).not.toContainText(AGENT_MODEL);
    await beat();
  });

  // ── Step 5 — the decision joins the same sequence, as a PERSON ───────────
  await chapter('Decide it — and the decision joins the same sequence', async () => {
    const decline = page.getByRole('button', { name: /Decline/ });
    await expect(decline).toBeVisible();

    // Arm the response wait BEFORE the click, so the persisted flip cannot be
    // missed (the E2E discipline — never a fixed sleep).
    const decided = page.waitForResponse(
      (r) => r.url().includes(`/plans/${authored.planId}`) && r.request().method() !== 'GET',
    );
    await decline.click();
    // An ASKED plan's Decline confirms once, with an OPTIONAL reason (MOTIR-6037).
    await page
      .getByTestId('plan-decline-confirm')
      .getByRole('button', { name: 'Yes, decline' })
      .click();
    expect((await decided).status()).toBeLessThan(400);

    const history = timeline(page);
    await expect(history).toContainText('Declined');
    // The decider is a PERSON, named plainly, on the same list and in the same
    // grammar as the agent's rows above — which is the whole point of there
    // being one list.
    await expect(history).toContainText(`· ${seed.reviewerName}`);
    await expect(history).toContainText(`· ${AGENT_HARNESS}`);
    await beat();
  });

  // ── Step 6 — the plans you already have are untouched ────────────────────
  await chapter('A plan from before this shipped renders exactly as it did', async () => {
    // The row-level state of EVERY plan that predates the trail. It has to be
    // made rather than found: once the trail ships, every plan the product
    // creates has one.
    //
    // DECIDED FIRST (re-pointed by Story MOTIR-7883, 2026-10-08): the timeline is
    // the plan PAGE's record, and a member's `/plans/<id>` for an undecided plan now
    // lands in the planning overlay, which draws no history. A decided plan keeps
    // its page. Declined BEFORE the strip, so the strip still leaves exactly the
    // row-level state of a plan from before the trail.
    await plansService.declinePlan(seed.unattributedPlanId, {
      userId: seed.userId,
      workspaceId: seed.workspaceId,
    });
    await stripContentTrail(seed.unattributedPlanId);

    await page.goto(`/plans/${seed.unattributedPlanId}`); // decided: the plan page renders
    const history = timeline(page);
    await expect(history).toContainText('Generation started');
    await expect(history).toContainText('Plan ready');

    // Nothing was added, and — the part that matters — nothing APOLOGISES for it.
    await expect(history).not.toContainText('appended');
    await expect(history).not.toContainText('edited');
    await expect(history).not.toContainText(/no changes/i);
    await beat();
  });

  await client.close();
});

// ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7887): a test here read an
// UNDECIDED plan's timeline on its own page, had the agent edit a proposal, and
// asserted the timeline gained exactly one row. The edit needs the plan undecided,
// and a member's `/plans/<id>` for an undecided plan now lands in the planning
// overlay, which draws no history — so the before/after cannot be read on one plan
// in a browser any more. Still covered by
// `tests/integration/plans/planTrailCompleteness.test.ts` ("every act reaches the
// trail, and the timeline reads the two the lifecycle cannot say") and the row
// rendering by `tests/components/plan-review-rail-content-events.test.tsx`.
