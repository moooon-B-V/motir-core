import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// TIDY A PROJECT INTO FOLDERS — THE ACCEPTANCE RECEIPT (Story MOTIR-5308 ·
// Subtask MOTIR-5318). The story's verification recipe, in a real browser
// against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's promise is that tidying the tree changes nothing about the work.
// So the clip's centre of gravity is two moments a person would doubt: filing
// an epic away takes its stories WITH it, and deleting a folder loses nothing —
// its contents come back to the root — and the board and the backlog afterwards
// still show every work item.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// Every folder write, filing and lazy level read is a Server Action: a POST to
// `/items` told apart only by its body (`authoritative-signal.ts`). Each wait is
// armed BEFORE its click, with a marker only that request carries — the folder's
// name on a create or rename, the work item's or folder's id on a filing, a
// level read or a delete — and its status is asserted before the next step.
//
// The rules and invariants behind each step are proven below the browser, in
// tests/integration/folders/storyGate.test.ts (MOTIR-5317). This spec proves the
// journey.

const PASSWORD = 'acceptance-folders-e2e-pass-123';

interface Seed {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
}

async function seedProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Olivia Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Folders Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Sign-in revamp',
    identifier,
  });
  // Pinned active through the product's own write, so `/items` resolves it.
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
  };
}

async function workItem(
  seed: Seed,
  kind: 'epic' | 'story' | 'bug' | 'task',
  title: string,
  parentId?: string,
) {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/** The live tree — rooted at its role, so a streamed copy can never match. */
const treeOf = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });

