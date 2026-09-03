import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';

// STORY E2E — MOTIR-3943 / MOTIR-4311: every planning entrance still reaches a
// plan, and the seam recorded ONE job kind for all of them.
//
// The whole point of the wire change is that NOTHING A PERSON DOES CHANGES. So
// the acceptance is a browser walk that would look identical before and after —
// plus the one assertion that could not have passed before: the kind on the wire.
//
// ⚠️ THIS LANE, AND ONLY THIS LANE. `playwright.cloud.config.ts` is the ONLY
// config that sets `E2E_TEST_AI_JOBS: '1'`, which is what makes
// `instrumentation.ts` install the motir-ai jobs boundary mock IN THE SERVER
// PROCESS — under the routes, so the real route, the real service, the real
// repository and real Postgres all run, and only the far side is stubbed. A copy
// of this spec in the default lane would not go red; it would pass vacuously or
// 502, which is why the lane is named here rather than assumed.
//
// ⚠️ AND THAT IS WHY THIS SPEC DOES NOT `page.route` THE AI ROUTES. Its sibling
// `cloud-plan-change-conversation.spec.ts` stubs motir-core's own `/api/ai/*` in
// the BROWSER, which is right for what that spec asserts and fatal for this one:
// a browser-side stub means the service never runs, `submitJob` never fires, and
// the seam records nothing. `cloud-plan-revision.spec.ts` is the model — the job
// dispatches for real and the boundary is mocked beneath it.
//
// ⚠️ WHAT THIS SPEC DOES NOT ASSERT: which GROUNDING motir-ai chose for a given
// context. The far side is stubbed and does not run, so an assertion about
// `readerForPlan` here would be testing the harness. That belongs to the motir-ai
// story gate (`tests/storyGate.oneWireOneKind.test.ts` over there), which drives
// the real readers.
//
// NO ACCEPTANCE VIDEO, deliberately. This story's deliverable is a wire contract;
// its user-observable change is a single pill label. `kind-story.md` scopes a
// non-UI story to accept on its tests alone, and a clip of a pill is a receipt
// for nothing.

test.describe.configure({ timeout: 240_000 });

/** The five planning kinds this story retired — none may appear on the wire. */
const RETIRED = ['generate_tree', 'expand_item', 'augment', 'replan', 'revise_plan'] as const;

interface SubmittedEntry {
  kind: string;
}

/**
 * ⚠️ THE TWO ENTRANCES DIFFER IN HOW MANY SUBMITS A TURN MAKES, AND THIS SPEC'S
 * FIRST TWO RUNS GOT IT WRONG IN OPPOSITE DIRECTIONS. Recorded because it is the
 * shape of the product rather than a quirk of the harness — and because guessing
 * it twice is what a record like this is for.
 *
 * `docs/contract.md` §2.3: `ask_project` is ALSO the conversation's door
 * (`conversation-turn-intent.md` §2, MOTIR-1816). Motir's ONE AI conversation
 * carries two intents and the user picks no mode, so a turn typed there is
 * submitted as `ask_project` and the handler's first turn classifies — a question
 * it answers; a plan-change request it DECLINES, returning
 * `ask.intent: 'plan_change'`, and motir-core then dispatches the planning submit
 * for the same turn.
 *
 * MEASURED, across two runs of this spec:
 *
 *   · the PROJECT-WIDE conversation → `ask_project`, then `plan` (TWO submits)
 *   · the ANCHORED planning workspace, entered from an item's own door → `plan`
 *     directly (ONE submit)
 *
 * Run 1 asserted the entrance sent `plan` and read the door's kind instead
 * (`Received: "ask_project"`). Run 2 then required the door on BOTH, and the
 * anchored entrance answered `plan` (`Received: "plan"`). So this spec asserts
 * NEITHER shape: it asserts that every submit which is not the conversation door
 * is `plan` — which is the story's actual claim, and is true of both entrances
 * however many submits each makes.
 *
 * `declareAskOutcomes` is how the spec makes the door redirect: the seam consumes
 * the `ask` queue in order, so a `plan_change` entry per turn is what routes it
 * into the planning submit this story is about.
 */
function fixturePath(): string {
  const path = process.env['MOTIR_AI_JOBS_FIXTURE_PATH'];
  expect(path, 'MOTIR_AI_JOBS_FIXTURE_PATH is unset — wrong lane').toBeTruthy();
  return path!;
}

