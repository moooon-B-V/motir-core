// E2E: the Story-2.4 issue-DETAIL lifecycle (Subtask 2.4.6), driving the real
// shell. The Story CLOSER — it covers EVERY Story-2.4 surface end to end:
//   - the read surfaces (2.4.1–2.4.3): canonical page render, parent breadcrumb
//     + child-list tree navigation;
//   - the inline edit controls (2.4.4): workflow-aware status + assignee, both
//     verified to PERSIST across reload;
//   - readiness (2.4.5): a blocked item reads "Blocked"; resolving the blocker
//     flips it to "Ready to start";
//   - link management on the detail panel (2.4.9): add / remove (with the
//     reciprocal `relates_to` drop) + the cycle guardrail's inline error;
//   - link management in the create modal (2.4.10): collect-then-write-on-create.
//
// @smoke — exercises the UI↔service seams unit tests structurally can't: the
// inline Server Actions (changeStatusAction / updateIssueAction / create+remove
// link actions) → service → trigger → revalidate → the panel + readiness banner
// re-render. Mirrors the 1.6.6 / 2.3.8 real-stack lesson.
//
// Setup uses ONLY auth (shell-session signUp) + the 2.2.7 `_test` harness
// (work-items / work-item-links create + the gated `?status=` transition), so
// this has no ordering dependency on the create/edit specs. Selectors target the
// stable role/label hooks the detail components expose (the "Edit <field>"
// FieldCard toggles, the "Status"/"Assignee"/"Relationship"/"Work item to link"
// Comboboxes, the "Link issue" / per-row "Remove … link" affordances, the
// "Parent work items" nav, the "Child issues" / "Relationships" section cards), never
// brittle text.

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
 * active. Returns the project id (for `_test` calls). Mirrors the 2.3.8 spec. */
async function seedActiveProject(email: string, identifier: string): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Detail Flow',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

interface Created {
  id: string;
  identifier: string;
}

/** Create a work item through the `_test` route. Returns id + identifier. */
async function mk(
  page: Page,
  projectId: string,
  opts: { kind?: string; title: string; parentId?: string; descriptionMd?: string },
): Promise<Created> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: opts.kind ?? 'task', ...opts },
  });
  expect(res.status(), `create "${opts.title}"`).toBe(201);
  const dto = (await res.json()) as Created;
  return { id: dto.id, identifier: dto.identifier };
}

/** Add an `is_blocked_by` link (`fromId` is blocked by `toId`) via `_test`. */
async function linkBlockedBy(page: Page, fromId: string, toId: string): Promise<void> {
  const res = await page.request.post('/api/_test/work-item-links', {
    data: { fromId, toId, kind: 'is_blocked_by' },
  });
  expect(res.status(), 'create is_blocked_by link').toBe(201);
}

/** Drive the gated workflow transition (a single legal edge) via `_test`. */
async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

/** Walk an item from the default initial `todo` to terminal `done` via the
 * default-workflow legal path (todo → in_progress → in_review → done). */
async function driveToDone(page: Page, id: string): Promise<void> {
  await transition(page, id, 'in_progress');
  await transition(page, id, 'in_review');
  await transition(page, id, 'done');
}

async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** The item's `is_blocked_by` blockers, via `_test` — for "nothing persisted". */
async function blockersOf(page: Page, id: string): Promise<{ id: string }[]> {
  const res = await page.request.get(
    `/api/_test/work-item-links?workItemId=${id}&direction=blockers`,
  );
  expect(res.status(), 'list blockers').toBe(200);
  return (await res.json()) as { id: string }[];
}

