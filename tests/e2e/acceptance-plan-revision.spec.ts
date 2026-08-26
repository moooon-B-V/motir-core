import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  agentSession,
  seedAgentAuthoredPlan,
  authorPlanOverMcp,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
} from './_helpers/agent-authored-plan-seed';
import { aiGenerationService } from '@/lib/services/aiGenerationService';

// ACCEPTANCE — ask Motir to REVISE the plan you are reviewing (Story MOTIR-3595 ·
// Subtask MOTIR-3603). The story's `verification_recipe`, driven the way a person
// drives it, recorded as the receipt Yue watches to accept the story.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. The product
// change is not "a rail gained an input". It is that a reviewer holding a plan
// that is NEARLY right now has a third thing to do with it — and that what they
// approve afterwards is the plan they asked for rather than the one Motir first
// wrote. A recording that races from a plan to a different plan has met every
// acceptance criterion and shown none of that. So the BEFORE gets its own beat,
// on screen, before anything changes it.
//
// ⚠️ THE HANDLER'S HALF RUNS OUTSIDE THE BROWSER, and that is the product rather
// than a workaround — the same shape `acceptance-plan-timeline.spec.ts` states
// for its own edit. A revision is a JOB: the browser submits it and motir-ai
// performs it, calling back into core's internal seams. The acceptance lane mocks
// the motir-ai BOUNDARY (`E2E_TEST_AI_JOBS=1`), so the job dispatches for real and
// nothing performs it. This spec therefore plays the handler, through the SAME
// service methods its routes reach — `correctProposalForJob`,
// `withdrawProposalForJob`, and the `final` append that releases the lease. What
// stays real: the affordance, the submit route, the job dispatch, the lease, the
// page state, the approve, and the tree that comes out.
//
// The alternative — teaching the boundary mock to perform a revision — would put
// the assertion inside the harness and change a mock five other specs depend on.

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

/** The plan review rail — the surface under test. */
const rail = (page: Parameters<typeof signIn>[0]) =>
  page.getByRole('complementary', { name: 'Plan review' });

