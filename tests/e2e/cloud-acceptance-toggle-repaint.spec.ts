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

// THE GUARD FOR *TURNING THE ACCEPTANCE VIDEO ON REPAINTS THE PANEL IN PLACE*
// (Bug MOTIR-5196) — the third and last surface in the family that begins with
// `approval-gate-repaint.spec.ts` (MOTIR-5118) and continues in
// `cloud-acceptance-repaint.spec.ts` (MOTIR-5160).
//
// ⚠️ WHY IT EXISTS, AND IT IS NOT THE FIX. Before it, NOTHING anywhere drove the
// toggle-on press and asserted the panel in place. `cloud-video.spec.ts`'s
// *"paid + toggle OFF (admin)"* test renders State B and asserts the switch is
// THERE — a reasonable thing for a spec about the off state to do, and exactly
// what made the question unaskable. `cloud-acceptance-repaint.spec.ts`
// (MOTIR-5160) covers the DECIDE path only, on a paid + toggle-ON seed. So this
// surface had no detector, and a defect with no detector is indistinguishable
// from no defect.
//
// ⚠️ THE DEFECT REPRODUCED HERE — the first time in this family — AND THE FIX
// DOES NOT FULLY CLOSE IT. Read this before trusting either colour of run.
// Measured 2026-09-12, `playwright.cloud.config.ts` on one developer box, one
// worker, against a production build:
//
//   | build                                   | red   |
//   |-----------------------------------------|-------|
//   | UNFIXED action (no `revalidatePath`)    |  2/8  |
//   | FIXED action (this branch)              |  1/8, then 1/16 |
//   | sibling `cloud-acceptance-repaint` (CONTROL, shipped) | 0/16, twice |
//
// So no deliberate break was needed to establish red-ability: the unfixed build
// supplies it. What the numbers also say, and it is the finding rather than a
// caveat, is that **`revalidatePath` reduces this failure and does not
// eliminate it.**
//
// ⚠️ AND THE RESIDUAL IS NOT THE MOTIR-5118 RACE — the trace excludes it. On a
// failing run against the FIXED build the action `POST /items/<key>` returned
// **200 in 193 ms** and the refresh `GET /items/<key>?_rsc=…` returned **200**,
// and the panel still read State B twenty seconds later with the switch still
// `disabled` (the transition never settled). Both halves fired and succeeded, so
// nothing was raced away.
//
// ⚠️ THE CONTROL IS WHAT MAKES THAT A FINDING RATHER THAN A FLAKY BOX. The
// sibling guard passed 16/16 twice in this same lane on this same machine, once
// at load ~8 and once at load ~11–14 — so "the sandbox is contended" does not
// explain it. The structural difference between the two is the one to chase:
// the sibling asserts the STATUS RAIL, which the item page renders eagerly,
// while this file asserts the ACCEPTANCE PANEL, which sits inside the page's
// late `<Suspense>` stack (MOTIR-3436). Filed as its own bug; this file is its
// reproduction.
//
// **So a green run of this file means "no repaint regression", never "the race
// cannot happen" — and a RED one is not automatically your diff.**
//
// ⚠️ AND AS OF 2026-09-12 THIS SPEC IS `test.fixme` FOR A THIRD, UNRELATED
// REASON — MOTIR-4925 moved the switch's READ to the project tier and left the
// WRITE on the organisation tier, so the press is a no-op and the panel cannot
// leave State B (4/4 red, deterministic). The full disposition is on the test
// itself; the measurements above were all taken BEFORE that merge, against a
// coherent single-tier path, and they stand.
//
// ⚠️ THE MECHANISM, for the reader who meets a green run and wonders what is
// being guarded. `turnOnAcceptanceVideoAction` called one service and returned
// without `revalidatePath`, and `turnOn()` followed it with a bare
// `router.refresh()`. That is the same shape `approvalGateActions.ts` carried
// before MOTIR-5118 and `decideAcceptanceAction` carried before MOTIR-5160, and
// the trace that falsified it on the design gate applies unchanged: the refresh
// FIRES and SUCCEEDS, and the server-rendered surface still reads the
// pre-mutation value, because the fresh tree arrives on a SECOND, separate
// apply that intermittently goes missing. Nothing about it was specific to a
// gate decision — it is a property of a Server Action whose own response
// carries no revalidation.
//
// ⚠️ WHY THE SURFACE IS CASE 2 AND NOT CASE 1. The panel branches on
// `eligibility`, an `AcceptanceVideoEligibilityDTO` passed down as a SERVER prop
// from `LateSections`. Turning the toggle on is what swaps State B (the
// "Acceptance video is off" panel) for State A (the player and the gate), and
// that swap cannot happen in the browser — it needs a server render to arrive.
// The pressed control is the switch; the surface that moves is the whole panel
// around it (`motir-core/CLAUDE.md` § *Page state after a mutation*).
//
// ⚠️ WHY STATE A ARRIVES WITH ITS PLAYER RATHER THAN ITS PENDING PLACEHOLDER —
// and it is a fact about the read, not a lucky seed. `lateReads.ts` fetches
// `acceptanceEvidence` on `showAcceptance` (a story at in_review / done) ALONE,
// never on eligibility, so the seeded evidence is already on the panel's
// `initialEvidence` prop while the toggle is off. The panel's `evidence` state
// is `useState`-seeded and a refresh cannot re-seed it (case 3) — which is
// precisely why this test does not depend on that: the value was there at mount.
//
// ⚠️ NO `page.reload()` ANYWHERE IN THIS FILE, ON PURPOSE — the same rule both
// sibling guards carry. Adding one to steady a flake here would delete the
// detector this card exists to create.
//
// ⚠️ WHY THE CLOUD LANE. State B is reachable only when the org is on a paid
// plan with the toggle off: off-cloud `billingService.getAiAccess`
// short-circuits to `applicable: false`, which the panel renders as the UNGATED
// State A directly, so this walk would go green off-cloud because the toggle
// state does not exist rather than because it repaints (MOTIR-2601, paid for
// once already). `cloud-*.spec.ts` is this lane's membership rule
// (`playwright.cloud.config.ts` `testMatch`).
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is an element's own
// visible state. There is no `waitForTimeout`.

