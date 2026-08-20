import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedCustomRoles, type CustomRolesSeed } from './_helpers/custom-roles-seed';

// AC7 of Bug MOTIR-3188 — the AUTHOR/DECIDE split, on the screen where the
// escalation it closes actually happened.
//
// The escalation was never a code path: it was an admin on the Roles &
// permissions grid ticking a switch labelled "View AI plans" and thereby handing
// a role the ability to materialize a whole subtree of work items. So the
// evidence this card owes at the UI is exactly two things, and both are here:
//
//   1. The grid RENDERS the new key, under `AI` and beside the key it was cut
//      out of — a permission the catalog carries and the screen does not draw is
//      one no admin can withhold.
//   2. A custom role can be AUTHORED holding one of the two and not the other,
//      and the role then reads back that way. That is the capability the split
//      exists to create; before it, the two were one switch.
//
// ⚠️ IT DOES NOT RE-TEST THE GATE. Whether `approvePlan` refuses such a role is
// asserted at the service, against real Postgres, in
// `tests/permissions/planDecisionGate.integration.test.ts` — a browser is a poor
// instrument for a permission refusal and a good one for a permission SCREEN.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark
// or a `waitForResponse` armed BEFORE its action. No fixed-duration sleep.

/** The two labels, as the shipped `en` catalogue renders them. */
const AUTHOR_LABEL = 'Author AI plans';
const DECIDE_LABEL = 'Approve or decline AI plans';

const ROLE_NAME = 'Plan follower';

const railEntry = (page: Page) => page.getByRole('link', { name: 'Roles & permissions' });

async function openRolesList(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(railEntry(page)).toBeVisible();
  await railEntry(page).click();
  await page.waitForURL('**/settings/project/roles');
  await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
}

/** Sign in AND wait for the shell to settle — `signIn` resolves on the URL
 *  match, which is not the same as settled, and the landing page's own
 *  navigation will otherwise interrupt the next `page.goto`. */
async function signInAndSettle(page: Page, email: string, password: string): Promise<void> {
  await signIn(page, email, password);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 30_000,
  });
}

let seed: CustomRolesSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedCustomRoles(`plan-decision-${Date.now()}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('the AI group carries both plan keys, and a role can hold author without decide', async ({
  page,
}) => {
  await signInAndSettle(page, seed.adminEmail, seed.password);

  // ── 1 · THE GRID DRAWS BOTH ────────────────────────────────────────────────
  await openRolesList(page);
  await page.locator('[data-role-row="member"]').click();
  await page.waitForURL('**/settings/project/roles/member');

  const authorRow = page.locator('[data-permission="ai:view_plan"]');
  const decideRow = page.locator('[data-permission="ai:decide_plan"]');
  await expect(authorRow).toBeVisible();
  await expect(decideRow).toBeVisible();
  await expect(decideRow).toContainText(DECIDE_LABEL);

  // Under the AI heading, and adjacent — the pair has to read as a pair, or an
  // admin scanning the grid sees a permission with no relation to the one it was
  // split from. `data-permission` rows are emitted in catalog order within their
  // domain group, so "the next row" is the assertion that says so.
  const aiKeys = await page
    .locator('[data-permission^="ai:"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-permission')));
  expect(aiKeys).toContain('ai:decide_plan');
  expect(aiKeys.indexOf('ai:decide_plan')).toBe(aiKeys.indexOf('ai:view_plan') + 1);

  // Member holds BOTH today — the split is behaviour-neutral on the built-ins,
  // and a grid showing the new key as withheld for Member would be evidence the
  // change was NOT neutral.
  for (const row of [authorRow, decideRow]) {
    await expect(row.getByRole('img')).toHaveAttribute('aria-label', 'Held');
  }

  // ── 2 · AUTHOR A ROLE THAT HOLDS ONE AND NOT THE OTHER ─────────────────────
  await openRolesList(page);
  await page.getByTestId('create-role').click();
  await page.waitForURL('**/settings/project/roles/new');
  await page.getByLabel('Name').fill(ROLE_NAME);
  await page.getByLabel('Start from').selectOption('member');

  // The switch that carried the escalation. Unticking it is the act that was
  // impossible before this card: under the old model the only way to withhold
  // approve was to withhold the plans surface entirely.
  const decideBox = page.getByRole('checkbox', { name: DECIDE_LABEL });
  await expect(decideBox).toHaveAttribute('aria-checked', 'true');
  await decideBox.click();
  await expect(decideBox).toHaveAttribute('aria-checked', 'false');
  // …and the AUTHOR half is deliberately left ON, so what is being asserted is a
  // SEPARATION rather than "the whole AI group was turned off".
  await expect(page.getByRole('checkbox', { name: AUTHOR_LABEL })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const created = page.waitForResponse(
    (res) => /\/roles$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create role' }).click();
  expect((await created).status()).toBe(201);

  // ── 3 · IT READS BACK THAT WAY ─────────────────────────────────────────────
  await expect(page.getByRole('heading', { name: ROLE_NAME, level: 1 })).toBeVisible();
  await expect(page.locator('[data-permission="ai:view_plan"]').getByRole('img')).toHaveAttribute(
    'aria-label',
    'Held',
  );
  await expect(page.locator('[data-permission="ai:decide_plan"]').getByRole('img')).toHaveAttribute(
    'aria-label',
    'Not held',
  );
});
