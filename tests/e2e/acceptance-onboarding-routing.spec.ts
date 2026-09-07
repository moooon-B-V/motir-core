// Acceptance E2E — WHERE THREE PROJECTS END UP (Subtask MOTIR-4762, Story
// MOTIR-4753).
//
// ⚠️ THE STORY'S DELIVERABLE IS A DIFFERENCE, so the recording has to show more
// than one journey. A clip of only the fast path is indistinguishable from a
// build that skips onboarding for everybody — which is precisely the outcome
// this story must not have shipped. All three destinations are in ONE recording,
// chaptered, and what a viewer must be able to tell apart is where each project
// ends up:
//
//   1 · a repository Motir can READ, and a backlog  → it PLANS. No onboarding.
//   2 · nothing at all                              → new-project onboarding.
//   3 · a repository that is not enough             → "I have a project", with a
//                                                     rail SHORTER than the full
//                                                     one.
//
// ── WHAT IS REAL AND WHAT IS MOCKED ────────────────────────────────────────
// The SUBSTRATE is real: a genuine grant-mirror row and a genuine succeeded
// `system.code-graph-index` ledger row, both written the way the product writes
// them, so `readOnboardingSubstrate` answers from committed state and the
// reading state names what it actually found. The VERDICT is `motir-ai`'s and is
// mocked at the open-core boundary — the only interceptable seam, and the same
// one every other cloud spec uses. The planner's judgement is the `motir-ai`
// gate's to prove (MOTIR-4760); from here it is exercised through the product,
// as a user meets it.
//
// ── THE LANE, VERIFIED BEFORE A LINE WAS WRITTEN (criterion 6) ──────────────
// Each seam these journeys cross, with the config line that installs it:
//
//   the plan window mounts at all      `MOTIR_CLOUD: '1'` — playwright.acceptance.config.ts
//                                      (the overlay is behind `isMotirAiConfigured()`)
//   the routing job + its settle       `E2E_TEST_AI_JOBS: '1'` + `MOTIR_AI_JOBS_FIXTURE_PATH`
//                                      — same file; `lib/test-ai-jobs-mock.ts` answers
//                                      `POST /v1/jobs` and `GET /v1/jobs/:id`
//   the connected repository           `lib/test-github-repos-mock.ts` is not needed —
//                                      the grant MIRROR is seeded directly, which is
//                                      what `resolveCodeContext` reads
//
// ⚠️ AND ONE OF THEM DID NOT EXIST. Until this card the jobs mock settled every
// `plan` job as a plain success, so a plan window asking for a verdict got none
// and all three journeys ended in the workspace. That is the failure mode
// criterion 6 is written against: a lane that cannot reach the asserted state
// does not go red, it goes GREEN on the unfixed code. `RoutingJobOutcome` and the
// `plan_routing` discrimination were added to the mock first, keyed on
// `context.routeOnboarding` — the product's own discriminator, not a second one.
//
// DETERMINISM (`motir-core/CLAUDE.md`): every wait is a role/text landmark, a
// `waitForURL`, or a response the page actually issued. No `waitForTimeout`.
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  declareRoutingVerdict,
  seedConnectedOnlyRepository,
  seedReadableRepository,
  seedRoutingJourney,
  ROUTING_JOURNEY_PASSWORD,
} from './_helpers/onboarding-routing-seed';

test.describe.configure({ timeout: 240_000 });

const workspace = (page: Page) => page.getByRole('dialog');
const readingState = (page: Page) => page.getByTestId('planning-reading-state');
const handOff = (page: Page) => page.getByTestId('planning-handoff');

/**
 * Open the plan window on the active project by writing the overlay's own
 * address — the same four parameters every door writes (MOTIR-4728).
 *
 * The AUTHORITATIVE SIGNAL that the routing run started is the dispatch's own
 * 200, armed BEFORE the navigation so it cannot be missed.
 */
async function openPlanWindow(page: Page): Promise<void> {
  const dispatched = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan/route-onboarding' &&
      r.request().method() === 'POST',
  );
  await page.goto('/roadmap?plan=project&planFrom=project');
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect((await dispatched).status()).toBe(200);
}

