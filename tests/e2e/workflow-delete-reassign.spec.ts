// E2E: delete-with-reassign for an in-use status (Story 2.3 · Subtask 2.3.1's
// flow; this is its end-to-end spec, Subtask 2.3.2).
//
// @smoke — proves the whole seam on the real shell: an owner adds a custom
// status, work items land on it, and deleting that in-use status opens the
// reassign modal, migrates every referencing item to a chosen target, and
// removes the status — with a per-item status-change revision written. Setup
// uses ONLY the auth + 2.2.7 `_test` harness helpers (no dependency on the
// 2.3.3 create modal / 2.3.6 edit form), so 2.3.2's depends_on stays [2.3.1].
//
// Reconciled vs 2.2.10 (defaults are protected/non-deletable): the card's
// negative path "delete the INITIAL status with a target → protection fires"
// is unreachable through the UI now — the initial status is the default `todo`,
// which renders with no Delete affordance at all. The second test asserts that
// protection at the UI seam instead (Default badge + no Delete button).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { createItem, transition } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side and pin it
 * active so the workflow settings UI (getActiveProject) resolves it. Returns the
 * project id for the `_test` work-item calls. Mirrors workflow-settings.spec. */
async function seedActiveProject(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Reassign Demo',
    identifier: 'RSG',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/settings/project/workflow');
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
}

test('@smoke delete-with-reassign: an in-use custom status migrates its items, then is removed', async ({
  page,
}) => {
  const email = 'e2e-delete-reassign@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);
  await gotoWorkflow(page);

  // Add a custom "Triage" status (Statuses tab).
  await page.getByRole('button', { name: 'Add status' }).click();
  await page.getByLabel('Key (machine id, lowercase)').fill('triage');
  await page.getByLabel('Label').fill('Triage');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Triage', { exact: true }).first()).toBeVisible();

  // Enable the todo→triage edge so the gated transition is legal (restricted mode).
  await page.getByRole('tab', { name: 'Transitions' }).click();
  const edge = page.getByRole('checkbox', { name: 'To Do to Triage' });
  await expect(edge).toHaveAttribute('aria-checked', 'false');
  await edge.click();
  await expect(page.getByRole('checkbox', { name: 'To Do to Triage' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Create 3 work items and move each into 'triage' through the gated _test path.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const item = await createItem(page.request, projectId, `Item ${i}`);
    const res = await transition(page.request, item.id, 'triage');
    expect(res.status(), 'todo→triage transition is legal').toBe(200);
    ids.push(item.id);
  }

  // Delete the in-use status → the reassign modal appears with the count.
  await page.getByRole('tab', { name: 'Statuses' }).click();
  const triageRow = page.getByRole('listitem').filter({ hasText: 'Triage' });
  await triageRow.getByRole('button', { name: 'Delete Triage' }).click();
  await expect(page.getByTestId('reassign-affected-count')).toContainText(
    '3 work items still use this status',
  );

  // Pick "To Do" as the target and confirm.
  await page.getByLabel('Move items to').selectOption({ label: 'To Do' });
  await page.getByRole('button', { name: 'Reassign & delete' }).click();

  // Success toast + the Triage row is gone from the editor.
  await expect(page.getByText('Status deleted')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Triage' })).toHaveCount(0);

  // Every item migrated to 'todo', each with a triage→todo status revision.
  for (const id of ids) {
    const got = await page.request.get(`/api/_test/work-items?id=${id}`);
    expect(got.status(), 'read migrated item').toBe(200);
    expect(((await got.json()) as { status: string }).status).toBe('todo');

    const revsRes = await page.request.get(`/api/_test/work-items?id=${id}&revisions=1`);
    expect(revsRes.status(), 'read item revisions').toBe(200);
    const revs = (await revsRes.json()) as {
      changeKind: string;
      diff: Record<string, { from: unknown; to: unknown }>;
    }[];
    const migration = revs.find(
      (r) =>
        r.changeKind === 'updated' &&
        r.diff.status?.from === 'triage' &&
        r.diff.status?.to === 'todo',
    );
    expect(migration, 'a triage→todo status-change revision was written').toBeTruthy();
  }
});

test('@smoke the initial (default) status is protected — no delete affordance to reach the reassign flow', async ({
  page,
}) => {
  // Post-2.2.10 the six default statuses (incl. the initial `todo`) are a
  // protected set: recolor only, no delete. So the card's "delete the initial
  // status" negative path is unreachable through the UI — assert that here.
  const email = 'e2e-reassign-protected@example.com';
  await signUp(page, email);
  await seedActiveProject(email);
  await gotoWorkflow(page);

  // The To Do row is the first (statuses are position-ordered, todo initial).
  // NB: filtering by hasText:'To Do' would also match the Blocked row, whose
  // category pill renders "To Do" (blocked is category=todo) — so use .first().
  const todoRow = page.getByRole('listitem').first();
  await expect(todoRow.getByText('To Do', { exact: true }).first()).toBeVisible();
  await expect(todoRow.getByText('Default', { exact: true })).toBeVisible();
  await expect(todoRow.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
});
