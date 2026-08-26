import { test, expect } from './_helpers/acceptance-video';
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
    await stripContentTrail(seed.unattributedPlanId);

    await page.goto(`/plans/${seed.unattributedPlanId}`);
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

test('the timeline GAINS a row when a proposal is edited — before and after, on one plan', async ({
  page,
  baseURL,
}) => {
  // The claim stated as a DELTA rather than as a final state, which the narrated
  // run above cannot do without showing the same plan twice. No camera: a
  // reviewer accepts this story by watching it work once.
  const seed = await seedAgentAuthoredPlan('plan-timeline-delta@example.com');
  const client = await agentSession(seed.token, mcpOrigin(baseURL));

  const { CREATE_PLAN_TOOL_NAME, ADD_PLAN_ITEMS_TOOL_NAME, UPDATE_PLAN_ITEM_TOOL_NAME } =
    await import('@/lib/mcp/tools/authorPlan');

  const created = await client.callTool({
    name: CREATE_PLAN_TOOL_NAME,
    arguments: {
      projectKey: seed.projectKey,
      title: 'Delta',
      plannedWithHarness: AGENT_HARNESS,
      plannedWithModel: AGENT_MODEL,
    },
  });
  const planId = (created.structuredContent as { id: string }).id;
  const appended = await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
    },
  });
  const planItemId = (appended.structuredContent as { planItemIds: string[] }).planItemIds[0]!;

  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);
  await page.goto(`/plans/${planId}`);

  const history = timeline(page);
  await expect(history).toContainText('1 proposal appended');
  await expect(history).not.toContainText('edited');
  const before = await history.getByRole('listitem').count();

  await client.callTool({
    name: UPDATE_PLAN_ITEM_TOOL_NAME,
    arguments: { planId, planItemId, storyPoints: 5, descriptionMd: 'A deepened body.' },
  });

  await page.reload();
  await expect(history).toContainText('1 proposal edited');
  await expect(history.getByRole('listitem')).toHaveCount(before + 1);

  await client.close();
});