test('three projects, three destinations', async ({ page, chapter, beat, acceptanceStory }) => {
  acceptanceStory('MOTIR-4753');

  // ── 1 ────────────────────────────────────────────────────────────────────
  await chapter('A repository Motir can read — it plans, and asks', async () => {
    await resetDatabase();
    const seed = await seedRoutingJourney('routing-continue@e2e.motir.test', {
      items: 3,
      identifier: 'RONE',
    });
    await seedReadableRepository(seed.workspaceId);
    declareRoutingVerdict({
      outcome: 'continue',
      message: 'I can see acme-index-e2e and your 3 work items. What do you want to plan first?',
    });

    await signIn(page, 'routing-continue@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // The window says what it is READING, by name — the sentence the whole story
    // argues for, before any plan exists to judge.
    await expect(readingState(page)).toBeVisible();
    await expect(readingState(page)).toContainText('work items');
    await beat();

    // …and then it is simply a workspace. NO onboarding, no hand-off: a regular
    // session waits to be told what to plan.
    await expect(handOff(page)).toHaveCount(0);
    await expect(readingState(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/roadmap\?/);
    await beat();
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  await chapter('Nothing to read — new-project onboarding', async () => {
    await resetDatabase();
    await seedRoutingJourney('routing-new@e2e.motir.test', { identifier: 'RTWO' });
    declareRoutingVerdict({
      outcome: 'onboard_new_project',
      message:
        "There's nothing here yet for me to plan from. A few short questions about what you're building and who it's for, and I'll have enough to write you a plan.",
    });

    await signIn(page, 'routing-new@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // The THIN reading state — a sentence, never an empty list.
    await expect(readingState(page)).toContainText('no repository connected here yet');
    await beat();

    // The hand-off is SHOWN. Nothing has moved yet: the user presses the button.
    await expect(handOff(page)).toHaveAttribute('data-outcome', 'onboard_new_project');
    await expect(handOff(page)).toContainText("There's nothing here yet");
    await expect(page).toHaveURL(/\/roadmap\?/);
    await beat();

    await page.getByRole('button', { name: 'Set up my project' }).click();
    await page.waitForURL(/\/onboarding\?/);
    await beat();
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  await chapter('A repository that is not enough — and a SHORTER rail', async () => {
    await resetDatabase();
    const seed = await seedRoutingJourney('routing-existing@e2e.motir.test', {
      identifier: 'RTRE',
    });
    await seedConnectedOnlyRepository(seed.workspaceId);
    declareRoutingVerdict({
      outcome: 'onboard_existing_project',
      message: 'I read your repository. Two things I still need.',
      keptSteps: ['index', 'discovery'],
      missing: [
        'The repository is still mostly the starter template.',
        'Nothing says who this is for.',
      ],
    });

    await signIn(page, 'routing-existing@e2e.motir.test', ROUTING_JOURNEY_PASSWORD);
    await openPlanWindow(page);

    // The planner's own missing-list, rendered one row per entry — and the
    // kept-step strip, which is the apology this route owes.
    await expect(handOff(page)).toHaveAttribute('data-outcome', 'onboard_existing_project');
    await expect(handOff(page)).toContainText('still mostly the starter template');
    await expect(handOff(page)).toContainText('A few questions');
    await beat();

    await page.getByRole('button', { name: 'Fill in the gaps' }).click();
    await page.waitForURL(/\/onboarding\/migrate\?/);
    await beat();

    // ⚠️ THE SET REACHES THE RUN ON *START*, not on arrival, and the rail is the
    // full one until it does. That is the product's own shape rather than a
    // detail of this spec: the kept set describes the verdict that OPENED the
    // run, so it is persisted where the run is created and never re-read from
    // whatever address the user happens to be on afterwards.
    //
    // The authoritative signal is that POST's own 201, armed before the click.
    const started = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/onboarding/migrate' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Start' }).click();
    expect((await started).ok()).toBe(true);

    // THE RAIL IS SHORTER THAN THE FULL ONE, and what is not in it is drawn as
    // SATISFIED rather than absent — collapsed into one row that NAMES it.
    const collapsed = page.getByTestId('migrate-rail-collapsed');
    await expect(collapsed).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(collapsed).toContainText('Connect');
    await expect(collapsed).toContainText('Import work items');
    await beat();

    // ⚠️ AND NO ROW NAMES A DIRECTION TIER. `discovery` is the identifier; what a
    // user reads is what they are being asked (MOTIR-4757, MOTIR-4755 rev 2).
    const rail = page.getByRole('navigation', { name: /migration/i });
    await expect(rail).toContainText('A few questions');
    await expect(rail).not.toContainText(/discovery|vision|Pre-plan/i);
    await beat();
  });
});
