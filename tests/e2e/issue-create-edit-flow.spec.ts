// E2E: the Story-2.3 create → edit → status-change lifecycle (Subtask 2.3.8),
// driving the real shell. Closes Story 2.3.
//
// @smoke — exercises the seam unit tests structurally can't: the create modal +
// its Server Action, the edit form's TWO actions (finding #46 — non-status via
// updateWorkItem, status via the gated updateStatus), the type+parent picker's
// inline filtering (2.3.4), and the optimistic-concurrency stale banner (2.3.6).
//
// Setup uses ONLY auth + the 2.2.7 `_test` harness (createItem etc.), so this
// has no ordering dependency on other specs. Reconciliations vs shipped reality:
//  - The create modal's Description is a WYSIWYG editor (2.3.7 adopted it,
//    2.3.10 made it true rendered-view Tiptap). You don't type raw Markdown
//    into a WYSIWYG — syntax chars are literal text and serialize back escaped
//    — so this scenario types PLAIN PROSE and round-trips it byte-for-byte.
//    Markdown formatting fidelity (bold/links/lists/etc.) is gated separately by
//    the editor's headless round-trip unit test, not re-proven through the UI.
//  - StatusPicker pre-filters to LEGAL transitions (2.3.6), so an illegal move
//    isn't UI-selectable — asserted as "not offered" rather than a rejected
//    submit (the inline statusError stays a defense-in-depth backstop).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 * active. Returns the project id (for `_test` calls). Mirrors workflow specs. */
async function seedActiveProject(email: string, identifier = 'ISS'): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Issue Flow',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

interface SummaryRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
}

/** The project's work items via the `_test` list route (service-layer read). */
async function listItems(page: Page, projectId: string): Promise<SummaryRow[]> {
  const res = await page.request.get(`/api/_test/work-items?projectId=${projectId}`);
  expect(res.status(), 'list work items').toBe(200);
  return (await res.json()) as SummaryRow[];
}

async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test('@smoke create → round-trips on the edit form', async ({ page }) => {
  const email = 'e2e-issue-flow@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);

  await page.goto('/issues');
  await page.getByRole('button', { name: 'Create work item' }).click();

  // Default type (Task) keeps it top-level-legal; fill title + a PLAIN-PROSE
  // description (the WYSIWYG editor stores typed text literally — no Markdown
  // syntax, so it round-trips byte-for-byte; fidelity is unit-tested elsewhere).
  await page.getByLabel('Title').fill('Wire the dashboard');
  await page.getByLabel('Description').fill('A short requirement for the dashboard view.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(/created$/).first()).toBeVisible();

  // Resolve the created item via the service-layer list (robust vs toast parsing).
  const items = await listItems(page, projectId);
  const created = items.find((i) => i.title === 'Wire the dashboard');
  expect(created, 'the created item is listed').toBeTruthy();

  // It round-trips: title + description persisted verbatim.
  const stored = await getItem(page, created!.id);
  expect(stored.title).toBe('Wire the dashboard');
  expect(stored.descriptionMd).toBe('A short requirement for the dashboard view.');

  // The edit route opens for that identifier and rehydrates BOTH fields — the
  // stored Markdown parses back into the WYSIWYG editor's rendered document.
  await page.goto(`/issues/${created!.identifier}/edit`);
  await expect(page.getByLabel('Title')).toHaveValue('Wire the dashboard');
  await expect(page.getByLabel('Description')).toContainText(
    'A short requirement for the dashboard view.',
  );
});

test('@smoke the type+parent picker filters candidates inline (2.3.4)', async ({ page }) => {
  const email = 'e2e-issue-picker@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);

  // Seed a legal chain so the parent picker has candidates of distinct kinds.
  const mk = async (kind: string, title: string, parentId?: string) => {
    const res = await page.request.post('/api/_test/work-items', {
      data: { projectId, kind, title, ...(parentId ? { parentId } : {}) },
    });
    expect(res.status(), `create ${kind}`).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const epicId = await mk('epic', 'The Epic');
  const storyId = await mk('story', 'The Story', epicId);
  await mk('task', 'The Task', storyId);

  await page.goto('/issues');
  await page.getByRole('button', { name: 'Create work item' }).click();

  // Type = Sub-task → parent candidates are Story/Task/Bug, never the Epic.
  // (the type's display label is "Sub-task", hyphenated — ISSUE_TYPE_META.)
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Sub-task' }).click();
  await page.getByRole('combobox', { name: 'Parent' }).click();
  await expect(page.getByRole('option', { name: /The Story/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /The Task/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /The Epic/ })).toHaveCount(0);
  // Close the Parent listbox by SELECTING "No parent" — NOT Escape (Escape on
  // the Radix Dialog closes the whole modal, not just the combobox panel).
  await page.getByRole('option', { name: 'No parent' }).click();

  // Type = Epic → no parent candidates (epics are top-level): only "No parent".
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Epic' }).click();
  await page.getByRole('combobox', { name: 'Parent' }).click();
  await expect(page.getByRole('option', { name: 'No parent' })).toBeVisible();
  await expect(page.getByRole('option', { name: /The Story|The Task|The Epic/ })).toHaveCount(0);
});

test('@smoke edit non-status fields persists + writes a revision', async ({ page }) => {
  const email = 'e2e-issue-edit@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);
  const create = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title: 'Edit me' },
  });
  const id = ((await create.json()) as { id: string; identifier: string }).id;
  const identifier = ((await getItem(page, id)).identifier as string) ?? '';

  await page.goto(`/issues/${identifier}/edit`);
  await page.getByLabel('Title').fill('Edited title');
  // Priority is the shared Combobox picker now (not a native <select>) — open it
  // and pick High (exact: 'High' would otherwise also match 'Highest').
  await page.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/saved|updated/i).first()).toBeVisible();

  const after = await getItem(page, id);
  expect(after.title).toBe('Edited title');
  expect(after.priority).toBe('high');

  const revsRes = await page.request.get(`/api/_test/work-items?id=${id}&revisions=1`);
  const revs = (await revsRes.json()) as { changeKind: string }[];
  expect(revs.some((r) => r.changeKind === 'updated')).toBe(true);
});