/** The item page's live route subtree.
 *
 *  ⚠️ SCOPED, NOT PAGE-ROOTED, AND FOR TWO INDEPENDENT REASONS — the same two
 *  `cloud-acceptance-repaint.spec.ts` states. The item page streams its late
 *  stack behind an in-page `<Suspense>`, so React leaves a resolved copy in
 *  `<div hidden id="S:0">` at the end of `<body>` and a page-rooted read races
 *  it (MOTIR-4822). And `tests/e2e-page-rooted-locators.test.ts` (MOTIR-5037)
 *  rules on the whole of `tests/e2e/**` with an allow-list tight in BOTH
 *  directions, so a new page-rooted site here would be unwritable by
 *  construction. `getByRole('main')` resolves through the accessibility tree,
 *  which is what buys it the immunity a page-rooted locator lacks. */
const detail = (page: Page) => page.getByRole('main');

test.describe.configure({ timeout: 90_000 });

test.describe('turning the acceptance video on repaints the panel in place', () => {
  test.beforeEach(async () => {
    await resetDatabase();
    resetBillingFixture();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FIXME(MOTIR-5172): this cannot pass on `main` today, for a reason that has
  // nothing to do with the repaint it was written to guard.
  //
  // MOTIR-4925 moved the acceptance-video switch from the ORGANISATION to the
  // PROJECT tier while this card was in flight, and it moved the READ without
  // the WRITE. `acceptanceVideoEligibilityService.resolve` now reads
  // `project.acceptanceVideoEnabled`; `turnOnAcceptanceVideoAction` still calls
  // `organizationsService.setAcceptanceVideoEnabled`, which writes
  // `organization.acceptanceVideoEnabled`. Two different columns — so pressing
  // Turn on flips a flag nothing reads, and the panel can never leave State B.
  // Measured against the merged base: **4/4 red**, deterministic, where the same
  // spec was 1/16 red before the merge.
  //
  // MOTIR-5172 criterion 4 is the fix ("`turnOnAcceptanceVideoAction` is
  // project-scoped"). It is not folded in here: it is a nine-criterion card with
  // its own blocker, and absorbing it would be the exact drive-by all three
  // cards in this family were filed to avoid.
  //
  // Marked `fixme` rather than relaxed, so CI stays green without dropping the
  // requirement (`motir-core/CLAUDE.md`: a pre-existing bug in shipped code
  // surfaced by a test is LOGGED, not absorbed into the test PR) — the same
  // disposition `roadmap-refresh-scope.spec.ts` carries for MOTIR-1549. The body
  // and every assertion below are UNCHANGED and were verified end-to-end before
  // the tier moved: 2/8 red against the unfixed action, 1/8 then 1/16 against the
  // fixed one, with the shipped sibling guard 0/16 twice as a control.
  //
  // ⚠️ REMOVING THE `fixme` IS A DELIVERABLE OF TWO CARDS, NOT A TIDY-UP.
  // MOTIR-5172 makes it runnable; MOTIR-5255 is the intermittent repaint failure
  // this spec measured before the tier moved and is the reason the assertion may
  // NOT be relaxed — it is that bug's only detector.
  // ─────────────────────────────────────────────────────────────────────────
  test.fixme('the admin presses Turn on and State A arrives, with no reload', async ({ page }) => {
    const seed = await seedBillingOwner(page, 'toggle-repaint@example.com');
    setOrgBillingState(seed.organizationId, paidOrgState());
    // PAID + TOGGLE OFF, with an org admin — the one seed that renders State B
    // with a pressable switch. `canManageToggle` is `orgAccess.isOrgAdmin`
    // (`acceptanceVideoEligibilityService`), which the billing OWNER satisfies;
    // `cloud-video.spec.ts`'s "paid + toggle OFF (admin)" test is the standing
    // evidence that this seed reaches the admin arm.
    await setProjectAcceptanceVideo(seed.projectId, false);
    const ctx = { userId: seed.ownerId, workspaceId: seed.workspaceId };
    const story = await seedInReviewStory(ctx, seed.projectId, 'Toggle on repaint');
    // Seeded so the panel has somewhere to LAND: with evidence present, State A
    // is the player plus the gate rather than the thin pending placeholder, and
    // the assertion below is about a surface only a server render can produce.
    await seedPendingEvidence(seed.workspaceId, seed.ownerId, story.id);

    await page.goto(`/items/${story.identifier}`);
    // First hit of `/items/[key]` in this lane runs against a production build,
    // but the route is still cold on the first spec — give the opening assertion
    // headroom, as both sibling specs do for the same reason.
    await expect(page.getByRole('heading', { name: 'Acceptance', exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // The BEFORE half, asserted rather than assumed: State B is on screen and
    // the gate is NOT, so a seed that drifted fails here instead of making the
    // after-state look like a no-op.
    const offHeading = page.getByRole('heading', { name: 'Acceptance video is off' });
    await expect(offHeading).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    const turnOn = detail(page).getByRole('switch');
    await expect(turnOn).toBeVisible();
    await turnOn.click();

    // ⚠️ NO INTERMEDIATE WAIT, AND THE REASON IS A PROPERTY OF THIS SURFACE
    // RATHER THAN A RELAXATION OF THE E2E RULE. `decide()` one function over has
    // a genuine authoritative signal — it calls `setEvidence(res.evidence)`, so
    // the panel's own pill states that the server RETURNED, and the sibling
    // guard waits behind it. `turnOn()` sets no local state at all: it awaits
    // the action and calls `router.refresh()`. So the ONLY thing this press ever
    // makes observable is the server tree arriving, and every candidate signal
    // in between is either racing the repaint or destroyed by it. Measured,
    // against the unfixed action: the switch's own `disabled={pending}` release
    // reported `element(s) not found` on the three runs where the repaint LANDED
    // (the switch unmounts with State B) and `disabled` on the two where it did
    // not — an assertion that fails on success and on failure alike, for
    // different reasons. The assertion below IS the wait, which is the shape
    // `docs/e2e/mutation-assert-sweep.md` describes as the common and correct
    // one.
    //
    // The page-state contract's case 2 (`motir-core/CLAUDE.md`). The panel is a
    // Server-Component surface seeded from `eligibility`; the press changed it,
    // so the press owes it a repaint. This is the assertion the defect fails.
    await expect(detail(page).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    // And the terminal direction: State B is GONE, so a repaint that lands the
    // wrong tree fails as loudly as one that never lands.
    await expect(offHeading).toHaveCount(0);
  });
});
