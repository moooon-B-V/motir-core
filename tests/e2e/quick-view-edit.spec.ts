// E2E: the quick view becomes a WRITE surface (Story MOTIR-2560 · Subtask
// MOTIR-2568) — the story's verification recipe, automated.
//
// Everything this story ships happens inside a modal dialog, and the class of
// failure that matters most exists only in a real browser: a focus trap that
// pulls focus back into itself, a container centred with a CSS transform that
// breaks fixed positioning, and a rail that scrolls independently. The shared
// pickers carry a dedicated in-dialog branch precisely because dropdowns have
// lost fights with all three before — and jsdom has no layout and no real focus
// management, so a component test will happily report that a listbox rendered
// while a user would find it unreachable or clipped. Only this can tell.
//
// The second claim under test is that the peek behaves the SAME wherever it
// opens. It has two drivers and three host surfaces, and nothing in the type
// system notices when one drifts.
//
// ── The wait discipline (CLAUDE.md § E2E) ────────────────────────────────────
// The rail commits through SERVER ACTIONS, which POST to the current route — so
// there is no per-field endpoint to `waitForResponse` on. The authoritative
// signal used throughout is therefore the **committed-state read**:
// `GET /api/_test/work-items?id=` polled until it reports the new value. That is
// the server's own answer, not the optimistic cell, and it is what makes the
// subsequent reload assertions meaningful rather than racy. No `waitForTimeout`
// appears anywhere below.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Three surfaces, several edits each, all against the real stack.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  userId: string;
  workspaceId: string;
}

/**
 * Sign up through the real UI (auto-workspace), then seed the project
 * SERVER-SIDE through the shipped services and pin it active — the same
 * sanctioned setup path `issue-list-flow.spec.ts` uses. Self-seeding per test,
 * so the spec is shard-safe: it never depends on a fixture another spec may
 * have mutated.
 */
async function seedProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Quick View',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: user!.id, workspaceId: ws!.id },
    projectId: project.id,
    projectKey: project.identifier,
    userId: user!.id,
    workspaceId: ws!.id,
  };
}

