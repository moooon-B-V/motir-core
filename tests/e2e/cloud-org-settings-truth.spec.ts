// E2E + ACCEPTANCE VIDEO — Story MOTIR-2542 · Subtask MOTIR-2551.
//
// The story's receipt. Two things changed on `/settings/organization`, and both
// are about the page telling the truth:
//
//   1. The "Organization URL" field is gone (MOTIR-2548). It showed
//      `motir.co/<slug>` under helper text promising the value was "used in
//      links to this organization", and nothing in the product resolves that
//      address — `docs/decisions/organization-url.md` settled it.
//   2. The Acceptance video card no longer paywalls an organization the paywall
//      does not apply to (MOTIR-2545). `getAiAccess` returns an inert sentinel
//      for a `meta` org; the page used to read `hasPaidAiPlan` off it and
//      conclude "no plan", which showed moooon an Upgrade button AND stuck its
//      own toggle Off.
//
// ⚠️ WHY STEP 1 ASSERTS AN ABSENCE THE HARD WAY. "There is no Organization URL
// field" is exactly the kind of claim a passing test can fake by looking for the
// wrong thing. So it checks the LABEL, the affix, and the helper text — three
// independent traces of the row — rather than asserting that some other field is
// present, which would pass with the row still there.
//
// ⚠️ THE CLOUD GATE, AND WHY IT IS AN ASSERTION RATHER THAN AN ASSUMPTION.
// `billingService.getAiAccess` short-circuits to the same inert sentinel when
// `MOTIR_CLOUD` is unset — which is the OFF-cloud path. So on a non-cloud run the
// meta-org chapter would pass for the wrong reason: the card would render
// unpaywalled because billing does not exist at all, not because the exemption
// works. That is a test that cannot fail, which is worse than no test. This spec
// therefore READS the flag and asserts which reason it is verifying, so the
// green tick always means something.

import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'org-settings-truth-pass-123';
const OWNER_EMAIL = 'owner@moooon.test';

