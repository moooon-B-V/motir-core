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
    await expect(page.getByRole('link', { name: 'Work Items' })).toBeVisible();
    // The Project settings door, in the footer of the nav
    await beat();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL('**/settings/project');
    // Twelve sections, in four groups
    await beat();
    await expect(page.getByRole('link', { name: 'Members & access' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Roles & permissions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Rules' })).toBeVisible();
  });

  await chapter('The same shell, as a project member: the door is not there', async () => {
    await signOut(page);
    await signIn(page, seed.memberEmail, seed.password);
    await expect(page.getByRole('link', { name: 'Work Items' })).toBeVisible();

    // No Project settings row — and nothing marks the gap
    await beat();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    // The rows below it simply closed up.
    await expect(page.getByRole('link', { name: 'Job runs' })).toBeVisible();

    // ⌘K offers no way in either — it reads the same registry
    await beat();
    const palette = await openPalette(page);
    await expect(palette.getByRole('option', { name: /Members & access/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // And the room is shut, not merely unmentioned
    await beat();
    await page.goto('/settings/project/members');
    await expect(page.getByText('Admins only')).toBeVisible();
    await expect(page.getByText(/managed by project admins/i)).toBeVisible();
  });

  await chapter('As a viewer: fewer rooms, and the same controls as before', async () => {
    await signOut(page);
    await signIn(page, seed.viewerEmail, seed.password);
    await expect(page.getByRole('link', { name: 'Work Items' })).toBeVisible();

    // The destinations that would refuse them are gone from the nav
    await beat();
    for (const gone of ['Plans', 'Triage', 'Code health']) {
      await expect(page.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
    }
    // Every read surface stays
    await beat();
    await expect(page.getByRole('link', { name: 'Boards', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reports', exact: true })).toBeVisible();

    // And the in-place controls are UNCHANGED: visible, disabled, explained
    await beat();
    const create = page.getByLabel(/create/i).first();
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('link', { name: 'Boards', exact: true }).click();
    await page.waitForURL('**/boards');
    // The board is read-only — the create control is there, and refuses
    await beat();
    const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
    await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
    await expect(newWorkItem).toBeDisabled();
  });
});
