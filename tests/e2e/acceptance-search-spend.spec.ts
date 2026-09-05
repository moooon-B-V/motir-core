import { expect, test } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { SHELL_PASSWORD } from './_helpers/shell-session';
import {
  addOrgMember,
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  TIERS,
} from './_helpers/billing';
import type { BillingFixtureEntry } from '@/lib/test-billing-mock';
import enMessages from '@/messages/en.json';

// SEARCH SPEND REACHES A SURFACE — THE ACCEPTANCE RECEIPT (Story MOTIR-4334 ·
// Subtask MOTIR-4560). The story's `verification_recipe`, performed in a browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Search has been charged correctly and rendered NOWHERE. The gateway prices it,
// the ledger debits it, motir-ai reports it — and it reached a motir-core type
// with no field for it and was dropped. So the clip's centre of gravity is that
// the number now EXISTS on two screens, and that each screen says which question
// it answers: the billing panel says what you are charged for, the dashboard
// says where it went.
//
// The two moments worth watching closely are chapters 3 and 5. Chapter 3 drills
// to a project and the org-level search total DOES NOT MOVE while the attributed
// figure does — the asymmetry the design asset exists to label, and the one a
// customer would otherwise read as a broken number. Chapter 5 shows an em-dash
// where a zero would be: the boundary could not report the block, and a `0` there
// tells a customer they were not charged.
//
// ── PACING IS DELIBERATE (AC 6) ─────────────────────────────────────────────
//
// Each `beat` is a thing a person can actually see happen, and the assertions are
// ordered so the clip reads as one walk rather than a checklist: the panel, then
// the dashboard, then the drill, then the member, then the two absences. Nothing
// navigates that does not show something new.
//
// ⚠️ MEASURED AT 81.7s, over the ADR's ~60s guidance, and stated rather than
// rounded down. The overage is two SIGN-INS: the walk needs an owner and a plain
// member, and re-authenticating costs ~11s of the clip twice over. The
// alternative — dropping the member chapter — would remove the only proof that
// this story did not widen the 6.10.4 gate, which is worth more than 20 seconds.
// Chapter starts: 1.7 / 17.1 / 35.9 / 54.9 / 66.2s, so no phase runs long enough
// to lose a viewer.
//
// ── ⚠️ HOW THIS LANE REACHES motir-ai, AND WHAT THAT COST (AC 7) ────────────
//
// NAMED, because AC 7 asks for it before an assertion is written: the lane does
// NOT talk to a live motir-ai. `playwright.acceptance.config.ts` sets
// `MOTIR_AI_URL` to a non-routable origin and `MOTIR_AI_BILLING_FIXTURE_PATH` to
// a JSON file on BOTH the runner and the webServer; `lib/test-billing-mock.ts`
// intercepts that origin with an undici `MockAgent` and answers `GET /v1/usage`
// from the file. The spec WRITES the file, so it controls exactly what the
// boundary reports.
//
// ⚠️ AND THAT MOCK COULD NOT REACH ANY OF THIS STORY'S STATES. Its `/v1/usage`
// body was a hardcoded object with no `search` and no `searchRuns`, and its
// fixture entry had nowhere to put them — so every assertion below except the
// UNAVAILABLE one could only ever have been written as a check that can only
// pass. Rather than move them to the vitest gate, MOTIR-4560 WIDENED the existing
// mock: `BillingFixtureEntry` gained optional `search` / `searchRuns` /
// `recentRuns`, and the handler now echoes the requested scope instead of
// hardcoding `org`. Two properties of that widening are load-bearing here:
//
//   · an ABSENT `search` stays absent on the wire (a spread, never a zero
//     default), so the rolling-deploy shape is reachable — chapter 5;
//   · `attributedByProject` lets the attributed figure narrow while the org
//     total does not, so chapter 3's asymmetry is a real difference rather than
//     one figure asserted twice.
//
// Nothing is moved to the vitest gate. MOTIR-4559 covers the same seams at the
// service layer; this proves the SHIPPED path produces what that gate predicts.

const sum = enMessages.aiUsage.summary;
const act = enMessages.aiUsage.activity;
const bill = enMessages.billing.search;

const OWNER = 'acceptance-search-spend@example.com';
const MEMBER = 'acceptance-search-member@example.com';

/** The org's motir-ai state: a paid plan, real search spend, and a remainder. */
function withSearch(over: Partial<BillingFixtureEntry> = {}): BillingFixtureEntry {
  return {
    ...paidOrgState({ tier: TIERS.pro, balance: 4420 }),
    totalSpend: 7520,
    monthSpend: 7520,
    search: { totalSpend: 1204, monthSpend: 312 },
    searchRuns: {
      runs: [
        { jobId: 'job_search_a', credits: 84, lastSearchAt: '2026-09-05T14:19:00.000Z' },
        { jobId: 'job_search_b', credits: 109, lastSearchAt: '2026-09-04T11:40:00.000Z' },
      ],
      attributedSpend: 246,
      unattributedSpend: 66,
    },
    ...over,
  };
}