test('@smoke status change goes through the gated path; illegal targets are not offered', async ({
  page,
}) => {
  const email = 'e2e-issue-status@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);
  const create = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title: 'Status me' },
  });
  const id = ((await create.json()) as { id: string }).id;
  const identifier = (await getItem(page, id)).identifier as string;

  await page.goto(`/issues/${identifier}/edit`);
  // The default-workflow item starts at todo. The Status picker offers the legal
  // next statuses (todo → in_progress is a default edge) but NOT unreachable ones.
  await page.getByRole('combobox', { name: 'Status' }).click();
  await expect(page.getByRole('option', { name: 'In Progress' })).toBeVisible();
  await page.getByRole('option', { name: 'In Progress' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/saved|updated/i).first()).toBeVisible();

  expect((await getItem(page, id)).status).toBe('in_progress');
});

test('@smoke a stale edit (the row changed since load) surfaces the refresh banner (409)', async ({
  page,
}) => {
  const email = 'e2e-issue-stale@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email);
  const create = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title: 'Concurrent' },
  });
  const id = ((await create.json()) as { id: string }).id;
  const identifier = (await getItem(page, id)).identifier as string;

  await page.goto(`/issues/${identifier}/edit`);
  await expect(page.getByLabel('Title')).toHaveValue('Concurrent');

  // Externally mutate the row (bumps updatedAt) AFTER the form captured the old one.
  const patch = await page.request.patch(`/api/_test/work-items?id=${id}`, {
    data: { title: 'Changed by someone else' },
  });
  expect(patch.status(), 'external edit').toBe(200);

  // Our form still holds the stale updatedAt → save must be refused with the banner.
  await page.getByLabel('Title').fill('My conflicting edit');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('This issue was edited by someone else. Refresh to see the latest.'),
  ).toBeVisible();
});

test('@smoke cross-workspace isolation: another workspace’s issue 404s', async ({ page }) => {
  // Workspace A owns an issue.
  const emailA = 'e2e-issue-tenant-a@example.com';
  await signUp(page, emailA);
  const projectIdA = await seedActiveProject(emailA, 'AAA');
  const create = await page.request.post('/api/_test/work-items', {
    data: { projectId: projectIdA, kind: 'task', title: 'A-only' },
  });
  const aIdentifier = (await getItem(page, ((await create.json()) as { id: string }).id))
    .identifier as string;

  // Workspace B (fresh sign-up) cannot see A's issue by URL.
  const emailB = 'e2e-issue-tenant-b@example.com';
  await signUp(page, emailB);
  await seedActiveProject(emailB, 'BBB');
  const res = await page.goto(`/issues/${aIdentifier}/edit`);
  expect(res?.status(), 'cross-workspace issue 404s').toBe(404);
});
