import { expect, test } from '@playwright/test';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { seedProjectAccess, type ProjectAccessSeed } from './_helpers/project-access-seed';
import {
  acceptInvite,
  addPerson,
  editTitle,
  expectNotFound,
  expectPalette,
  expectSwitcher,
  inviteLimited,
  makeMembersOnly,
  signInAs,
  switchProject,
} from './_helpers/project-access-flows';
import { projectMembersService } from '@/lib/services/projectMembersService';

// ACCESS LIVES ON THE PROJECT — the browser walk (Story MOTIR-6169 · Subtask
// MOTIR-6553), in the main e2e lane. The recipe's four steps, unpaced, then the
// states the recorded receipt (`acceptance-project-access.spec.ts`) leaves out:
//
//   1. A Manager invites a contractor as a Limited member into Atlas; the
//      contractor accepts.
//   2. The contractor's switcher and ⌘K list only Atlas; Borealis's address is
//      not-found; an edit to Atlas's item saves.
//   3. The Manager makes Cobalt Members only — the confirm lists the Full members
//      who lose access — and adds one person back.
//   4. A Full member who was not added no longer finds Cobalt: not in the
//      switcher, not in ⌘K, and its item's address is not-found.
//
// ⚠️ The ⌘K palette searches ACTIONS, not work items, so "a palette search for a
// Cobalt item returns nothing" would pass on any palette. Step 4 asserts the two
// things a person could actually reach Cobalt by: the palette's switch-to row,
// and the item's own address.
//
// Every wait is on an authoritative signal (the write's response, the committed
// row); see `_helpers/project-access-flows.ts`.

test.describe.configure({ timeout: 180_000 });

let seed: ProjectAccessSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedProjectAccess(`pa${Date.now().toString(36)}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a Limited contractor sees only their project; a project switched to Members only disappears for a Full member not added', async ({
  page,
}) => {
  // ── 1 · invite + accept ─────────────────────────────────────────────────
  await signInAs(page, seed.manager.email);
  const token = await inviteLimited(page, seed, seed.atlas.name);

  await signInAs(page, seed.contractor.email);
  await acceptInvite(page, token);
  const membership = await adminDb.workspaceMembership.findUniqueOrThrow({
    where: {
      userId_workspaceId: { userId: seed.contractor.id, workspaceId: seed.workspaceId },
    },
  });
  expect(membership.accessScope).toBe('limited');

  // ── 2 · the contractor's world is Atlas ───────────────────────────────────
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(seed.atlas.name);
  await expectSwitcher(page, [seed.atlas.name], [seed.borealis.name, seed.cobalt.name]);
  await expectPalette(page, '', [seed.atlas.name], [seed.borealis.name, seed.cobalt.name]);
  await expectNotFound(page, `/items/${seed.borealis.itemKey}`);
  const atlasItem = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.atlas.id },
  });
  await editTitle(page, seed.atlas.itemKey, atlasItem.id, 'Draft the atlas intro — v2');
  await page.goto(`/items/${seed.atlas.itemKey}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft the atlas intro — v2');

  // ── 3 · Cobalt goes Members only ──────────────────────────────────────────
  await signInAs(page, seed.manager.email);
  await switchProject(page, seed.cobalt.name);
  await makeMembersOnly(page, seed.cobalt.name, [seed.fran.name, seed.kai.name]);
  await addPerson(page, seed.kai.name);

  // ── 4 · Fran, Full and not added, has lost it ─────────────────────────────
  await signInAs(page, seed.fran.email);
  await expectSwitcher(page, [seed.atlas.name, seed.borealis.name], [seed.cobalt.name]);
  await expectPalette(page, seed.cobalt.name, [], [seed.cobalt.name]);
  await expectNotFound(page, `/items/${seed.cobalt.itemKey}`);
});

test.describe('the states the receipt leaves out', () => {
  test('a Limited member added to NO project lands in the no-project shell', async ({ page }) => {
    await signInAs(page, seed.nia.email, 'no-project');
    await expect(
      page.getByRole('main').getByText('A Manager of Northwind can add you to a project.', {
        exact: false,
      }),
    ).toBeVisible();
    // No create door: a Limited member could not enter what they made.
    await expect(page.getByRole('button', { name: 'Create a project' })).toHaveCount(0);
    // Every project-scoped route lands here too, and the bar offers no Create.
    await page.goto('/items');
    await expect(page).toHaveURL(/\/no-project$/);
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  });

  test('a Member opening project settings finds no mode control', async ({ page }) => {
    await signInAs(page, seed.fran.email);
    await page.goto('/settings/project/members');
    await expect(page.getByRole('radiogroup', { name: 'Project access mode' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^Members only/ })).toHaveCount(0);
  });

  test('the Members-only confirm says so when nobody loses access', async ({ page }) => {
    const ctx = {
      userId: (await adminDb.user.findUniqueOrThrow({ where: { email: seed.manager.email } })).id,
      workspaceId: seed.workspaceId,
    };
    for (const email of [seed.fran.email, seed.kai.email]) {
      const u = await adminDb.user.findUniqueOrThrow({ where: { email } });
      await projectMembersService.addMember({
        key: seed.atlas.key,
        actorUserId: ctx.userId,
        ctx,
        targetUserId: u.id,
      });
    }
    await signInAs(page, seed.manager.email);
    await makeMembersOnly(page, seed.atlas.name, []);
  });

  test('a failed save leaves the mode and names the one the project is still in', async ({
    page,
  }) => {
    await signInAs(page, seed.manager.email);
    // Workspace → Members only goes through the preview; the DIRECT write is the
    // way back, so move to Members only for real first, then fail the return.
    await makeMembersOnly(page, seed.atlas.name, [seed.fran.name, seed.kai.name]);
    await page.route('**/api/projects/*/access', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, body: '{"code":"INTERNAL"}' })
        : route.continue(),
    );
    const failed = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/access') && r.request().method() === 'PATCH',
    );
    await page.getByRole('radio', { name: /^Open to the workspace/ }).click();
    expect((await failed).status()).toBe(500);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Atlas is still Members only. Please try again.' })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('radio', { name: /^Members only/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
