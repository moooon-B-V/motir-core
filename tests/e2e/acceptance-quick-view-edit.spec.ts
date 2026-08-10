import { expect, type Page } from '@playwright/test';
import { test } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story MOTIR-2560 — the quick view becomes a write surface (Subtask MOTIR-2568).
//
// THE ACCEPTANCE RECEIPT. What this story ships is a change in what a surface
// LETS YOU DO, and that is a thing you judge by watching: does the affordance
// read as an affordance, does the picker open where your eye already is, does
// the change feel like it landed, does the row behind the modal make sense
// afterwards. No test result answers any of that — which is exactly the test
// for a story that earns a recording.
//
// The chapters follow the story's verification recipe in order, and the order
// matters: the read-only actor comes LAST, because you cannot see that an
// affordance is missing until you have watched someone use it.
//
// Nothing is stubbed. A real project, real work items, the real Server Actions.
// The behavioural coverage — three host surfaces, the refused edit, the reload —
// lives in `quick-view-edit.spec.ts`, which runs in the bulk shards; this lane
// records the spine of the flow at a pace a person can follow.

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const VIEWER_EMAIL = 'acceptance-peek-viewer@example.com';
const VIEWER_PASSWORD = 'quick-view-acceptance-pass-7';

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  userId: string;
  workspaceId: string;
}

async function seedProject(page: Page, email: string): Promise<Seed> {
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
    identifier: 'QVA',
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

/** The committed server state, polled — the authoritative signal every chapter
 *  settles on before its hold, so a hold never stands in for a wait. */
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

function railRow(page: Page, label: string) {
  return page
    .getByRole('dialog')
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

async function openRailField(page: Page, label: string) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `Edit ${label}`, exact: true })
    .click();
}

test('acceptance: a work item is edited from the quick view, without ever leaving the list', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2560');

  const seed = await seedProject(page, 'acceptance-peek-owner@example.com');
  const task = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Wire the sign-in form' },
    seed.ctx,
  );

  // The viewer is seeded up front so the last chapter is a sign-in, not a setup.
  const viewer = await usersService.createUser({
    email: VIEWER_EMAIL,
    password: VIEWER_PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: seed.workspaceId,
    role: 'member',
  });
  await projectMembersService.addMember({
    key: seed.projectKey,
    actorUserId: seed.userId,
    ctx: { userId: seed.userId, workspaceId: seed.workspaceId },
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: seed.workspaceId } },
    data: { activeProjectId: seed.projectId },
  });

  const dialog = page.getByRole('dialog');

  await chapter('The list, and the peek that opens over it', async () => {
    await page.goto('/items');
    const row = page.getByTestId(`issue-row-${task.identifier}`);
    await expect(row).toBeVisible();
    await beat();

    const read = page.waitForResponse(
      (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
    );
    await row.press('Enter');
    expect((await read).status()).toBe(200);
    await expect(dialog.getByRole('heading', { name: task.title })).toBeVisible();
    // The rail now carries an edit control on every field it owns — the thing
    // this whole story is: a preview became a place to work.
    await expect(dialog.getByRole('button', { name: 'Edit Priority', exact: true })).toBeVisible();
    await beat();
  });

  await chapter('A field edited in place — the value sticks, the peek stays open', async () => {
    await openRailField(page, 'Priority');
    await beat();
    await dialog.getByRole('option', { name: 'High', exact: true }).click();
    await expectCommitted(page, task.id, (i) => i['priority'] === 'high', 'priority');
    await expect(railRow(page, 'Priority').getByText('High')).toBeVisible();
    // Still open. Editing here does not cost you your place in the list.
    await expect(dialog).toBeVisible();
    await beat();
  });

  await chapter('A picker opens INSIDE the dialog, and the status moves', async () => {
    await openRailField(page, 'Status');
    // The menu renders within the modal's own scope rather than portalled out
    // of reach behind its focus trap — the one thing only a browser can show.
    await expect(dialog.getByRole('listbox')).toBeVisible();
    await beat();
    await dialog
      .getByRole('listbox')
      .getByRole('option', { name: 'In Progress', exact: true })
      .click();
    await expectCommitted(page, task.id, (i) => i['status'] === 'in_progress', 'status');
    await beat();
  });

  await chapter('A label added, then taken off again', async () => {
    await openRailField(page, 'Labels');
    await beat();
    await dialog.getByRole('combobox', { name: 'Labels' }).fill('perf-q3');
    await dialog.getByRole('option', { name: /perf-q3/ }).click();
    await expect(dialog.getByRole('button', { name: 'Remove perf-q3' })).toBeVisible();
    await beat();
    await dialog.getByRole('button', { name: 'Remove perf-q3' }).click();
    await expect(dialog.getByRole('button', { name: 'Remove perf-q3' })).toBeHidden();
    await beat();
  });

  await chapter('Story points, on the same chip the board and backlog use', async () => {
    // The shipped EstimateBadge, composed rather than reinvented — it opens its
    // own deck over the peek, exactly as it does on the backlog and the board.
    await railRow(page, 'Story points')
      .getByRole('button', { name: /story points/i })
      .click();
    const picker = page.getByRole('dialog', { name: 'Set story points' });
    await expect(picker).toBeVisible();
    await beat();
    const write = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/estimate$/.test(r.url()) && r.request().method() === 'PATCH',
    );
    await picker.getByRole('button', { name: '5 story points' }).click();
    expect((await write).status()).toBe(200);
    await expect(picker).toBeHidden();
    await expectCommitted(page, task.id, (i) => i['storyPoints'] === 5, 'story points');
    await beat();
  });

  await chapter('Close — and the row behind it already knows', async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // The surface behind the peek is re-read ON CLOSE, once: the list is not
    // stale, and it did not flicker through five refreshes to get there.
    await expect(page.getByTestId(`issue-row-${task.identifier}`)).toContainText('In Progress');
    await beat();
  });

  await chapter('The same peek, as someone who may only read', async () => {
    await page.context().clearCookies();
    await signIn(page, VIEWER_EMAIL, VIEWER_PASSWORD);
    await page.goto('/items');
    const row = page.getByTestId(`issue-row-${task.identifier}`);
    await expect(row).toBeVisible();
    await row.press('Enter');
    await expect(dialog.getByRole('heading', { name: task.title })).toBeVisible();
    await beat();
    // Every value is here; not one edit control is. Absent, not greyed out — a
    // disabled chevron would advertise a capability this person does not have.
    await expect(railRow(page, 'Priority').getByText('High')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await beat();
  });
});
