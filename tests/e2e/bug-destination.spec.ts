import { expect, test, type Page } from '@playwright/test';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { db } from '@/lib/db';
import { resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';

// Story MOTIR-4927 · Subtask MOTIR-4940 — a person re-points where the project's
// bugs are filed, and the NEXT filed bug lands there: once in a folder, once at
// the project root. The room is reached through the settings rail, so a broken
// access path fails this spec as surely as a broken picker.
//
// ⚠️ THE FILING STEP, AND WHY IT IS NOT AN HTTP CALL. The no-placement filer is
// `aiWorkItemsService.fileBug`, served by `POST /api/internal/ai/work-items`
// behind the `CORE_CALLBACK_SECRET` service bearer. This lane's server holds no
// such secret — it is set in neither `.env`, `playwright.config.ts` nor the CI
// workflows — so that route answers 401 here, and stubbing it would test the
// harness. The spec therefore calls the SAME service method the route delegates
// to, as the system principal the route authenticates to, in the runner process
// against the lane's own database (the way every seed helper here reaches a
// service). Nothing is stubbed: the bug is created by the real filer, and where
// it lands is read back through the real `/items` tree.

const EMAIL = 'e2e-bug-destination@example.com';
const PASSWORD = 'bug-destination-e2e-pass-123';

test.describe.configure({ timeout: 120_000 });

interface Seed {
  projectKey: string;
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Bug destination',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Checkout',
    identifier: 'BUGD',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  return { projectKey: project.identifier };
}

/** File one bug through the real no-placement filer, as the system principal. */
async function fileBug(s: Seed, title: string) {
  const system = await resolveSystemPrincipal();
  return aiWorkItemsService.fileBug({ projectKey: s.projectKey, title }, system);
}

/** Reach the Bugs room the way a person does: the settings area, then its rail. */
async function openBugsRoom(page: Page) {
  await page.goto('/settings/project');
  const rail = page.getByRole('navigation', { name: 'Project settings' });
  await rail.getByRole('link', { name: 'Bugs', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/project\/bugs$/);
  await expect(page.getByRole('heading', { name: 'Bugs', level: 1 })).toBeVisible();
}

// Rooted at the ROLE the card's three choices carry, never at a test id or text on `page`:
// a streamed or outgoing subtree cannot match a role (MOTIR-5037). The folder picker
// and every folder name the card shows render inside the radiogroup.
const card = (page: Page) => page.getByRole('radiogroup', { name: 'Bug destination' });
const choice = (page: Page, name: RegExp) => card(page).getByRole('radio', { name });

/** Arm a wait for the destination PATCH before the click that sends it, then save. */
async function save(page: Page) {
  const write = page.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' &&
      new URL(res.url()).pathname.endsWith('/bug-destination'),
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await write).status()).toBe(200);
}

const tree = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });
const folderRow = (page: Page, name: string) =>
  tree(page).getByRole('row', {
    name: new RegExp(`folder ${name} ${name} Folder actions for ${name}$`),
  });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a person re-points the Bugs destination to a folder and to Project root, and the next filed bug lands there', async ({
  page,
}) => {
  const s = await seed();
  await signIn(page, EMAIL, PASSWORD);

  // 1–2 · The room, reached through the rail, reads the seeded Bugs folder.
  await openBugsRoom(page);
  await expect(choice(page, /This project's Bugs folder/)).toHaveAttribute('aria-checked', 'true');
  await expect(card(page).getByText('Bugs', { exact: true })).toBeVisible();

  // 3 · A second folder made in /items, picked in the room, and still picked after a reload.
  await page.goto('/items');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const nameField = page.getByRole('textbox', { name: 'Folder name', exact: true });
  await nameField.fill('Triage');
  const create = actionWrite(page, '/items', 'Triage');
  await nameField.press('Enter');
  expect((await create).status()).toBe(200);
  await expect(folderRow(page, 'Triage')).toBeVisible();
  const triageId = ((await folderRow(page, 'Triage').getAttribute('data-testid')) ?? '').replace(
    'folder-row-',
    '',
  );
  expect(triageId).not.toBe('');

  await openBugsRoom(page);
  await choice(page, /Another folder/).click();
  await card(page).getByRole('option', { name: 'Triage', exact: true }).click();
  await save(page);
  await page.reload();
  await expect(choice(page, /Another folder/)).toHaveAttribute('aria-checked', 'true');
  await expect(card(page).getByText('Triage', { exact: true })).toBeVisible();

  // 4 · The next filed bug sits INSIDE Triage in the /items tree.
  const inFolder = await fileBug(s, 'Checkout crashes on an empty cart');
  await page.goto('/items');
  const expand = actionWrite(page, '/items', triageId);
  await page.getByRole('button', { name: 'Expand folder Triage', exact: true }).click();
  expect((await expand).status()).toBe(200);
  const inFolderRow = tree(page).getByTestId(`issue-row-${inFolder.identifier}`);
  await expect(inFolderRow).toBeVisible();
  await expect(inFolderRow).toHaveAttribute('aria-level', '2');

  // 5 · Project root, chosen and saved, reads as a NAMED choice after a reload.
  await openBugsRoom(page);
  await choice(page, /Project root/).click();
  await save(page);
  await page.reload();
  await expect(choice(page, /Project root/)).toHaveAttribute('aria-checked', 'true');
  await expect(card(page).getByText('Project root', { exact: true })).toBeVisible();

  // 6 · The next filed bug renders at the root of the tree, in no folder.
  const atRoot = await fileBug(s, 'Payment form loses its state');
  await page.goto('/items');
  const atRootRow = tree(page).getByTestId(`issue-row-${atRoot.identifier}`);
  await expect(atRootRow).toBeVisible();
  await expect(atRootRow).toHaveAttribute('aria-level', '1');
});