test('@smoke renders the canonical detail page (header · rendered Markdown · core fields · Edit)', async ({
  page,
}) => {
  const email = 'e2e-detail-render@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'REN');
  const item = await mk(page, projectId, {
    title: 'Wire the dashboard',
    descriptionMd: 'Bold **important** and a [docs](https://example.com/guide) and `run()` code.',
  });

  await page.goto(`/issues/${item.identifier}`);

  // Header: identifier + title h1.
  await expect(page.getByRole('heading', { name: 'Wire the dashboard', level: 1 })).toBeVisible();
  await expect(page.getByText(item.identifier, { exact: true })).toBeVisible();

  // Rendered Markdown (not raw source): a real anchor, bold, and inline code.
  const desc = page.getByLabel('Work item description');
  await expect(desc.getByRole('link', { name: 'docs' })).toHaveAttribute(
    'href',
    'https://example.com/guide',
  );
  await expect(desc.locator('strong', { hasText: 'important' })).toBeVisible();
  await expect(desc.locator('code', { hasText: 'run()' })).toBeVisible();

  // Core-fields rail rendered (Reporter is always present) + the Edit link.
  await expect(page.getByText('Reporter')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' }).first()).toBeVisible();
});

test('@smoke tree navigation: breadcrumb walks up, child list walks down', async ({ page }) => {
  const email = 'e2e-detail-tree@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'TRE');
  const story = await mk(page, projectId, { kind: 'story', title: 'The Story' });
  const task = await mk(page, projectId, { kind: 'task', title: 'The Task', parentId: story.id });
  const sub = await mk(page, projectId, {
    kind: 'subtask',
    title: 'The Subtask',
    parentId: task.id,
  });

  // On the subtask, the breadcrumb shows the Story → Task lineage.
  await page.goto(`/issues/${sub.identifier}`);
  const breadcrumb = page.getByRole('navigation', { name: 'Parent work items' });
  await expect(breadcrumb.getByRole('link', { name: /The Story/ })).toBeVisible();
  const taskCrumb = breadcrumb.getByRole('link', { name: /The Task/ });
  await expect(taskCrumb).toBeVisible();

  // A breadcrumb link navigates UP to the ancestor's detail page.
  await taskCrumb.click();
  await page.waitForURL(`**/issues/${task.identifier}`);
  await expect(page.getByRole('heading', { name: 'The Task', level: 1 })).toBeVisible();

  // The Task's child list links DOWN to the subtask.
  const childLink = page.getByRole('link', { name: /The Subtask/ });
  await expect(childLink).toBeVisible();
  await childLink.click();
  await page.waitForURL(`**/issues/${sub.identifier}`);
  await expect(page.getByRole('heading', { name: 'The Subtask', level: 1 })).toBeVisible();
});

test('@smoke inline status: a legal transition persists; illegal targets are not offered', async ({
  page,
}) => {
  const email = 'e2e-detail-status@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'STA');
  const item = await mk(page, projectId, { title: 'Status me' });

  await page.goto(`/issues/${item.identifier}`);
  // Reveal the inline Status control, then open its picker.
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();

  // Restricted default workflow: from `todo` only in_progress / blocked /
  // cancelled are legal — Done + In Review are NOT offered.
  await expect(page.getByRole('option', { name: 'In Progress' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Done' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'In Review' })).toHaveCount(0);

  await page.getByRole('option', { name: 'In Progress' }).click();

  // Persists: the service stored it, and a reload still shows it.
  await expect(async () => {
    expect((await getItem(page, item.id)).status).toBe('in_progress');
  }).toPass();
  await page.reload();
  await expect(page.getByText('In Progress')).toBeVisible();
});

test('@smoke inline assignee: assign then unassign, both persist across reload', async ({
  page,
}) => {
  const email = 'e2e-detail-assignee@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'ASG');
  const item = await mk(page, projectId, { title: 'Assign me' });

  await page.goto(`/issues/${item.identifier}`);
  await page.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  // The member option's accessible name is `${name} ${email}` (label +
  // secondary), so match on the email — unique + unambiguous vs "Unassigned".
  await page.getByRole('option', { name: email }).click();

  await expect(async () => {
    expect((await getItem(page, item.id)).assigneeId).not.toBeNull();
  }).toPass();
  // Reloaded + not editing: the assignee field now names the member, so the
  // only place "Unassigned" could appear (the empty assignee field) is gone.
  await page.reload();
  await expect(page.getByText('Unassigned')).toHaveCount(0);

  // Unassign.
  await page.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await page.getByRole('option', { name: 'Unassigned' }).click();
  await expect(async () => {
    expect((await getItem(page, item.id)).assigneeId).toBeNull();
  }).toPass();
  await page.reload();
  await expect(page.getByText('Unassigned')).toBeVisible();
});

test('@smoke readiness: blocked item reads "Blocked", flips to "Ready" when the blocker is done', async ({
  page,
}) => {
  const email = 'e2e-detail-ready@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'RDY');
  const item = await mk(page, projectId, { title: 'Depends on infra' });
  const blocker = await mk(page, projectId, { title: 'Infra task' });
  await linkBlockedBy(page, item.id, blocker.id);

  await page.goto(`/issues/${item.identifier}`);
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
  await expect(page.getByText(/Waiting on 1 work item/)).toBeVisible();

  // Resolve the blocker (walk it to terminal `done`) → reload re-judges readiness.
  await driveToDone(page, blocker.id);
  await page.reload();
  await expect(page.getByText('Ready to start')).toBeVisible();
});

test('@smoke link management — add a blocked-by link via the panel; persists + flips readiness', async ({
  page,
}) => {
  const email = 'e2e-detail-link-add@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LADD');
  const a = await mk(page, projectId, { title: 'Needs a blocker' });
  const b = await mk(page, projectId, { title: 'The blocker issue' });

  await page.goto(`/issues/${a.identifier}`);
  // A fresh todo item with no blockers is the most ready it can be — it reads
  // "Ready to start" before any dependency exists (bug-ready-banner-no-deps).
  await expect(page.getByText('Ready to start')).toBeVisible();
  await page.getByRole('button', { name: 'Link work item' }).click();
  // Default relationship is "Blocked by" — just pick the target + Add.
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('option', { name: /The blocker issue/ }).click();
  await page.getByRole('button', { name: 'Add' }).click();

  // The blocker row appears and readiness flips to Blocked.
  await expect(page.getByRole('link', { name: /The blocker issue/ })).toBeVisible();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();

  // Persisted across reload.
  await page.reload();
  await expect(page.getByRole('link', { name: /The blocker issue/ })).toBeVisible();
  expect((await blockersOf(page, a.id)).map((x) => x.id)).toContain(b.id);
});

test('@smoke link management — remove a blocked-by link (confirm) flips back to Ready', async ({
  page,
}) => {
  const email = 'e2e-detail-link-remove@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LRM');
  const a = await mk(page, projectId, { title: 'Has two blockers' });
  const open = await mk(page, projectId, { title: 'Open blocker' });
  const resolved = await mk(page, projectId, { title: 'Resolved blocker' });
  await linkBlockedBy(page, a.id, open.id);
  await linkBlockedBy(page, a.id, resolved.id);
  await driveToDone(page, resolved.id); // terminal → not an OPEN blocker

  await page.goto(`/issues/${a.identifier}`);
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();

  // Remove the OPEN blocker via the per-row × → confirm popover → Remove link.
  await page.getByRole('button', { name: `Remove Blocked by link to ${open.identifier}` }).click();
  await page.getByRole('button', { name: 'Remove link' }).click();

  // Its row is gone; the remaining blocker is terminal → "Ready to start".
  await expect(page.getByRole('link', { name: /Open blocker/ })).toHaveCount(0);
  await expect(page.getByText('Ready to start')).toBeVisible();
  await page.reload();
  expect((await blockersOf(page, a.id)).map((x) => x.id)).toEqual([resolved.id]);
});

test('@smoke link management — removing a relates_to link drops both reciprocal rows', async ({
  page,
}) => {
  const email = 'e2e-detail-relates@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'REL');
  const a = await mk(page, projectId, { title: 'Issue Alpha' });
  const d = await mk(page, projectId, { title: 'Issue Delta' });

  // Add a relates_to link A → D through the panel.
  await page.goto(`/issues/${a.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Relationship' }).click();
  await page.getByRole('option', { name: 'Relates to' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('option', { name: /Issue Delta/ }).click();
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('link', { name: /Issue Delta/ })).toBeVisible();

  // The reciprocal row shows on D's page.
  await page.goto(`/issues/${d.identifier}`);
  await expect(page.getByRole('link', { name: /Issue Alpha/ })).toBeVisible();

  // Remove it from A → both halves drop.
  await page.goto(`/issues/${a.identifier}`);
  await page.getByRole('button', { name: `Remove Relates to link to ${d.identifier}` }).click();
  await page.getByRole('button', { name: 'Remove link' }).click();
  await expect(page.getByRole('link', { name: /Issue Delta/ })).toHaveCount(0);

  await page.goto(`/issues/${d.identifier}`);
  await expect(page.getByRole('link', { name: /Issue Alpha/ })).toHaveCount(0);
});

test('@smoke link management — a cycle attempt surfaces an inline error and persists nothing', async ({
  page,
}) => {
  const email = 'e2e-detail-cycle@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CYC');
  const a = await mk(page, projectId, { title: 'Alpha cyc' });
  const b = await mk(page, projectId, { title: 'Beta cyc' });
  await linkBlockedBy(page, a.id, b.id); // A is_blocked_by B

  // On B, try to add "Blocked by" → A: B is_blocked_by A would close A→B→A.
  await page.goto(`/issues/${b.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('option', { name: /Alpha cyc/ }).click();
  await page.getByRole('button', { name: 'Add' }).click();

  // The typed trigger error round-trips inline; nothing persists.
  await expect(page.getByText('That would create a dependency cycle.')).toBeVisible();
  expect(await blockersOf(page, b.id), 'no blocker written on B').toEqual([]);
});

test('@smoke create with a link (2.4.10): the link is written atomically with the new issue', async ({
  page,
}) => {
  const email = 'e2e-detail-create-link@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CRL');
  const target = await mk(page, projectId, { title: 'Pre-existing target' });

  await page.goto('/issues');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByLabel('Title').fill('Created with a link');

  // The Linked-issues section: pick the target (default "Blocked by") + Add.
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('option', { name: /Pre-existing target/ }).click();
  await page.getByRole('button', { name: 'Add' }).click();
  // The pending row renders before submit.
  await expect(
    page.getByRole('button', { name: `Remove pending blocked by link to ${target.identifier}` }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const toast = page.getByText(/ created$/);
  await expect(toast).toBeVisible();
  const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
  expect(identifier).toMatch(/^CRL-\d+$/);

  // The new issue's detail panel shows the link, written with the issue.
  await page.goto(`/issues/${identifier}`);
  await expect(page.getByRole('link', { name: /Pre-existing target/ })).toBeVisible();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
});

test('@smoke create with a link (2.4.10): removing the pending row before create writes nothing', async ({
  page,
}) => {
  const email = 'e2e-detail-create-link-drop@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CRD');
  const target = await mk(page, projectId, { title: 'Not actually linked' });

  await page.goto('/issues');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByLabel('Title').fill('No links after all');
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('option', { name: /Not actually linked/ }).click();
  await page.getByRole('button', { name: 'Add' }).click();

  // Drop the pending row before creating.
  const removePending = page.getByRole('button', {
    name: `Remove pending blocked by link to ${target.identifier}`,
  });
  await expect(removePending).toBeVisible();
  await removePending.click();
  await expect(removePending).toHaveCount(0);

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const toast = page.getByText(/ created$/);
  await expect(toast).toBeVisible();
  const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();

  await page.goto(`/issues/${identifier}`);
  // No relationships were written — the panel shows its empty state.
  await expect(page.getByText('No linked work items yet.')).toBeVisible();
});

test('@smoke cross-workspace isolation: a foreign identifier 404s; the link picker is own-workspace only', async ({
  page,
}) => {
  // Workspace A owns an issue.
  const emailA = 'e2e-detail-tenant-a@example.com';
  await signUp(page, emailA);
  const projectIdA = await seedActiveProject(emailA, 'AAA');
  const aItem = await mk(page, projectIdA, { title: 'A-only issue' });

  // Workspace B (fresh sign-up) cannot reach A's issue by URL.
  const emailB = 'e2e-detail-tenant-b@example.com';
  await signUp(page, emailB);
  const projectIdB = await seedActiveProject(emailB, 'BBB');
  const res = await page.goto(`/issues/${aItem.identifier}`);
  expect(res?.status(), "A's detail route 404s for B").toBe(404);

  // B's link picker surfaces only B's own items, never A's.
  const bItem = await mk(page, projectIdB, { title: 'B home issue' });
  await mk(page, projectIdB, { title: 'B candidate issue' });
  await page.goto(`/issues/${bItem.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await expect(page.getByRole('option', { name: /B candidate issue/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /A-only issue/ })).toHaveCount(0);
});