test('a person tidies a project into folders, and the work is untouched', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5308');

  await resetDatabase();
  const seed = await seedProject('acceptance-folders@example.com', 'TIDY');
  const epic = await workItem(seed, 'epic', 'Sign-in overhaul');
  const storyOne = await workItem(seed, 'story', 'Email sign-in', epic.id);
  const storyTwo = await workItem(seed, 'story', 'Password reset', epic.id);
  const bug = await workItem(seed, 'bug', 'Sign-in button misaligned');
  const seeded = [epic, storyOne, storyTwo, bug];

  await signIn(page, 'acceptance-folders@example.com', PASSWORD);

  const tree = treeOf(page);
  const row = (identifier: string) => tree.getByTestId(`issue-row-${identifier}`);
  // A folder row's accessible name ends with its name and its menu's label —
  // "… folder Later Later Folder actions for Later" — whether it is expanded
  // or collapsed, so it names exactly one row.
  const folderRow = (name: string) =>
    tree.getByRole('row', {
      name: new RegExp(`folder ${name} ${name} Folder actions for ${name}$`),
    });
  const folderIdOf = async (name: string) =>
    ((await folderRow(name).getAttribute('data-testid')) ?? '').replace('folder-row-', '');
  const nameField = page.getByRole('textbox', { name: 'Folder name', exact: true });
  const menuOf = (name: string) =>
    page.getByRole('button', { name: `Folder actions for ${name}`, exact: true });

  /** Expand or collapse a folder; a first expand is a lazy level read, and waited on. */
  async function toggleFolder(name: string, to: 'Expand' | 'Collapse', loads = false) {
    const id = await folderIdOf(name);
    const read = loads ? actionWrite(page, '/items', id) : null;
    await page.getByRole('button', { name: `${to} folder ${name}`, exact: true }).click();
    if (read) expect((await read).status()).toBe(200);
    await expect(folderRow(name)).toHaveAttribute(
      'aria-expanded',
      to === 'Expand' ? 'true' : 'false',
    );
  }

  /** File a work item from its quick view, through the rail's Folder field. */
  async function fileFromQuickView(item: { id: string; identifier: string }, option: string) {
    await row(item.identifier).press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit Folder', exact: true }).click();
    const folders = dialog.getByRole('listbox', { name: 'Folders' });
    const write = actionWrite(page, '/items', item.id);
    await folders.getByRole('option', { name: option, exact: true }).click();
    expect((await write).status()).toBe(200);
    return dialog;
  }

  await chapter('Create a folder Later, and 2025 inside it', async () => {
    await page.goto('/items');
    await expect(row(epic.identifier)).toBeVisible();
    await expect(row(bug.identifier)).toBeVisible();

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await nameField.fill('Later');
    const createLater = actionWrite(page, '/items', 'Later');
    await nameField.press('Enter');
    expect((await createLater).status()).toBe(200);
    await expect(folderRow('Later')).toHaveAttribute('aria-level', '1');

    await menuOf('Later').click();
    await page.getByRole('menuitem', { name: 'New folder inside', exact: true }).click();
    await nameField.fill('2025');
    const create2025 = actionWrite(page, '/items', '2025');
    await nameField.press('Enter');
    expect((await create2025).status()).toBe(200);
    await expect(folderRow('2025')).toHaveAttribute('aria-level', '2');
  });

  await chapter('An empty folder says nothing is filed there yet', async () => {
    await toggleFolder('2025', 'Expand', true);
    await expect(tree.getByText('Nothing is filed here yet.', { exact: true })).toBeVisible();
    await beat();
    await toggleFolder('2025', 'Collapse');
  });

  await chapter('File the epic into Later ▸ 2025 from its quick view', async () => {
    const dialog = await fileFromQuickView(epic, '2025');
    await expect(dialog.getByText('Later ▸ 2025', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // It left the root, and it is in 2025 with both of its stories. 2025's level
    // was read in the chapter before, so re-opening it reads nothing: the filing
    // placed the epic into that loaded level in place (MOTIR-5353).
    await expect(row(epic.identifier)).toHaveCount(0);
    await toggleFolder('2025', 'Expand');
    await expect(row(epic.identifier)).toHaveAttribute('aria-level', '3');
    const children = actionWrite(page, '/items', epic.id);
    await row(epic.identifier).press('ArrowRight');
    expect((await children).status()).toBe(200);
    await expect(row(storyOne.identifier)).toHaveAttribute('aria-level', '4');
    await expect(row(storyTwo.identifier)).toHaveAttribute('aria-level', '4');
    await beat();
  });

  await chapter('File the bug into Later the same way', async () => {
    const dialog = await fileFromQuickView(bug, 'Later');
    await expect(dialog.getByText('Later', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(row(bug.identifier)).toHaveAttribute('aria-level', '2');
  });

  await chapter('Collapse and expand both folders', async () => {
    await toggleFolder('2025', 'Collapse');
    await expect(row(epic.identifier)).toHaveCount(0);
    await toggleFolder('Later', 'Collapse');
    await expect(folderRow('2025')).toHaveCount(0);
    await expect(row(bug.identifier)).toHaveCount(0);

    await toggleFolder('Later', 'Expand');
    await expect(folderRow('2025')).toBeVisible();
    await expect(row(bug.identifier)).toBeVisible();
    await toggleFolder('2025', 'Expand');
    await expect(row(epic.identifier)).toBeVisible();
  });

  await chapter('Rename Later to Parked — and a second “parked” is refused', async () => {
    await menuOf('Later').click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await nameField.fill('Parked');
    const rename = actionWrite(page, '/items', 'Parked');
    await nameField.press('Enter');
    expect((await rename).status()).toBe(200);
    await expect(folderRow('Parked')).toHaveAttribute('aria-level', '1');
    await expect(folderRow('Later')).toHaveCount(0);

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await nameField.fill('parked');
    const duplicate = actionWrite(page, '/items', 'parked');
    await nameField.press('Enter');
    expect((await duplicate).status()).toBe(200);
    // In the draft row itself — scoped to the tree, past Next's (empty) route
    // announcer, which is also an alert.
    await expect(tree.getByRole('alert')).toHaveText('A folder named “parked” is already here.');
    await beat();
    await nameField.press('Escape');
    await expect(nameField).toBeHidden();
  });

  await chapter('Delete Parked — what it held moves up, and nothing is deleted', async () => {
    const parkedId = await folderIdOf('Parked');
    await menuOf('Parked').click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete folder “Parked”?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('1 folder and 1 work item will move to');
    await expect(confirm).toContainText('No work items are deleted.');
    await beat();

    const remove = actionWrite(page, '/items', parkedId);
    await confirm.getByRole('button', { name: 'Delete folder', exact: true }).click();
    expect((await remove).status()).toBe(200);
    await expect(confirm).toBeHidden();

    await expect(folderRow('Parked')).toHaveCount(0);
    await expect(folderRow('2025')).toHaveAttribute('aria-level', '1');
    await expect(row(bug.identifier)).toHaveAttribute('aria-level', '1');
  });

  await chapter('The board and the backlog still show every work item', async () => {
    await page.goto('/boards');
    const board = page.getByRole('main');
    for (const item of seeded) {
      await expect(board.getByTestId(`board-card-${item.identifier}`)).toBeVisible();
    }
    await beat();

    await page.goto('/backlog');
    const backlog = page.getByRole('list', { name: 'Backlog work items' });
    for (const item of seeded) {
      await expect(backlog.getByTestId(`backlog-row-${item.identifier}`)).toBeVisible();
    }
  });
});

test('a viewer without work_item:edit sees folders but cannot change them', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject('acceptance-folders-owner@example.com', 'VIEW');
  const task = await workItem(seed, 'task', 'Filed task');
  const later = await foldersService.createFolder(
    { projectId: seed.projectId, parentFolderId: null, name: 'Later' },
    seed.ctx,
  );
  await foldersService.fileWorkItem(task.id, { folderId: later.id }, seed.ctx);

  const viewer = await usersService.createUser({
    email: 'acceptance-folders-viewer@example.com',
    password: PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: seed.workspaceId });
  // Granted by the owner through the product's own member write.
  await addToProjectAs({
    key: seed.projectIdentifier,
    actorUserId: seed.ctx.userId,
    ctx: seed.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectsService.setActiveProject({
    userId: viewer.id,
    workspaceId: seed.workspaceId,
    projectId: seed.projectId,
  });

  await signIn(page, 'acceptance-folders-viewer@example.com', PASSWORD);
  await page.goto('/items');

  const tree = treeOf(page);
  await expect(tree.getByTestId(`folder-row-${later.id}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Folder actions for Later', exact: true }),
  ).toHaveCount(0);
});
