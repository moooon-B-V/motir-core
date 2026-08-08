import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { formatViolations, WCAG_TAGS, type AxeViolation } from './_helpers/a11y';
import {
  seedRolesPermissions,
  ROLE_HEADCOUNT,
  type RolesPermissionsSeed,
} from './_helpers/roles-permissions-seed';

// Story MOTIR-2282 — Roles & permissions, end to end (Subtask MOTIR-2265).
//
// The story's `verification_recipe`, automated, and the clip it is accepted on.
//
// ⚠️ EVERY ARRIVAL IS REACHED BY CLICKING, NEVER BY TYPING A URL — except the
// no-access step, where a direct navigation IS the case under test. A route can
// resolve perfectly while nothing in the interface links to it, and a drill-down
// has TWO doors to get wrong: the rail entry into the list, and the row into the
// detail. Both clicks are part of the spec so both doors are verified alongside
// the rooms.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark
// or a settled navigation. There is no bare timeout in this file.

test.describe.configure({ timeout: 180_000 });

const railEntry = (page: Page) => page.getByRole('link', { name: 'Roles & permissions' });

/** `"10 of 28 permissions"` → `[10, 28]`, failing loudly if the row has no count. */
function parseCount(text: string): [number, number] {
  const match = text.match(/(\d+) of (\d+) permissions/);
  expect(match, `no "N of M permissions" in ${JSON.stringify(text)}`).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}
// ⚠️ SCOPED BY `data-role-row`, NOT BY ACCESSIBLE NAME. `getByRole('link', {
// name: /Member/ })` also matches the settings rail's "Members & access" row —
// a strict-mode violation that reads as a broken page rather than as a broken
// locator. The attribute is the role's own key, so the match is exact by
// construction.
const roleRow = (page: Page, role: 'admin' | 'member' | 'viewer') =>
  page.locator(`[data-role-row="${role}"]`);
const backToList = (page: Page) => page.getByRole('link', { name: 'All roles' });

/** The list screen has landed when its own heading and all three rows are up. */
async function expectRoleList(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
  for (const role of ['admin', 'member', 'viewer'] as const) {
    await expect(roleRow(page, role)).toBeVisible();
  }
}

/** Open project settings from the shell, then the roles list — by clicking. */
async function openRolesList(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(railEntry(page)).toBeVisible();
  await railEntry(page).click();
  await page.waitForURL('**/settings/project/roles');
  await expectRoleList(page);
}

async function expectNoAxeViolations(page: Page, route: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(violations, formatViolations(route, violations as AxeViolation[])).toEqual([]);
}

