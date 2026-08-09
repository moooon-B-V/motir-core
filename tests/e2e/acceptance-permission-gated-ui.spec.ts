import { expect, type Page } from '@playwright/test';
import { test } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPermissionGatedUi,
  type PermissionGatedSeed,
} from './_helpers/permission-gated-ui-seed';

// Story MOTIR-2258 — the permission-gated shell (Subtask MOTIR-2479).
//
// The ACCEPTANCE RECEIPT. This story ships no new page and no new control; what
// it ships is an ABSENCE, and an absence is the one thing a screenshot cannot
// show and a changelog line cannot convey. Watching the same shell twice, as two
// people, is the only way it reads — which is exactly the acceptance-video
// rule's test for a story that earns one.
//
// The recording is deliberately ordered admin → member → viewer, because the
// admin chapter is what makes the other two legible: you cannot see what is
// missing until you have seen it there.
//
// Nothing is stubbed. Real roles on real memberships, the real resolution, the
// real rail.
//
// ── WHY THIS SPEC HAS A RECEIPT PUBLISHED FROM A LATER PR (MOTIR-2501) ───────
//
// The receipt this file produces did not reach MOTIR-2258 on the runs that made
// it. The spec was never the problem: it recorded a 47s chaptered clip on every
// run it was in — 31305330776 and 31307902905, both of which then logged
// `Published 0 of 2` and went green anyway. The uploader was PUTting to a
// production deployment older than MOTIR-2389, so `/upload-token` still minted
// the previous wire shape, and `continue-on-error` on the publish step rewrote
// the failure to `success`. MOTIR-2499 removed the fail-open and made the stale
// deployment say so in one line instead of `Failed to parse URL`.
//
// The fix for the receipt itself was not code but a DEPLOYMENT: MOTIR-2392 moved
// app.motir.co onto Fly, where the mint returns the S3 presigned PUT this
// uploader expects. What was left was a run — and the lane has no `push:`
// trigger, so `main` never re-records. Hence this note. Both the workflow's
// `paths:` filter and the run's owned-spec set (`ACCEPTANCE_CHANGED_SPECS`) key
// on this file, so touching it is what re-triggers the lane and scopes the
// publish to this story alone.
//
// Nothing below changed, and nothing below should be "fixed" for this reason.

/**
 * The platform chord for ⌘K — `Meta` on a macOS dev box, `Control` on the Linux
 * CI runner. Mirrors `shell-flows.spec.ts` / `shell-keyboard.spec.ts`; pressing
 * the wrong one simply never opens the palette, which reads as a missing entry.
 */
async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

/** Open the palette and return its dialog locator (the search input auto-focuses). */
async function openPalette(page: Page) {
  await page.keyboard.press(`${await resolveMod(page)}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  return palette;
}

/**
 * Drop the session. Better-Auth's session is cookie-only, so clearing cookies is
 * equivalent to a sign-out from the client's perspective — the pattern
 * `auth-credentials.spec.ts` settled on (the smoke form's POST answers 415).
 */
async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * The primary rail. Every nav assertion below is scoped to it, and that is not
 * tidiness: the top bar's brand link is labelled "Motir — go to dashboard" and
 * the mobile drawer carries the same names, so an unscoped `name: 'Dashboard'`
 * resolves to two elements and fails strict mode. `shell.spec.ts` documents the
 * same trap — naming the rail is the fix, not tightening the string.
 */
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/**
 * The settings-AREA rail, which REPLACES the project nav inside
 * `/settings/project` and is labelled for the area rather than "Primary". Using
 * the wrong one of these two is silent: the locator simply finds nothing.
 */
const settingsRail = (page: Page) => page.getByRole('navigation', { name: 'Project settings' });

test.describe.configure({ timeout: 240_000 });

let seed: PermissionGatedSeed;

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedPermissionGatedUi('acceptance');
});

test('the shell shows each person the rooms they were given', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2258');

  await chapter('A project admin: every door is there', async () => {
    await signIn(page, seed.adminEmail, seed.password);
    await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();
    // The Project settings door, in the footer of the nav
    await beat();
    await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

    await rail(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL('**/settings/project');
    // Twelve sections, in four groups
    await beat();
    await expect(settingsRail(page).getByRole('link', { name: 'Members & access' })).toBeVisible();
    await expect(
      settingsRail(page).getByRole('link', { name: 'Roles & permissions' }),
    ).toBeVisible();
    await expect(settingsRail(page).getByRole('link', { name: 'Rules' })).toBeVisible();
  });

  await chapter('The same shell, as a project member: the door is not there', async () => {
    await signOut(page);
    await signIn(page, seed.memberEmail, seed.password);
    await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();

    // No Project settings row — and nothing marks the gap
    await beat();
    await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    // The rows below it simply closed up.
    await expect(rail(page).getByRole('link', { name: 'Job runs' })).toBeVisible();

    // ⌘K offers no way in either — it reads the same registry
    await beat();
    const palette = await openPalette(page);
    await expect(palette.getByRole('option', { name: /Members & access/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // And the room is shut, not merely unmentioned
    await beat();
    await page.goto('/settings/project/members');
    await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
    await expect(
      page.getByRole('paragraph').filter({ hasText: /managed by project admins/i }),
    ).toBeVisible();
  });

  await chapter('As a viewer: fewer rooms, and the same controls as before', async () => {
    await signOut(page);
    await signIn(page, seed.viewerEmail, seed.password);
    await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();

    // The destinations that would refuse them are gone from the nav
    await beat();
    for (const gone of ['Plans', 'Triage', 'Code health']) {
      await expect(rail(page).getByRole('link', { name: gone, exact: true })).toHaveCount(0);
    }
    // Every read surface stays
    await beat();
    await expect(rail(page).getByRole('link', { name: 'Boards', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Reports', exact: true })).toBeVisible();

    // And the in-place controls are UNCHANGED: visible, disabled, explained
    await beat();
    const create = page.getByLabel(/create/i).first();
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('aria-disabled', 'true');

    await rail(page).getByRole('link', { name: 'Boards', exact: true }).click();
    await page.waitForURL('**/boards');
    // The board is read-only — the create control is there, and refuses
    await beat();
    const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
    await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
    await expect(newWorkItem).toBeDisabled();
  });
});