test('a reviewer asks for a change, and approves the plan they asked for', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3595');

  const seed = await seedAgentAuthoredPlan('plan-revision@example.com');
  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const authored = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Seller payouts',
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
  });

  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);

  // ── BEAT 1 — reach the plan by CLICKING the shipped access path ──────────
  await chapter('Open the plan in the review queue', async () => {
    // This story adds NO new door; the clip should show that it is reached
    // exactly as it always was.
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

  // ── BEAT 2 — READ the plan as it stands. Its own beat, deliberately ──────
  await chapter(
    'Read the plan as it stands — this is the tree that is about to change',
    async () => {
      await page.getByRole('radio', { name: 'List' }).click();
      const list = page.getByRole('main');
      // ⚠️ THE BEFORE, asserted explicitly. The whole change is that this tree
      // becomes a different tree, and a recording that races past the before has
      // shown nothing.
      for (const title of [authored.storyTitle, ...authored.leafTitles]) {
        await expect(list.getByText(title, { exact: false }).first()).toBeVisible();
      }
      // Nothing is marked as moved — nobody has revised it.
      await expect(page.getByText('Revised')).toHaveCount(0);
      await beat();
    },
  );

  // ── BEAT 3 — ASK for a specific, checkable change ────────────────────────
  const instruction = 'Drop the retries subtask and rename the schedule one';
  await chapter(
    'Ask Motir to change it — a third verb, beside two that would end the review',
    async () => {
      const ask = rail(page).getByRole('textbox', { name: 'Ask Motir to change this plan…' });
      await expect(ask).toBeVisible();
      await beat();

      await ask.fill(instruction);
      // The one thing a reviewer needs to know the moment an instruction exists.
      await expect(
        rail(page).getByText(/Nothing reaches your backlog until you approve/),
      ).toBeVisible();
      await beat();

      // ⚠️ ARM THE RESPONSE WAIT BEFORE THE CLICK. A revision is a JOB: the submit
      // answers `{ jobId, planId }` and the result arrives later, so every beat
      // gates on the write's own response or an authoritative read — never on a
      // rendered pending state and never on a fixed timeout.
      const dispatched = page.waitForResponse(
        (r) => r.url().includes('/api/ai/revise') && r.request().method() === 'POST',
      );
      await ask.press('Enter');
      const submitted = await dispatched;
      expect(submitted.status()).toBe(200);
      // The plan the change lands on is the plan the reviewer is holding — the
      // story's first criterion, on the wire.
      expect(((await submitted.json()) as { planId: string }).planId).toBe(authored.planId);
      await beat();
    },
  );

  // ── BEAT 4a — the plan is HELD while the revision runs ───────────────────
  await chapter('While Motir works, Approve is held — and says why', async () => {
    await expect(page.getByTestId('plan-revision-running')).toBeVisible();
    await expect(rail(page).getByText('Approve unlocks when the revision lands.')).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /Approve/ })).toBeDisabled();
    await beat();
  });

  // ── BEAT 4b — the handler's half, performed as motir-ai would ────────────
  // ⚠️ `adminDb`, NOT `db`. Under `motir_app` an UNBOUND statement against a
  // policy-gated table neither raises nor works — the read returns `[]` — so a
  // direct assertion through the code-under-test's connection can pass
  // VACUOUSLY. `db-reset.ts` says so in as many words; this is the
  // direct-DB-assertion client it points at.
  const jobId = (
    await adminDb.plan.findUniqueOrThrow({
      where: { id: authored.planId },
      select: { sourceJobId: true },
    })
  ).sourceJobId!;
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const proposals = await adminDb.planItem.findMany({
    where: { planId: authored.planId },
    orderBy: { createdAt: 'asc' },
  });
  const titleOf = (p: (typeof proposals)[number]) =>
    (p.proposedFields as { title?: string } | null)?.title ?? '';
  const retries = proposals.find((p) => titleOf(p) === 'Payout failure retries')!;
  const schedule = proposals.find((p) => titleOf(p) === 'Payout schedule')!;

  await aiGenerationService.withdrawProposalForJob(jobId, retries.id, ctx);
  await aiGenerationService.correctProposalForJob(
    jobId,
    schedule.id,
    { title: 'Payout schedule and cadence' },
    ctx,
  );
  await aiGenerationService.appendProposals(jobId, [], ctx, {
    revision: true,
    final: true,
    actor: { source: null, harness: AGENT_HARNESS, model: AGENT_MODEL },
  });

  // ── BEAT 4c — watch it LAND, without a reload ────────────────────────────
  await chapter(
    'Watch it land — the tree re-renders, and the timeline says what changed',
    async () => {
      // The island polls; the assertion waits on the AUTHORITATIVE read arriving,
      // never on a timeout.
      await expect(page.getByTestId('plan-revision-running')).toHaveCount(0, { timeout: 30_000 });

      const list = page.getByRole('main');
      await expect(list.getByText('Payout schedule and cadence').first()).toBeVisible();
      await expect(list.getByText('Payout failure retries')).toHaveCount(0);
      // …and the row that moved says so, where the reviewer is already looking.
      await expect(page.getByText('Revised').first()).toBeVisible();
      await beat();

      // The timeline gained the acts, named to the party that made them — so a
      // reviewer can see the plan changed while they held it.
      const history = rail(page).getByRole('list').first();
      await expect(history).toContainText('Revision started');
      await expect(history).toContainText('Revision landed');
      await expect(history).toContainText(`· ${AGENT_HARNESS}`);
      await beat();
    },
  );

  // ── BEAT 5 — APPROVE, and the tree is the REVISED shape ──────────────────
  await chapter('Approve — and what appears is the plan you asked for', async () => {
    const approve = rail(page).getByRole('button', { name: /Approve/ });
    await expect(approve).toBeEnabled();
    await beat();

    const approved = page.waitForResponse(
      (r) => r.url().includes(`/plans/${authored.planId}`) && r.request().method() !== 'GET',
    );
    await approve.click();
    expect((await approved).status()).toBeLessThan(400);
    await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');
    await beat();
  });

  // ⚠️ ASSERTED ON THE MATERIALIZED WORK ITEMS — the story's actual promise is
  // about the TREE, and a proposal-set assertion would pass with a materialize
  // that ignored every correction.
  const created = await adminDb.workItem.findMany({
    where: { projectId: seed.projectId },
    select: { title: true },
  });
  const titles = created.map((w) => w.title).sort();
  // ⚠️ GUARD ON ABSENCE FIRST. Every `not.toContain` below passes on an EMPTY
  // array, so without this line an unbound or mis-scoped read would report the
  // strongest claim in the spec as satisfied by reading nothing at all.
  expect(titles.length, 'approve materialized no work item at all').toBeGreaterThan(0);
  expect(titles).toContain('Payout schedule and cadence');
  expect(titles).not.toContain('Payout schedule');
  expect(titles).not.toContain('Payout failure retries');
});
