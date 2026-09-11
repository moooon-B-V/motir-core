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
  setOrgAcceptanceVideo,
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
// ⚠️ AND IT IS PROVEN ABLE TO GO RED — read this before trusting a green run.
// The defect did NOT reproduce here, exactly as it did not on MOTIR-5160:
// against the unfixed action this test passed 5/5 (five repeats, 2026-09-12).
// Red-ability was therefore established the way both siblings establish theirs:
// commenting out the single `router.refresh()` in `AcceptancePanel.turnOn` fails
// this test at the State-A assertion and not before, with the switch's own
// `disabled` release passing first. The run is quoted in the pull request.
// **A green run of this file means "no repaint regression", never "the race
// cannot happen".**
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

  test('the admin presses Turn on and State A arrives, with no reload', async ({ page }) => {
    const seed = await seedBillingOwner(page, 'toggle-repaint@example.com');
    setOrgBillingState(seed.organizationId, paidOrgState());
    // PAID + TOGGLE OFF, with an org admin — the one seed that renders State B
    // with a pressable switch. `canManageToggle` is `orgAccess.isOrgAdmin`
    // (`acceptanceVideoEligibilityService`), which the billing OWNER satisfies;
    // `cloud-video.spec.ts`'s "paid + toggle OFF (admin)" test is the standing
    // evidence that this seed reaches the admin arm.
    await setOrgAcceptanceVideo(seed.organizationId, false);
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

    // ⚠️ THE AUTHORITATIVE SIGNAL that the server recorded the write: the switch
    // is `disabled={pending}`, so the transition ending is the panel's own
    // statement that the action RETURNED. Everything after this line is a claim
    // about the SERVER-rendered surface the same press moved.
    //
    // It is read defensively: on a repaint the switch is unmounted with State B,
    // so `toBeEnabled` would race the very repaint under test. `not.toBeDisabled`
    // on a detached element is satisfied for either reason, which is exactly
    // right here — both outcomes mean the action came back.
    await expect(turnOn).not.toBeDisabled();

    // The page-state contract's case 2 (`motir-core/CLAUDE.md`). The panel is a
    // Server-Component surface seeded from `eligibility`; the press changed it,
    // so the press owes it a repaint. This is the assertion the defect fails.
    await expect(detail(page).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    // And the terminal direction: State B is GONE, so a repaint that lands the
    // wrong tree fails as loudly as one that never lands.
    await expect(offHeading).toHaveCount(0);
  });
});
