// E2E smoke: the workspace Members page's role column (Story MOTIR-6168 ·
// MOTIR-6465) — the instrument that OPENS this surface, landed with it so every
// later PR's CI renders the page. The full walk (change a role, the migration
// notice, the Roles pages) is the story E2E's.
//
// A person who signs up owns one workspace, and one workspace keeps
// `/settings/workspace` below the reveal (it 404s, `organization-tier.md` §6d),
// so the fixture adds a SECOND workspace in their organization through the
// shipped service — the same door the "New workspace" control drives.
//
// LOCATOR DISCIPLINE (MOTIR-3737): every locator after a navigation is
// role-based, so the outgoing subtree React keeps mounted cannot match it.

import { expect, test } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { workspacesService } from '@/lib/services/workspacesService';

const EMAIL = 'e2e-members-roles@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test('a Manager sees the role column on the revealed workspace Members page', async ({ page }) => {
  await signUp(page, EMAIL);

  const user = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
    include: { workspace: true },
  });
  await workspacesService.createWorkspace({
    name: 'Sales',
    ownerUserId: user.id,
    organizationId: membership.workspace.organizationId,
  });

  const response = await page.goto('/settings/workspace');
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
  // The creator is the organization's Owner, so their row is locked at Manager
  // with the reason (design panel 6a) — and the picker is still the role column.
  const picker = page.getByRole('combobox', { name: new RegExp(`^Role for `) });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Manager');
  await expect(picker).toBeDisabled();
});