/**
 * Seed the ask queue and RESET the recorded submits.
 *
 * ⚠️ THE RESET IS LOAD-BEARING. The fixture file is SHARED and PERSISTENT across
 * specs and across runs — the first run of this spec read an `augment` entry left
 * by an older run and would have failed its own "no retired kind" sweep on
 * somebody else's history. A claim about THIS run has to be measured over this
 * run's entries, which is the same re-measure-the-predicate discipline the story's
 * greps needed.
 */
function resetSeam(outcomes: { intent: 'ask' | 'plan_change' }[]): void {
  writeFileSync(fixturePath(), JSON.stringify({ ask: outcomes, submitted: [] }, null, 2));
}

/** Every submit the SERVER-side seam recorded, in order. */
function submitted(): SubmittedEntry[] {
  try {
    const raw = JSON.parse(readFileSync(fixturePath(), 'utf8')) as { submitted?: SubmittedEntry[] };
    return raw.submitted ?? [];
  } catch {
    return [];
  }
}

/**
 * Drive one turn and answer the kinds it put on the wire, in order.
 *
 * Waits for the PLANNING submit specifically rather than for "one more entry":
 * the door lands first, so a wait on the count alone reads `ask_project` and
 * reports the wrong verdict.
 */
async function kindsFromTurn(before: number): Promise<string[]> {
  await expect
    .poll(
      () =>
        submitted()
          .slice(before)
          .map((e) => e.kind),
      {
        message: 'the seam never recorded a planning submit after the ask door',
        timeout: 60_000,
      },
    )
    .toContain('plan');
  return submitted()
    .slice(before)
    .map((e) => e.kind);
}

const planEntrance = (page: Page) => page.getByTestId('work-item-plan-entrance');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });

/**
 * The conversation composer, SCOPED TO THE RAIL rather than matched by name.
 *
 * ⚠️ ITS ACCESSIBLE NAME IS THE PLACEHOLDER, AND THE PLACEHOLDER IS
 * MODE-DEPENDENT. `PlanChangeComposer` sets `aria-label={resolvedPlaceholder}`,
 * and `planningWorkspace.conversation` carries FOUR of them —
 * `composerPlaceholder`, `…Replan`, `…Targets`, `…Answer` — chosen by how the
 * workspace was entered. A name-matched locator therefore passes on the entrance
 * it was written against and fails on the others, which is exactly what the first
 * run of this spec did. The rail has ONE textbox; scoping to it is stable across
 * all four modes.
 */
const composer = (page: Page) => rail(page).getByRole('textbox').first();
const send = (page: Page) => rail(page).getByRole('button', { name: 'Send' });

