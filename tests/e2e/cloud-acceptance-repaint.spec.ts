import { test, expect, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import {
  seedBillingOwner,
  setOrgBillingState,
  resetBillingFixture,
  paidOrgState,
} from './_helpers/billing';
import {
  seedInReviewStory,
  seedPendingEvidence,
  setProjectAcceptanceVideo,
} from './_helpers/acceptance-seed';
import { acceptanceSection, decideAcceptanceInOverlay } from './_helpers/acceptance-decide';

// THE GUARD FOR *DECIDING THE ACCEPTANCE GATE REPAINTS THE PAGE* (Bug
// MOTIR-5160), the sibling of `approval-gate-repaint.spec.ts` (Bug MOTIR-5118)
// one surface over.
//
// ⚠️ WHY THIS FILE EXISTS AT ALL, AND IT IS NOT THE FIX. Before it, NO test
// anywhere asserted that a story's status surface repaints in place after an
// acceptance decision, so the defect below had no detector and was
// indistinguishable from no defect. `cloud-video.spec.ts` drives the decision
// three times and cannot see it: its dogfood chapter opens with `page.reload()`
// before reading Done (a legitimate committed-state read — it also asserts
// `persisted.status` straight from the database), its request-changes test
// reloads and reads the database too, and its board test approves and then
// `page.goto('/boards')`. A reload and a navigation are both authoritative
// committed-state reads, and committed state is exactly what this guard is NOT
// about. The hole was the absence of the question, not a wrong answer to it.
//
// ⚠️ AND IT IS PROVEN ABLE TO GO RED, which a guard written against an
// intermittent defect otherwise cannot claim — read this before trusting a green
// run of it. The defect did NOT reproduce here: against the UNFIXED code these
// two tests passed 12/12 (six repeats, 38.7 s total, 2026-09-11), where the
// sibling's reproduced on one acceptance-lane run of two. So red-ability was
// established the way `approval-gate-repaint.spec.ts` establishes its own:
// commenting out the single `router.refresh()` in `AcceptancePanel.decide` fails
// BOTH tests, each at its status-rail assertion and not before —
// `getByRole('main')…getByText('Done')` at 23.4 s and `…getByText('In Progress')`
// at 22.7 s, with the panel's own pill assertion passing in each. With the
// server half restored they pass 6/6. **A green run of this file means "no
// repaint regression", never "the race cannot happen".**
//
// ⚠️ THE DEFECT IS INTERMITTENT, so read a green run of this file carefully.
// `decideAcceptanceAction` called `acceptanceEvidenceService.decide` and
// returned without `revalidatePath`, and its header said so deliberately — the
// caller does the surgical `router.refresh()`. That is word for word the
// reasoning `approvalGateActions.ts` carried before MOTIR-5118, and the trace
// that falsified it there applies unchanged here: the refresh FIRES and
// SUCCEEDS (the decide POST returns 200 in 95 ms carrying no
// `x-action-revalidated`; the refresh GETs `/items/<key>?_rsc=…` and returns 200
// in 113 ms) — and the server-rendered status rail still read the pre-decision
// value twenty seconds later. The fresh tree arrives on a SECOND, separate
// apply, and that apply is the one that intermittently goes missing. Nothing
// about that mechanism was specific to the design gate: it is a property of a
// Server Action whose own response carries no revalidation.
//
// ⚠️ HOW THE PAIR DIFFERS FROM THE SIBLING'S, SAID PLAINLY RATHER THAN
// INHERITED. `approval-gate-repaint.spec.ts` buys an ASYMMETRY: approving is
// terminal for `design_result` so the rail must MOVE, requesting changes settles
// nothing so the rail must STAY, and a blanket refresh passes the first while a
// page that never repaints passes the second. **That asymmetry is not available
// here.** `AcceptanceDecisionResult` carries `storyStatus: 'done' |
// 'in_progress'`, so BOTH decisions move the rail and both tests below go red
// without a repaint. What this pair buys instead is the two TERMINAL DIRECTIONS:
// each test asserts the value the server actually holds AND the absence of the
// pre-decision value, so a repaint that lands the wrong tree fails as loudly as
// one that never lands. Claiming the sibling's asymmetry here would be claiming
// a property these tests do not have.
//
// ⚠️ WHY IT IS A BROWSER TEST. Nothing here is visible to a database read: the
// decide transaction writes `work_item.status` correctly on both branches, and
// `cloud-video.spec.ts` already asserts exactly that from the database. Only an
// assertion taken in a real browser, on a page nobody reloaded, can see it.
//
// ⚠️ NO `page.reload()` ANYWHERE IN THIS FILE, ON PURPOSE — the same rule the
// sibling guard carries. Adding one to steady a flake here would delete the
// detector this card exists to create.
//
// ⚠️ WHY THE CLOUD LANE. The acceptance panel only reaches State A (the player
// plus the Approve / Request changes gate) when the org is on a paid plan with
// the acceptance-video toggle on. Off-cloud `billingService.getAiAccess`
// short-circuits to the same inert value it returns for an exempt org, so this
// walk would go GREEN off-cloud because the gate does not exist rather than
// because it repaints (MOTIR-2601, already paid for once). `cloud-*.spec.ts` is
// this lane's membership rule (`playwright.cloud.config.ts` `testMatch`).
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is an element's own
// visible state. The panel's own pill is reconciled from the response the decide
// action RETURNED, so it is the authoritative signal that the server recorded
// the decision — and it is what each assertion about the SERVER-rendered rail
// waits behind. There is no `waitForTimeout`.

/** The item page's live route subtree.
 *
 *  ⚠️ SCOPED, NOT PAGE-ROOTED, AND FOR TWO INDEPENDENT REASONS. The item page
 *  streams its late stack behind an in-page `<Suspense>`, so React leaves a
 *  resolved copy in `<div hidden id="S:0">` at the end of `<body>` — a
 *  page-rooted read races it (MOTIR-4822; `CLAUDE.md` § *a boundary makes every
 *  unscoped locator a race*). And `tests/e2e-page-rooted-locators.test.ts`
 *  (MOTIR-5037) rules on the whole of `tests/e2e/**` with an allow-list tight in
 *  BOTH directions, so a new page-rooted site here would be unwritable by
 *  construction. `getByRole('main')` is resolved through the accessibility tree,
 *  which is what buys it the immunity a page-rooted locator lacks — the same
 *  scope `cloud-video.spec.ts` adopted for this page in MOTIR-5116. */
const detail = (page: Page) => page.getByRole('main');

/** The detail rail's Status field card — the value beside the "Edit Status"
 *  chevron (`FieldCard`'s `aria-label`), scoped so an activity-log mention of
 *  the same label cannot match. The `status-derivation.spec.ts` /
 *  `approval-gate-repaint.spec.ts` locator, taken through `main`. */
function statusCard(page: Page) {
  return detail(page)
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

/** Seed a paid, toggle-on org with an in-review story carrying pending
 *  evidence, and leave the reviewer on its item page with the gate on screen. */
async function arriveAtTheGate(page: Page, email: string, title: string) {
  const seed = await seedBillingOwner(page, email);
  setOrgBillingState(seed.organizationId, paidOrgState());
  await setProjectAcceptanceVideo(seed.projectId, true);
  const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
  const story = await seedInReviewStory(ctx, seed.projectId, title);
  await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

  await page.goto(`/items/${story.identifier}`);
  // First hit of `/items/[key]` in this lane runs against a production build,
  // but the route is still cold on the first spec — give the opening assertion
  // headroom, as `cloud-video.spec.ts` does for the same reason.
  await expect(page.getByRole('heading', { name: 'Acceptance', exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // The BEFORE half of every assertion below: the story is In Review and the
  // question is open. Asserted rather than assumed, so a seed that drifted fails
  // here instead of making the after-state look like a no-op.
  await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible();
  // The question is OPEN, which on this page is the call-to-action band's one door rather
  // than a verb — the item page hands the decision over (MOTIR-5229 · MOTIR-5790).
  await expect(
    acceptanceSection(page).getByRole('link', { name: 'Review & approve' }),
  ).toBeVisible();

  return story;
}

test.describe.configure({ timeout: 90_000 });

test.describe('deciding the acceptance gate repaints the item page in place', () => {
  test.beforeEach(async () => {
    await resetDatabase();
    resetBillingFixture();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('approving moves the status rail to Done, with no reload', async ({ page }) => {
    await arriveAtTheGate(page, 'repaint-approve@example.com', 'Repaint on approve');

    // ⚠️ THE DECISION IS MADE IN THE OVERLAY, not on this page (MOTIR-5229 · MOTIR-5790).
    // The page shows the question and ONE door; the helper presses through it and waits on
    // the decided record the frame draws from the action's own response. Everything after
    // this line is a claim about a SERVER-rendered surface the same decision moved.
    await decideAcceptanceInOverlay(page, 'approve');

    // The panel keeps the RECORD — the shared frame, since MOTIR-5792 — so the decision
    // is still readable on the page it was made from.
    await expect(detail(page).getByText('Approved', { exact: true })).toBeVisible();

    // The page-state contract's case 2 (`motir-core/CLAUDE.md`). The rail is a
    // Server-Component surface elsewhere on the page; the decision changed it,
    // so the decision owes it a repaint. This is the assertion the defect fails.
    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
    await expect(statusCard(page).getByText('In Review', { exact: true })).toHaveCount(0);
  });

  test('requesting changes records the decision and deliberately moves NOTHING', async ({
    page,
  }) => {
    await arriveAtTheGate(page, 'repaint-changes@example.com', 'Repaint on request changes');

    // Sent back through the same one door (MOTIR-5229 · MOTIR-5790). The helper waits on
    // the overlay's own decided record, which is this branch's authoritative signal — the
    // toast this test used to read belonged to the panel's retired verbs.
    await decideAcceptanceInOverlay(page, 'request_changes');

    // ⚠️ THE RAIL DOES NOT MOVE, AND THAT IS THE CONTRACT (Story MOTIR-4949 · Subtask
    // MOTIR-4950). The retired bespoke path moved the story `in_review → in_progress`;
    // joining the ONE approve language retired that write with it, because every kind's
    // *Request changes* is a RECORD rather than a second status writer
    // (`acceptanceResultHandler.requestChanges` → `statusDeferredReason:
    // 'request_changes_moves_nothing'`, `approval-gates.md` §3).
    //
    // So this half of the guard inverted: it used to prove a repaint ARRIVED, and now it
    // proves one does NOT — which is worth asserting for the same reason, because a
    // status write sneaking back in is exactly the defect the retirement was for.
    await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible();
    await expect(statusCard(page).getByText('In Progress', { exact: true })).toHaveCount(0);
    // …and the DECISION is on the page, in the shared frame's record (MOTIR-5792), so
    // *moved nothing* is distinguishable from *did nothing*.
    await expect(
      acceptanceSection(page).getByText('Changes requested', { exact: true }),
    ).toBeVisible();
  });
});