let seed: RolesPermissionsSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedRolesPermissions(`roles-${Date.now()}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a project admin reads the role list, drills into a role, and comes back', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2282');

  await signIn(page, seed.adminEmail, seed.password);

  await chapter('Project settings → Access → Roles & permissions, from the rail', async () => {
    await page.goto('/settings/project');
    await expect(railEntry(page)).toBeVisible();
    await beat();

    // THE DOOR. Clicked, not typed — a page nobody can reach passes every test
    // that navigates to it directly.
    await railEntry(page).click();
    await page.waitForURL('**/settings/project/roles');
    await expectRoleList(page);
    await beat();
  });

  await chapter('Each role says what it is, how much it holds, and who holds it', async () => {
    const admin = roleRow(page, 'admin');
    await expect(admin).toContainText('Admin');
    await expect(admin).toContainText('Built-in');
    await expect(admin).toContainText('Runs the project');

    // `N of M`, read off the page and checked for internal consistency: admin
    // holds everything, so its N and its M are the same number, and the other
    // two roles hold strictly less of the SAME M.
    const [held, total] = parseCount(
      await admin.locator('text=/\\d+ of \\d+ permissions/').innerText(),
    );
    expect(held).toBe(total);
    expect(total).toBeGreaterThan(20);
    for (const role of ['member', 'viewer'] as const) {
      const row = roleRow(page, role);
      const [rowHeld, rowTotal] = parseCount(
        await row.locator('text=/\\d+ of \\d+ permissions/').innerText(),
      );
      expect(rowTotal).toBe(total);
      expect(rowHeld).toBeLessThan(total);
    }

    // THE HEADCOUNTS, tied to the memberships the seed created — and the three
    // are deliberately distinct, so a placeholder or the wrong role's count
    // cannot pass.
    await expect(admin).toContainText(`${ROLE_HEADCOUNT.admin} member`);
    await expect(roleRow(page, 'member')).toContainText(`${ROLE_HEADCOUNT.member} members`);
    await expect(roleRow(page, 'viewer')).toContainText(`${ROLE_HEADCOUNT.viewer} members`);
    await beat();

    // The level-gated grants are explained rather than hidden — they are not a
    // role, and the page says so.
    await expect(page.getByText('Public requests')).toBeVisible();
    await expect(page.getByText('Access level', { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('Drilling into Member shows the whole model at full width', async () => {
    await roleRow(page, 'member').click();
    await page.waitForURL('**/settings/project/roles/member');

    await expect(page.getByRole('heading', { name: 'Member', level: 1 })).toBeVisible();
    await expect(page.getByText('Built-in · can’t be changed')).toBeVisible();

    // Domain headings, and human labels rather than raw catalog keys.
    await expect(page.getByText('Work items', { exact: true })).toBeVisible();
    await expect(page.getByText('Comments', { exact: true })).toBeVisible();
    await expect(page.getByText('Edit work items')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('work_item:edit');
    await beat();

    // One permission this role HOLDS and one it does NOT — the marks are the
    // screen's whole content, so a spot-check of both is what proves they are
    // driven by the role's set rather than painted uniformly.
    const held = page.locator('[data-permission="work_item:edit"]');
    await expect(held.getByRole('img')).toHaveAttribute('aria-label', 'Held');
    const withheld = page.locator('[data-permission="project:administer"]');
    await expect(withheld.getByRole('img')).toHaveAttribute('aria-label', 'Not held');
    await beat();
  });

  await chapter('“All roles” goes back to the list', async () => {
    await backToList(page).click();
    await page.waitForURL('**/settings/project/roles');
    await expectRoleList(page);
    await beat();
  });
});

test('a project member reads both screens and can change nothing', async ({ page }) => {
  await signIn(page, seed.memberEmail, seed.password);
  await openRolesList(page);

  // Same content — a member is not shown a lesser version of the model.
  await expect(roleRow(page, 'admin')).toContainText('Built-in');
  await expect(page.getByText('Public requests')).toBeVisible();

  // …and no write affordance on either screen. Asserted as absences of the
  // named controls, since the whole card is read-only for everyone today.
  for (const name of [/Create role/, /^Edit$/, /^Delete$/]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }

  await roleRow(page, 'viewer').click();
  await page.waitForURL('**/settings/project/roles/viewer');
  await expect(page.getByRole('heading', { name: 'Viewer', level: 1 })).toBeVisible();
  for (const name of [/Create role/, /^Edit$/, /^Delete$/]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
});

test('a user with no access to the project gets the no-access panel on BOTH routes', async ({
  page,
}) => {
  await signIn(page, seed.outsiderEmail, seed.password);

  // A DIRECT navigation is the case under test here — the question is what a
  // typed URL does for somebody the rail has already hidden the entry from.
  for (const route of ['/settings/project/roles', '/settings/project/roles/admin']) {
    await page.goto(route);
    // The shipped no-access panel, not a crash and not an empty shell. Named
    // EXACTLY: the settings rail also carries a "Back to <project>" link, and a
    // loose /Back to/ matches both — a strict-mode violation that reads as a
    // broken page rather than as a broken locator.
    await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toHaveCount(0);
    await expect(page.getByText('Public requests')).toHaveCount(0);
  }

  // And no door: the rail entry is filtered away for an actor who cannot browse.
  await expect(railEntry(page)).toHaveCount(0);
});

test('both screens are free of axe violations', async ({ page }) => {
  await signIn(page, seed.adminEmail, seed.password);

  await openRolesList(page);
  await expectNoAxeViolations(page, '/settings/project/roles');

  await roleRow(page, 'admin').click();
  await page.waitForURL('**/settings/project/roles/admin');
  await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, '/settings/project/roles/[roleKey]');
});

// Step 6 of the recipe — NOTHING REGRESSED. This story's whole claim is that it
// changes what a person can SEE about the model and nothing about what they can
// DO. A refactor of the access seam is exactly the change most likely to break
// something far from where it was made, so a real viewer walks the two
// affordances the shipped policy already gates, with the same locator
// `project-access.spec.ts` uses.
test('a project viewer keeps exactly the affordances they had before', async ({ page }) => {
  await signIn(page, seed.viewerEmail, seed.password);

  // Browse succeeded — the toolbar is in the can-browse branch, so its presence
  // is the proof, and its DISABLED state is the read-only gate still holding.
  await page.goto('/boards');
  const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
  await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
  await expect(newWorkItem, 'a viewer must still not be able to create work items').toBeDisabled();

  // …and the roles surface is readable by them too — a viewer is a reader of the
  // model, not somebody it is hidden from.
  await openRolesList(page);
  await expect(roleRow(page, 'viewer')).toContainText(`${ROLE_HEADCOUNT.viewer} members`);
});
