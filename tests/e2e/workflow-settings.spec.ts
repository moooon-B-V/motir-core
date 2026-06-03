// E2E: the workflow-management settings page (Story 2.2 · Subtask 2.2.5,
// revised by 2.2.10 / finding #49).
//
// @smoke — proves an owner can manage a project's workflow end to end through
// the real shell: the default statuses render and are PROTECTED (a "Default"
// badge, a color-only action, no Edit/Delete), a custom status adds + renames,
// a transition toggles off, and the policy mode flips (with its banner). The
// signed-up user is the workspace OWNER (creator = owner, finding #36), so the
// service's project-admin gate admits the edits. The project is created
// server-side (projectsService) + pinned active, then the UI drives every write
// through its Server Actions.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

const USER_EMAIL = 'e2e-workflow@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function seedActiveProject(email: string): Promise<void> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Workflow Demo',
    identifier: 'WFD',
  });
  // Pin the project active so getActiveProject() resolves it on the page.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/settings/project/workflow');
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
}

test('owner manages the workflow: defaults protected, custom status add + rename, toggle transition, flip policy', async ({
  page,
}) => {
  await signUp(page, USER_EMAIL);
  await seedActiveProject(USER_EMAIL);
  await gotoWorkflow(page);

  // The six default statuses render on the Statuses tab.
  for (const label of ['To Do', 'Blocked', 'In Progress', 'In Review', 'Done', 'Cancelled']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // A default status is PROTECTED (finding #49): it carries a "Default" badge
  // and a color-only action — NO Edit, NO Delete.
  const reviewRow = page.getByRole('listitem').filter({ hasText: 'In Review' });
  await expect(reviewRow.getByText('Default', { exact: true })).toBeVisible();
  await expect(reviewRow.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(reviewRow.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

  // Its "Color" action opens a recolor-only form — no Label field to rename.
  await reviewRow.getByRole('button', { name: 'Change color of In Review' }).click();
  await expect(page.getByText('only its color can be changed')).toBeVisible();
  await expect(page.getByLabel('Label')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Add a custom status — custom statuses stay fully editable.
  await page.getByRole('button', { name: 'Add status' }).click();
  await page.getByLabel('Key (machine id, lowercase)').fill('on_hold');
  await page.getByLabel('Label').fill('On Hold');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('On Hold', { exact: true }).first()).toBeVisible();

  // Rename the custom status: On Hold → On Standby.
  const customRow = page.getByRole('listitem').filter({ hasText: 'On Hold' });
  await customRow.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Label').fill('On Standby');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('On Standby', { exact: true }).first()).toBeVisible();

  // Transitions tab: toggle the todo→in_progress edge OFF.
  await page.getByRole('tab', { name: 'Transitions' }).click();
  const cell = page.getByRole('checkbox', { name: 'To Do to In Progress' });
  await expect(cell).toHaveAttribute('aria-checked', 'true');
  await cell.click();
  await expect(page.getByRole('checkbox', { name: 'To Do to In Progress' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  // Flip policy mode to Open and confirm the banner.
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Open mode: any status can transition to any other.')).toBeVisible();
});