test('every planning entrance reaches a plan, and the seam recorded ONE kind', async ({ page }) => {
  await resetDatabase();
  // Two turns, each redirected out of the ask door into a planning submit.
  resetSeam([{ intent: 'plan_change' }, { intent: 'plan_change' }]);
  const seed = await seedAiAugmentReplan(`one-kind-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await signIn(page, seed.email, seed.password);

  /** Every kind this test put on the wire, across both turns. */
  const kinds: string[] = [];
  const planningKinds: string[] = [];

  await test.step('the item surface offers a planning door, and it reaches the workspace', async () => {
    await page.goto(`/items/${seed.authEpicKey}`);
    // The door is drawn by `planEntranceVisibility` — a container WITH children
    // wears the Re-plan face, without them the Plan face. Either is an entrance;
    // what matters is that one is drawn and it leads somewhere.
    const door = planEntrance(page).first();
    await expect(door, 'no planning door on the item surface').toBeVisible();
    const mode = await door.getAttribute('data-mode');
    expect(['plan', 'replan']).toContain(mode);

    const before = submitted().length;
    await door.click();
    // The workspace is the destination; the submit happens from its composer.
    await expect(rail(page)).toBeVisible({ timeout: 60_000 });
    // The door itself only navigates — nothing is submitted by arriving, which
    // is worth asserting because a door that submitted on click would make every
    // count below off by one.
    expect(submitted().length, 'arriving at the workspace submitted a job').toBe(before);
  });

  await test.step('an ANCHORED turn submits, and the seam records `plan`', async () => {
    const before = submitted().length;
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await composer(page).fill('Break this epic into stories.');
    await send(page).click();
    const turn = await kindsFromTurn(before);
    kinds.push(...turn);
    planningKinds.push(...turn.filter((k) => k !== 'ask_project'));
    // The DOOR is asserted too, because it is the shipped shape rather than an
    // incidental extra submit: the turn is classified before it is planned.
  });

  await test.step('a PROJECT-WIDE turn submits, and the seam records `plan`', async () => {
    await page.goto('/plans');
    await page
      .getByRole('link', { name: /Plan with AI/i })
      .first()
      .click();
    await expect(rail(page)).toBeVisible({ timeout: 60_000 });

    const before = submitted().length;
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await composer(page).fill('Add an analytics epic to this project.');
    await send(page).click();
    const turn = await kindsFromTurn(before);
    kinds.push(...turn);
    planningKinds.push(...turn.filter((k) => k !== 'ask_project'));
  });

  await test.step('EVERY recorded submit is `plan`, and NO retired kind appears', async () => {
    // Every PLANNING submit this test made is `plan` — one value, whichever
    // entrance produced it. The ask door's own kind is excluded deliberately and
    // asserted separately above: it is not a planning submit.
    expect(planningKinds.length, 'no entrance produced a planning submit').toBeGreaterThan(1);
    for (const kind of planningKinds) expect(kind).toBe('plan');

    // …and the POSITIVE form of *they are gone*, over THIS TEST'S submits.
    //
    // ⚠️ SCOPED, NOT WHOLESALE. The fixture is shared and persistent, so reading
    // the whole file measures other specs' history and older runs' — the first
    // draft of this assertion did exactly that and would have failed on an
    // `augment` entry a previous run left behind. `resetSeam` cleared it at the
    // start of this test, and `kinds` holds only what this test produced.
    for (const retired of RETIRED) {
      expect(kinds, `this run recorded a retired kind: ${retired}`).not.toContain(retired);
    }
  });

  // ⚠️ THE USAGE-RUN-LOG STEP IS NOT HERE, AND THAT IS A FINDING RATHER THAN AN
  // OMISSION (recorded on MOTIR-4311).
  //
  // The card asks for a browser-level check that the run log's newest row shows
  // the planning pill. It cannot pass in this lane, and not for a timing reason:
  // `/settings/organization/usage` reads motir-ai's `GET /v1/usage`, which in
  // every E2E lane is served by `lib/test-billing-mock.ts` — and that seam replies
  // with `recentRuns: { runs: [], page: 1, pageSize: 20, total: 0 }`, HARDCODED.
  // Its fixture shape (`BillingFixtureEntry`) carries `balance`, `tier` and
  // `subscription`, and no run rows at all, so there is no way to seed one.
  //
  // Making it pass means extending that seam's fixture AND its reply — test
  // infrastructure well beyond this card's "adding a `data-testid` is in scope;
  // anything larger is a finding" boundary.
  //
  // The pill is NOT unasserted. `tests/components/org-usage-run-log.test.tsx`
  // (MOTIR-4305) drives the SHIPPED `OrgUsageClient` against the real `en` and
  // `zh` catalogs and asserts the exact label and the exact tint class, plus the
  // unknown-kind fallback. What is missing is only the browser tier, and what
  // that tier would add over the component tier here is small.
});

test('an EMPTY turn refuses rather than silently submitting', async ({ page }) => {
  // The empty case the discipline requires: a composer with nothing in it must
  // not reach the wire. Asserted as a COUNT on the seam rather than on a
  // disabled attribute, because "the button looked disabled" and "no job was
  // submitted" are different facts and only the second one matters.
  await resetDatabase();
  resetSeam([]);
  const seed = await seedAiAugmentReplan(`one-kind-empty-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await signIn(page, seed.email, seed.password);

  await page.goto('/plans');
  await page
    .getByRole('link', { name: /Plan with AI/i })
    .first()
    .click();
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });

  const before = submitted().length;
  // The refusal, in the shape the product actually implements it: an empty
  // composer disables the send. Asserted on the CONTROL and then on the SEAM, so
  // a future change that re-enables the button but rejects server-side still
  // passes the assertion that matters.
  await expect(send(page)).toBeDisabled();
  // Give the app a real window in which it COULD have submitted — an
  // authoritative read of the seam, not a race with it.
  await expect
    .poll(() => submitted().length, { timeout: 3_000, intervals: [500, 500, 500, 500, 500, 500] })
    .toBe(before);
});