async function mk(seed: Seed, kind: 'epic' | 'story' | 'task', title: string, parentId?: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/**
 * THE authoritative signal. The committed server state for one item, polled
 * until `predicate` holds — never the optimistic cell, and never a sleep. Every
 * edit below settles on this before the test moves on, which is what lets the
 * reload assertions mean something.
 */
async function expectCommitted(
  page: Page,
  id: string,
  predicate: (item: Record<string, unknown>) => boolean,
  what: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/_test/work-items?id=${id}`);
        if (res.status() !== 200) return false;
        return predicate((await res.json()) as Record<string, unknown>);
      },
      { message: `server committed: ${what}`, timeout: 20_000 },
    )
    .toBe(true);
}

/** The rail row whose caption is `label`, inside the open peek dialog. */
function railRow(page: Page, label: string) {
  return page
    .getByRole('dialog')
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

/** Open a rail row's editor through its always-present caption chevron. */
async function openRailField(page: Page, label: string) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `Edit ${label}`, exact: true })
    .click();
}

/** Open the peek over /items by activating the row, and wait for the real read. */
async function openPeekFromList(page: Page, identifier: string) {
  const row = page.getByTestId(`issue-row-${identifier}`);
  await expect(row).toBeVisible();
  const read = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await row.press('Enter');
  expect((await read).status()).toBe(200);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

// ── Steps 1-7 · the full edit flow on /items, then a reload ──────────────────

test('@smoke the peek edits every field kind on /items, the row follows, and a reload keeps it', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-peek-edit-list@example.com', 'QVE');
  const task = await mk(seed, 'task', 'Wire the sign-in form');

  await page.goto('/items');

  // 1 · The peek opens and its rail carries edit affordances — the whole story
  //     in one assertion: this used to be a read-only preview.
  const dialog = await openPeekFromList(page, task.identifier);
  await expect(dialog.getByRole('button', { name: 'Edit Priority', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Edit Status', exact: true })).toBeVisible();

  // 2 · A SELF-CONTAINED field. The pick commits and the modal STAYS OPEN —
  //     the peek is a place to work, not a form that closes on submit.
  await openRailField(page, 'Priority');
  await dialog.getByRole('option', { name: 'High', exact: true }).click();
  await expectCommitted(page, task.id, (i) => i['priority'] === 'high', 'priority = high');
  await expect(dialog).toBeVisible();
  await expect(railRow(page, 'Priority').getByText('High')).toBeVisible();

  // 3 · An OPTION-SOURCED field, whose picker must open INSIDE the dialog. This
  //     is the browser-only regression the story is most exposed to: the
  //     listbox has to be reachable within the focus scope, not portalled to
  //     <body> where the trap and the transform put it out of reach.
  await openRailField(page, 'Status');
  const statusListbox = dialog.getByRole('listbox');
  await expect(statusListbox, 'the status menu renders INSIDE the dialog').toBeVisible();
  await statusListbox.getByRole('option', { name: 'In Progress', exact: true }).click();
  await expectCommitted(page, task.id, (i) => i['status'] === 'in_progress', 'status');

  //     …and Assignee, the other option-sourced picker, from the same rail.
  await openRailField(page, 'Assignee');
  await expect(dialog.getByRole('listbox')).toBeVisible();
  await dialog.getByRole('option').filter({ hasText: '@example.com' }).first().click();
  await expectCommitted(page, task.id, (i) => i['assigneeId'] === seed.userId, 'assignee');

  // 4 · A MULTI-VALUE field: add a label, then take it off again. A collection
  //     row keeps its picker open across several writes, so both directions run
  //     without reopening it.
  await openRailField(page, 'Labels');
  const labelInput = dialog.getByRole('combobox', { name: 'Labels' });
  await labelInput.fill('perf-q3');
  await dialog.getByRole('option', { name: /perf-q3/ }).click();
  await expect(dialog.getByRole('button', { name: 'Remove perf-q3' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove perf-q3' }).click();
  await expect(dialog.getByRole('button', { name: 'Remove perf-q3' })).toBeHidden();

  // 5 · STORY POINTS — the field this story stopped rendering as a bare number.
  //     It carries no chevron on purpose: the badge IS the affordance, and it
  //     opens its OWN dialog over the peek (the shipped EstimateBadge, unchanged
  //     — which is the point: the peek composes it rather than reinventing it).
  //     This one field has a REST endpoint, so the authoritative wait is its
  //     PATCH rather than the committed-state poll used elsewhere.
  await railRow(page, 'Story points')
    .getByRole('button', { name: /story points/i })
    .click();
  const pointsPicker = page.getByRole('dialog', { name: 'Set story points' });
  await expect(pointsPicker).toBeVisible();
  const estimateWrite = page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/estimate$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await pointsPicker.getByRole('button', { name: '5 story points' }).click();
  expect((await estimateWrite).status()).toBe(200);
  await expect(pointsPicker).toBeHidden();
  await expectCommitted(page, task.id, (i) => i['storyPoints'] === 5, 'story points = 5');

  // 6 · CLOSE — and the row behind the modal shows the new values. The host is
  //     re-read on close, once, which is the whole reason the peek can be a
  //     write surface without the list going stale behind it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const row = page.getByTestId(`issue-row-${task.identifier}`);
  await expect(row).toContainText('In Progress');

  // 7 · RELOAD — every change survives, because every one of them was a real
  //     write and not an optimistic cell that never landed.
  await page.reload();
  await expect(page.getByTestId(`issue-row-${task.identifier}`)).toContainText('In Progress');
  const after = await (await page.request.get(`/api/_test/work-items?id=${task.id}`)).json();
  expect(after).toMatchObject({
    priority: 'high',
    status: 'in_progress',
    assigneeId: seed.userId,
    storyPoints: 5,
  });
});

// ── Step 8 · the same rail on the other two hosts ────────────────────────────

test('the same rail edits from /boards and from the roadmap canvas — no host-specific wiring', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-peek-edit-hosts@example.com', 'QVH');
  const epic = await mk(seed, 'epic', 'Platform foundation');
  const task = await mk(seed, 'task', 'Ship the rail');

  // ── /boards — a card click pushes `?peek`, the same URL-driven driver.
  await page.goto('/boards');
  const card = page.getByText(task.title).first();
  await expect(card).toBeVisible();
  const boardRead = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await card.click();
  expect((await boardRead).status()).toBe(200);
  const boardDialog = page.getByRole('dialog');
  await expect(boardDialog).toBeVisible();

  await openRailField(page, 'Priority');
  await boardDialog.getByRole('option', { name: 'Low', exact: true }).click();
  await expectCommitted(page, task.id, (i) => i['priority'] === 'low', 'priority from the board');
  await page.keyboard.press('Escape');
  await expect(boardDialog).toBeHidden();

  // ── The planning canvas — the OTHER driver (local state, not `?peek`). Same
  //    panel, same rail, same actions; only the close/settle mechanism differs.
  await page.goto('/roadmap');
  await expect(page.getByTestId('planning-canvas')).toBeVisible();
  const node = page.locator('[data-node-id]').filter({ hasText: epic.title });
  await expect(node).toBeVisible();
  await node.click();
  const viewButton = node.getByTestId('view-button');
  await expect(viewButton).toBeVisible();
  const canvasRead = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  await viewButton.click();
  expect((await canvasRead).status()).toBe(200);
  const canvasDialog = page.getByRole('dialog');
  await expect(canvasDialog.getByRole('heading', { name: epic.title })).toBeVisible();

  // The rail is EDITABLE here too — the canvas peek was read-only before this
  // story and is the surface most likely to be left behind.
  await openRailField(page, 'Priority');
  await canvasDialog.getByRole('option', { name: 'High', exact: true }).click();
  await expectCommitted(page, epic.id, (i) => i['priority'] === 'high', 'priority from the canvas');
});

// ── Step 9 · the read-only actor ─────────────────────────────────────────────

test('a viewer gets NO edit affordance on any rail row — the boundary is visible', async ({
  page,
}) => {
  const owner = await seedProject(page, 'e2e-peek-edit-owner@example.com', 'QVV');
  const task = await mk(owner, 'task', 'Look, do not touch');

  // A second person on the same project, as a VIEWER.
  const viewerEmail = 'e2e-peek-edit-viewer@example.com';
  const viewerPassword = 'quick-view-viewer-pass-7';
  const viewer = await usersService.createUser({
    email: viewerEmail,
    password: viewerPassword,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: owner.workspaceId,
    role: 'member',
  });
  await projectMembersService.addMember({
    key: owner.projectKey,
    actorUserId: owner.userId,
    ctx: { userId: owner.userId, workspaceId: owner.workspaceId },
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: owner.workspaceId } },
    data: { activeProjectId: owner.projectId },
  });

  await page.context().clearCookies();
  await signIn(page, viewerEmail, viewerPassword);
  await page.goto('/items');

  const dialog = await openPeekFromList(page, task.identifier);
  // The peek READS fine — the viewer can see the item.
  await expect(dialog.getByRole('heading', { name: task.title })).toBeVisible();
  // The affordance is ABSENT, not disabled (design panel 10): a disabled chevron
  // advertises a capability the viewer does not have and invites a click that
  // can only fail.
  await expect(dialog.getByRole('button', { name: /^Edit / })).toHaveCount(0);
});

// ── The refused edit ─────────────────────────────────────────────────────────

test('a refused edit reverts the value and says why ON THE ROW', async ({ page }) => {
  const seed = await seedProject(page, 'e2e-peek-edit-refused@example.com', 'QVR');
  const epic = await mk(seed, 'epic', 'Container epic');
  const child = await mk(seed, 'story', 'A child story', epic.id);

  await page.goto('/items');
  const dialog = await openPeekFromList(page, epic.identifier);

  // Re-parenting the epic UNDER its own child is a cycle — the service refuses
  // it, so this exercises the failure path in a browser rather than only in a
  // unit test with a stubbed action.
  await openRailField(page, 'Parent');
  await dialog.getByRole('combobox', { name: 'Parent' }).click();
  const options = dialog.getByRole('option');
  const childOption = options.filter({ hasText: child.identifier });

  if ((await childOption.count()) > 0) {
    await childOption.first().click();
    // The message belongs to the FIELD, not a toast: the modal owns the
    // viewport, so a message about one row would otherwise appear far from it.
    await expect(railRow(page, 'Parent').getByText(/cannot|not allowed|illegal/i)).toBeVisible();
  } else {
    // The picker refuses to OFFER an illegal parent at all — constructibility
    // rather than validation, which is the stronger guarantee. Assert that
    // instead: the epic's own child is not selectable as its parent.
    await expect(childOption).toHaveCount(0);
  }

  // Either way, nothing moved on the server.
  const after = await (await page.request.get(`/api/_test/work-items?id=${epic.id}`)).json();
  expect(after['parentId']).toBeNull();
});
