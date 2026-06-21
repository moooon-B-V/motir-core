// E2E: the work-item detail Sprint field + "Add to active sprint" ⋯ action
// (Subtask 2.4.14). Drives the real shell + the assign route (4.1.4) through the
// UI seams unit tests can't reach:
//   - the inline Sprint FieldCard (Backlog → a sprint, persisted across reload);
//   - the ⋯ menu's "Add to active sprint" quick action — ENABLED against an
//     active sprint (assigns), and the no-active-sprint DISABLED state-gate.
//
// @smoke — the UI → client helper → POST /api/work-items/[id]/sprint → service →
// the rail / menu round-trip. Sprints are created/started server-side via
// sprintsService (a planned sprint is selectable in the field; an active one is
// the menu's target). Selectors target stable role/label hooks (the "Edit
// Sprint" FieldCard toggle, the "Sprint" Combobox, the "Add to active sprint"
// menuitem, the "Actions for <key>" ⋯ trigger), never brittle text.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

type Created = { id: string; identifier: string };

/** Sign-up auto-creates the workspace; create a project + pin it active. Returns
 * the project id AND the owner's ServiceContext (for server-side sprint setup). */
async function seedProject(
  email: string,
  identifier: string,
): Promise<{ projectId: string; ctx: ServiceContext }> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Sprint Field',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { projectId: project.id, ctx: { userId: user!.id, workspaceId: ws!.id } };
}

/** Create a work item through the `_test` route. */
async function mk(page: Page, projectId: string, title: string): Promise<Created> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  const dto = (await res.json()) as Created;
  return { id: dto.id, identifier: dto.identifier };
}

async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Await the assign route's 200 (armed BEFORE the action — the authoritative
 * signal; never lean on optimistic UI + auto-retry). */
function awaitSprintWrite(page: Page) {
  return page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/sprint$/.test(r.url()) && r.request().method() === 'POST',
  );
}

/** The Sprint FieldCard's content (label + value), reached via its "Edit Sprint"
 * toggle (button → header row → Card content wrapper). Value assertions MUST be
 * scoped to it: the shell's project nav renders its own "Backlog" link and the
 * activity feed names the sprint, so an unscoped `getByText` is a strict-mode
 * violation (two matches). */
function sprintField(page: Page) {
  return page.getByRole('button', { name: 'Edit Sprint' }).locator('..').locator('..');
}

test('@smoke inline Sprint field: Backlog → a sprint, persists across reload', async ({ page }) => {
  const email = 'e2e-sprint-field@example.com';
  await signUp(page, email);
  const { projectId, ctx } = await seedProject(email, 'SPF');
  const item = await mk(page, projectId, 'Schedule me');
  const sprint = await sprintsService.createSprint(projectId, { name: 'Sprint A' }, ctx);

  await page.goto(`/items/${item.identifier}`);
  // Starts in the backlog (the muted-italic value, not "None").
  await expect(sprintField(page).getByText('Backlog')).toBeVisible();

  // Edit → the picker autoOpens; pick the planned sprint (option name = label +
  // "Planned" secondary, so match on the name substring).
  await page.getByRole('button', { name: 'Edit Sprint' }).click();
  const write = awaitSprintWrite(page);
  await page.getByRole('option', { name: /Sprint A/ }).click();
  expect((await write).status()).toBe(200);

  // Persisted server-side + after a reload the field names the sprint.
  await expect.poll(async () => (await getItem(page, item.id)).sprintId).toBe(sprint.id);
  await page.reload();
  await expect(sprintField(page).getByText('Sprint A')).toBeVisible();
});

test('@smoke ⋯ "Add to active sprint" assigns to the active sprint', async ({ page }) => {
  const email = 'e2e-sprint-menu@example.com';
  await signUp(page, email);
  const { projectId, ctx } = await seedProject(email, 'SPM');
  const item = await mk(page, projectId, 'Triage me');

  // An ACTIVE sprint needs ≥1 issue to start (the 4.2.1 rule), so seed a filler
  // into it; the test item stays in the backlog.
  const filler = await mk(page, projectId, 'Filler');
  const sprint = await sprintsService.createSprint(projectId, { name: 'Sprint Live' }, ctx);
  await backlogService.assignToSprint(filler.id, sprint.id, undefined, ctx);
  await sprintsService.startSprint(sprint.id, {}, ctx);

  await page.goto(`/items/${item.identifier}`);
  await page.getByRole('button', { name: /Actions for/ }).click();
  const row = page.getByRole('menuitem', { name: 'Add to active sprint' });
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');

  const write = awaitSprintWrite(page);
  await row.click();
  expect((await write).status()).toBe(200);

  await expect.poll(async () => (await getItem(page, item.id)).sprintId).toBe(sprint.id);
});

test('⋯ "Add to active sprint" is a DISABLED state-gate when no sprint is active', async ({
  page,
}) => {
  const email = 'e2e-sprint-none@example.com';
  await signUp(page, email);
  const { projectId } = await seedProject(email, 'SPN');
  const item = await mk(page, projectId, 'No sprint here');

  await page.goto(`/items/${item.identifier}`);
  await page.getByRole('button', { name: /Actions for/ }).click();

  // Shown (NOT hidden — the transient state-gate deviation) but disabled.
  const row = page.getByRole('menuitem', { name: 'Add to active sprint' });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-disabled', 'true');
});