/** True when the harness booted the app with billing enabled. */
const CLOUD = process.env['MOTIR_CLOUD'] === 'true';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('the organization settings page offers no address it cannot resolve, and no upgrade the org does not need', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // Pin the publish target rather than letting the uploader infer it. The
  // PR-derived fallback would resolve correctly today — this branch carries
  // MOTIR-2542 — but that couples the receipt to a PR title, and this recording
  // accepts THIS story no matter which run produces it.
  acceptanceStory('MOTIR-2542');

  await chapter('An owner signs in and opens their organization settings', async () => {
    // The shipped sign-up flow, matching tests/e2e/org-admin.spec.ts exactly —
    // an email step, then a password step whose button is "Create account".
    await page.goto('/sign-up');
    await page.getByPlaceholder('Email address').fill(OWNER_EMAIL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByPlaceholder('Create a password').fill(PASSWORD);
    await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
    await page.waitForURL('**/home', { timeout: 30_000 });

    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible();
  });

  await chapter('The General card carries a name — and no address', async () => {
    // The one editable thing on the card is still there and still works.
    //
    // ⚠️ `getByRole`, NOT `getByLabel` (MOTIR-3725). During a navigation React
    // keeps the OUTGOING subtree mounted while the incoming one streams, so both
    // are in the DOM at once and an unscoped `getByLabel` matches BOTH — strict
    // mode then fails on a page that is perfectly correct. `CLAUDE.md`'s
    // loading-boundary rule states the remedy outright: *"`getByRole` is immune —
    // the accessibility tree excludes the hidden copy"*, and of the 30 assertions
    // that class once broke, exactly zero used it.
    //
    // The failure named its own fix: Playwright reported the live element as
    // `aka getByRole('textbox', { name: 'Organization name' })` and the stale
    // twin only by raw id, so the role query resolves to the one that matters.
    await expect(page.getByRole('textbox', { name: 'Organization name' })).toBeVisible();

    // The absence, checked three independent ways. Any one of these surviving
    // would mean the row is still on the page in some form.
    await expect(page.getByLabel('Organization URL')).toHaveCount(0);
    await expect(page.getByText('Organization URL', { exact: true })).toHaveCount(0);
    await expect(page.getByText('motir.co/', { exact: false })).toHaveCount(0);
    await expect(
      page.getByText('Used in links to this organization', { exact: false }),
    ).toHaveCount(0);

    // Hold on the card itself. This chapter's whole content is an ABSENCE, and
    // an absence is only legible if the viewer gets long enough to read the card
    // and find nothing — the assertions above have already proved the state, so
    // this is pacing, never synchronisation.
    await beat();
  });

  await chapter('Renaming still works — the removal took nothing else with it', async () => {
    const saved = page.waitForResponse(
      (r) => /\/api\/organizations\//.test(r.url()) && r.request().method() === 'PATCH',
    );
    await page.getByLabel('Organization name').fill('moooon B.V.');
    // Let the new value sit in the field before the click, so the recording
    // shows what is being saved rather than a blur-and-jump.
    await beat();
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await saved).status()).toBe(200);

    // The header re-renders from the server read, which is the whole reason the
    // card calls router.refresh() — assert the authoritative surface, not the
    // input we just typed into.
    await expect(page.getByRole('button', { name: 'Organization menu' })).toContainText(
      'moooon B.V.',
    );
    await beat();
  });

  await chapter('The acceptance-video card, on an organization that must pay', async () => {
    // A brand-new org is NOT meta. On a cloud harness it should still see the
    // plan gate — the fix narrowed the denial, it did not remove it.
    //
    // ⚠️ SCOPED TO `#main` (MOTIR-3725). Same cause as the `getByRole` note
    // above, and this one has no role to reach for — an `id` is a raw CSS query,
    // so it matches the outgoing subtree as readily as the live one. `CLAUDE.md`
    // gives the second remedy for exactly this case: *"reach for `getByRole`, or
    // scope to the live subtree"*. It bites hardest after the `page.reload()`
    // below, where nothing settles the transition at all.
    //
    // `#main` is the shell's live region, and Playwright named it itself:
    // `aka locator('#main #acceptance-video')` was element 1 of the strict-mode
    // violation, the stale twin being reachable only as `.nth(1)`.
    const card = page.locator('#main #acceptance-video');
    await expect(card).toBeVisible();

    if (CLOUD) {
      await expect(card.getByText('Requires a paid Motir AI plan')).toBeVisible();
      await expect(card.getByRole('link', { name: /upgrade/i })).toBeVisible();
      await expect(card.getByRole('switch')).toBeDisabled();
    } else {
      // Off-cloud there is no paywall at all, by design (ADR §6). Assert THAT,
      // so this branch is a real check rather than a skipped one.
      await expect(card.getByText('Requires a paid Motir AI plan')).toHaveCount(0);
      await expect(card.getByRole('switch')).toBeEnabled();
    }

    // The 'before' frame of the pair. The next chapter's whole meaning is that
    // this card looks DIFFERENT on a meta org, and a viewer can only see a
    // difference they were given time to register in the first place.
    await beat();
  });

  await chapter(
    'The same card, on the META organization — no upsell, and a switch that moves',
    async () => {
      // Flip the signed-in user's own organization to meta, which is the single
      // column the exemption turns on, then reload the server-rendered page.
      // resetDatabase + one sign-up leaves exactly one organization, so there is
      // no ambiguity to resolve — and finding it by NAME would couple this spec to
      // the auto-provisioned "<user>'s Workspace" default.
      const org = await db.organization.findFirstOrThrow();
      await db.organization.update({ where: { id: org.id }, data: { isMeta: true } });
      await page.reload();

      const card = page.locator('#acceptance-video');
      await expect(card).toBeVisible();

      // The defect, asserted from the user's seat: no denial copy, no checkout
      // link, and a switch that is actually operable.
      await expect(card.getByText('Requires a paid Motir AI plan')).toHaveCount(0);
      await expect(card.getByRole('link', { name: /upgrade/i })).toHaveCount(0);
      await expect(card.getByRole('switch')).toBeEnabled();

      // The 'after' frame — the same card, same position on screen, minus the
      // denial the org was never subject to.
      await beat();

      // And it is not merely enabled — it reflects and persists the stored value.
      // `checked={enabled && hasPlan}` is what used to render it Off regardless of
      // the database, so toggling it is the assertion that closes the loop.
      const saved = page.waitForResponse(
        (r) => /\/api\/organizations\//.test(r.url()) && r.request().method() === 'PATCH',
      );
      await card.getByRole('switch').click();
      expect((await saved).status()).toBe(200);

      // Hold on the moved switch. This is the frame that disproves the defect:
      // the control the meta org could not operate, operating.
      await beat();

      const after = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(after.acceptanceVideoEnabled).toBe(false);
    },
  );

  await chapter('What the run just proved', async () => {
    // A closing beat so the recording ends on a readable frame rather than
    // cutting on the last click.
    await expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible();
    await expect(page.getByLabel('Organization URL')).toHaveCount(0);
  });
});