test('search spend reaches both surfaces, and each says which question it answers', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4334');

  await resetDatabase();
  resetBillingFixture();
  const seed = await seedBillingOwner(page, OWNER);
  const member = await addOrgMember(seed, MEMBER);
  setOrgBillingState(seed.organizationId, withSearch());

  await chapter('The billing panel shows a fourth billed line', async () => {
    await page.goto('/settings/organization/billing');
    // Authoritative: the panel's own heading, never a spinner's absence.
    await expect(page.getByRole('heading', { name: 'Billing & plans' })).toBeVisible();
    await beat();

    // Motir Search, beside Motir / Motir AI / Motir CI.
    await expect(page.getByRole('heading', { name: 'Motir Search', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeVisible();
    await beat();

    // …with its own credits, separate from token spend. Scoped to the figure's
    // OWN block rather than matched globally: the value and its unit are one
    // element ("312" + "credits"), so an exact text match on the number alone
    // finds nothing, and a loose one would match any ancestor on the page.
    const monthFigure = page.getByText(bill.monthLabel).locator('xpath=..');
    await expect(monthFigure).toContainText('312');
    await expect(monthFigure).toContainText(bill.creditsUnit);
    // Credits, never a currency — the panel's standing rule.
    await expect(monthFigure).not.toContainText('$');
    await expect(page.getByText(bill.rate)).toBeVisible();
    await beat();
  });

  await chapter('The usage dashboard shows where those credits went', async () => {
    // Follow the line's OWN cross-link, so the clip shows the door a customer
    // would actually use rather than a typed URL.
    await page.getByRole('link', { name: bill.viewRuns }).click();
    await expect(page.getByText(sum.balance)).toBeVisible();
    await beat();

    // Search spend has its own figure, beside token spend.
    await expect(page.getByText(sum.searchThisMonth)).toBeVisible();
    await expect(page.getByText(sum.spentThisMonth)).toBeVisible();
    await beat();

    // And the runs that spent it are in the activity log.
    await expect(page.getByText(act.webSearch).first()).toBeVisible();
    await beat();

    // The remainder is SHOWN, not left as a gap between a total and its rows.
    await expect(page.getByText('66 credits not attributed to a run')).toBeVisible();
    await beat();
  });

  await chapter('Drilling to a project: one figure narrows, one does not', async () => {
    // Every figure states its own scope before the drill.
    await expect(page.getByText(sum.scopeOrg)).toBeVisible();
    await beat();

    // The attributed figure for THIS project is 84 of the org's 246; the
    // org-level total stays 312. Written into the fixture rather than asserted
    // twice, so the asymmetry is a real difference and not one number read from
    // two places.
    setOrgBillingState(
      seed.organizationId,
      withSearch({
        searchRuns: {
          runs: [{ jobId: 'job_search_a', credits: 84, lastSearchAt: '2026-09-05T14:19:00.000Z' }],
          attributedSpend: 246,
          unattributedSpend: 66,
          attributedByProject: { [seed.projectId]: 84 },
        },
      }),
    );
    await page.goto(
      `/settings/organization/usage?scope=project&projectId=${seed.projectId}&workspaceId=${seed.workspaceId}`,
    );
    await expect(page.getByText(sum.searchThisMonth)).toBeVisible();
    await beat();

    // The organization total is unchanged — and SAYS SO.
    await expect(page.getByText(sum.scopeOrg)).toBeVisible();
    await beat();

    // While the attributed figure follows the scope.
    await expect(page.getByText(sum.searchAttributed)).toBeVisible();
    await expect(page.getByText(sum.scopeFollows).first()).toBeVisible();
    await beat();
  });

  await chapter('A plain member sees their own slice', async () => {
    await signIn(page, member.email, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    await page.goto('/settings/organization/usage');
    await expect(page.getByText(sum.balance)).toBeVisible();
    await beat();

    // They see search spend, scoped as the shipped 6.10.4 gate scopes everything
    // else — this story widened nothing.
    await expect(page.getByText(sum.searchThisMonth)).toBeVisible();
    await expect(page.getByText(sum.scopeFollows).first()).toBeVisible();
    await beat();
  });

  await chapter('Unavailable is not zero', async () => {
    await signIn(page, OWNER, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });

    // A month with no searches reads as NOTHING USED…
    setOrgBillingState(
      seed.organizationId,
      withSearch({
        search: { totalSpend: 0, monthSpend: 0 },
        searchRuns: { runs: [], attributedSpend: 0, unattributedSpend: 0 },
      }),
    );
    await page.goto('/settings/organization/billing');
    await expect(page.getByText(bill.zeroTitle)).toBeVisible();
    // …and the page is NOT empty: the other three lines are right there. A zero
    // search month is not an empty billing panel.
    await expect(page.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeVisible();
    await beat();

    // …but a boundary that cannot ANSWER reads as unavailable. No `search` key
    // at all — the rolling-deploy shape, exactly as an older motir-ai would
    // serialize it.
    setOrgBillingState(seed.organizationId, {
      ...paidOrgState({ tier: TIERS.pro, balance: 4420 }),
      totalSpend: 7520,
      monthSpend: 7520,
    });
    await page.reload();
    await expect(page.getByText(bill.unavailable)).toBeVisible();
    await beat();

    // A DASH, never a zero — being told you spent nothing is the wrong answer,
    // and it is the one a customer would act on.
    await expect(page.getByLabel(bill.unavailableValue).first()).toBeVisible();
    await expect(page.getByText(bill.zeroTitle)).toBeHidden();
    await beat();
  });
});
