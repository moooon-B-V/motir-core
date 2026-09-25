import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { createTestPerson } from './_helpers/testPerson';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { adminDb } from '../helpers/adminDb';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';

// THE ORGANIZATION'S THREE ROLES — THE ACCEPTANCE RECEIPT
// (Story MOTIR-6167 · Subtask MOTIR-6316).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One organization, three people, and the org's powers landing on exactly the
// person each role says they belong to:
//
//   Olive — the Owner at the start; hands the organization over, and is an
//           Admin from then on.
//   Ada   — an Admin at the start; the Owner after the transfer.
//   Mo    — a plain Member throughout.
//
// The walk is the story's own Verification section, in its order. The part a
// reader should NOT skip is the second half: the transfer is easy to show
// working, and the proof that it MEANT something is what each person can and
// cannot do afterwards — Olive running workspaces as an Admin, Mo finding no org
// doors at all, and Ada editing inside a project in a workspace she never
// joined.
//
// ── ⚠️ ABSENCE IS ASSERTED WITH THE LOCATOR THAT WOULD FIND THE CONTROL ──────
//
// Every "is not offered" below uses the SAME locator a positive assertion uses
// elsewhere in this file (the danger zone's heading, the Workspaces card's
// heading, the `New workspace` button), so a regression that rendered the
// control would fail here rather than slip past a looser selector.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// Seven chapters, each ending on a held result. Every hold is taken AFTER its
// authoritative signal (a write's response, a server-refreshed heading), per
// `CLAUDE.md` § E2E — a hold never stands in for a wait.

const OLIVE = 'acceptance-org-roles-olive@example.com';
const ADA = 'acceptance-org-roles-ada@example.com';
const MO = 'acceptance-org-roles-mo@example.com';
const ORG_NAME = 'Northwind';
const SECRET_TITLE = 'Draft the launch plan';
const EDITED_TITLE = 'Draft the launch plan — owner pass';

interface Tenant {
  organizationId: string;
  homeWorkspaceId: string;
  platformWorkspaceId: string;
  oliveId: string;
  adaId: string;
  secretItemKey: string;
  secretItemId: string;
}

/**
 * Olive signs up (the org, its first workspace and her Owner row come from the
 * real sign-up path); Ada and Mo are seeded as an Admin and a Member of the
 * same org with a membership in the home workspace, so each has somewhere to
 * land. A second workspace, `Platform`, is created by Olive — so Ada is NOT a
 * member of it — and holds a PRIVATE project with one work item: the room the
 * Owner's reach is proven in (step 5).
 */
async function seedTenant(page: Page): Promise<Tenant> {
  await signUp(page, OLIVE);
  const olive = await adminDb.user.findFirstOrThrow({ where: { email: OLIVE } });
  const home = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${OLIVE.split('@')[0]!}'s Workspace` },
  });
  const organizationId = home.organizationId;
  // ⚠️ THE FREE PLAN CAPS AN ORGANIZATION AT ONE WORKSPACE, and this lane is
  // cloud-on — the same trap and the same one-field remedy as
  // `acceptance-repository-tenancy.spec.ts`: a paid AI plan bundles a seat,
  // which resolves the org to the uncapped `scaled` tier.
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { name: ORG_NAME, aiIncludedSeat: true },
  });

  const ada = await createTestPerson({ email: ADA, password: SHELL_PASSWORD, name: 'Ada' });
  const mo = await createTestPerson({ email: MO, password: SHELL_PASSWORD, name: 'Mo' });
  await adminDb.organizationMembership.create({
    data: { organizationId, userId: ada.id, role: ORGANIZATION_ROLE.admin },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId, userId: mo.id, role: ORGANIZATION_ROLE.member },
  });
  await workspacesService.addMember({ userId: ada.id, workspaceId: home.id });
  await workspacesService.addMember({ userId: mo.id, workspaceId: home.id });

  const { workspace: platform } = await workspacesService.createWorkspace({
    name: 'Platform',
    ownerUserId: olive.id,
    organizationId,
  });
  const project = await projectsService.createProject({
    workspaceId: platform.id,
    actorUserId: olive.id,
    name: 'Secret roadmap',
    identifier: 'SEC',
  });
  await adminDb.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: SECRET_TITLE },
    { userId: olive.id, workspaceId: platform.id },
  );

  return {
    organizationId,
    homeWorkspaceId: home.id,
    platformWorkspaceId: platform.id,
    oliveId: olive.id,
    adaId: ada.id,
    secretItemKey: item.identifier,
    secretItemId: item.id,
  };
}

async function signInAt(page: Page, email: string, t: Tenant, workspaceId: string) {
  await signIn(page, email, SHELL_PASSWORD);
  await pinContextCookies(page, { workspaceId, organizationId: t.organizationId });
}

function dangerZone(page: Page) {
  return page.getByRole('heading', { name: 'Danger zone', exact: true });
}

async function ownerOf(organizationId: string): Promise<string[]> {
  const rows = await adminDb.organizationMembership.findMany({
    where: { organizationId, role: ORGANIZATION_ROLE.owner },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

test('an Owner hands the organization over; each role then holds exactly its own powers', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // Seven chapters across three sign-ins each way; the lane's 90 s default is
  // sized for a one-actor walk.
  test.setTimeout(300_000);
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6167');

  await resetDatabase();
  const t = await seedTenant(page);

  await chapter(
    'The Owner sees the danger zone — Transfer ownership live, Delete disabled',
    async () => {
      await pinContextCookies(page, {
        workspaceId: t.homeWorkspaceId,
        organizationId: t.organizationId,
      });
      await page.goto('/settings/organization');
      await expect(dangerZone(page)).toBeVisible();
      await expect(
        page.getByRole('main').getByText('You’re the owner', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Transfer ownership…' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Delete organization' })).toBeDisabled();
      await beat();
    },
  );

  await chapter('A wrong organization name cannot be confirmed, and changes nothing', async () => {
    await page.getByRole('button', { name: 'Transfer ownership…' }).click();
    const dialog = page.getByRole('dialog', { name: `Transfer ownership of ${ORG_NAME}` });
    await expect(dialog).toBeVisible();
    // The Owner is never offered to themselves; Ada and Mo are.
    const picker = dialog.getByRole('radiogroup', { name: 'New owner' });
    await expect(picker.getByRole('radio')).toHaveCount(2);
    await picker.getByText('Ada', { exact: true }).click();
    await expect(
      dialog.getByText('Ada becomes the Owner. You become an Admin.', { exact: true }),
    ).toBeVisible();
    await dialog.getByLabel(`Type ${ORG_NAME} to confirm`).fill('Northwnd');
    // The server checks the typed name too (MOTIR-6310); the dialog refuses to
    // send a mismatch at all, which is the error state a person meets.
    await expect(
      dialog.getByRole('button', { name: 'Transfer ownership', exact: true }),
    ).toBeDisabled();
    expect(await ownerOf(t.organizationId)).toEqual([t.oliveId]);
    await beat();
  });

  await chapter('The transfer — Ada becomes the Owner, and Olive an Admin', async () => {
    const dialog = page.getByRole('dialog', { name: `Transfer ownership of ${ORG_NAME}` });
    await dialog.getByLabel(`Type ${ORG_NAME} to confirm`).fill(ORG_NAME);
    const transferred = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/organizations/${t.organizationId}/ownership-transfer`) &&
        r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    expect((await transferred).status()).toBe(200);
    expect(await ownerOf(t.organizationId)).toEqual([t.adaId]);

    // The page redraws as the new Admin's view: the danger zone is gone.
    await expect(
      page.getByRole('main').getByText('You’re an admin', { exact: true }),
    ).toBeVisible();
    await expect(dangerZone(page)).toHaveCount(0);
    await beat();

    // The roster agrees: Ada is the Owner, Olive an Admin, and the Owner's row
    // carries no role picker for anyone.
    await page.goto('/settings/organization/members');
    await expect(
      page.getByRole('main').getByText('Ownership moves only by transfer', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Organization role for Ada' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Organization role for Mo' })).toBeVisible();
    await beat();
  });

  await chapter('As an Admin, Olive creates a workspace and removes it', async () => {
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New workspace', exact: true }).first().click();
    const create = page.getByRole('dialog', { name: 'New workspace' });
    await create.getByLabel('Workspace name').fill('Scratch');
    const created = actionWrite(page, '/settings/organization', 'Scratch');
    await create.getByRole('button', { name: 'New workspace', exact: true }).click();
    expect((await created).status()).toBe(200);
    // Scoped to the page body: creating a workspace also switches into it, so the
    // header's workspace and project switchers (outside `main`) read 'Scratch' too.
    await expect(page.getByRole('main').getByText('Scratch', { exact: true })).toBeVisible();
    await beat();

    await page.getByRole('button', { name: 'Remove Scratch' }).click();
    const remove = page.getByRole('dialog', { name: 'Remove Scratch?' });
    await remove.getByLabel('Type Scratch to confirm').fill('Scratch');
    const removed = page.waitForResponse(
      (r) =>
        /\/api\/organizations\/[^/]+\/workspaces\/[^/]+$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'DELETE',
    );
    await remove.getByRole('button', { name: 'Remove workspace' }).click();
    expect((await removed).status()).toBe(200);
    await expect(
      page
        .getByRole('region', { name: /^Notifications/ })
        .getByText('Scratch removed', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Scratch', { exact: true })).toHaveCount(0);
    await beat();
  });

  await chapter('Mo, a Member, finds no organization doors at all', async () => {
    await signInAt(page, MO, t, t.homeWorkspaceId);
    await page.goto('/workbench');
    await expect(page.getByRole('main').getByTestId('workbench-page')).toBeVisible();
    // The create doors: none, in the org menu or the switcher.
    await expect(page.getByRole('button', { name: /New workspace/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Create workspace/ })).toHaveCount(0);
    await beat();

    // The org settings page holds ONLY what is his: Mo is in one of the org's
    // two workspaces, so the page folds that workspace's own sections in
    // (`organization-tier.md` §6d — relocating a surface keeps its gate), and
    // every ORG-scoped card is absent. The workspace fold-in is the positive
    // control: the page rendered, and what is missing is missing by role.
    await page.goto('/settings/organization');
    await expect(
      page.getByRole('heading', { name: 'Workspace configuration', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Transfer ownership…' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete organization' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Delete workspace/ })).toHaveCount(0);
    await expect(
      page.getByRole('main').getByText('Leave workspace', { exact: true }),
    ).toBeVisible();

    // The rail: the Organisation row alone — no Git, Members, Security, Usage
    // or Billing row. Same navigation, same link role, as the row that IS there.
    const rail = page.getByRole('navigation', { name: 'Organisation settings' });
    await expect(rail.getByRole('link', { name: 'Organisation', exact: true })).toBeVisible();
    for (const row of ['Git', 'Members', 'Security', 'Usage', 'Billing']) {
      await expect(rail.getByRole('link', { name: row, exact: true })).toHaveCount(0);
    }
    await beat();

    // …and the Git inventory, opened by URL, answers with the forbidden state.
    await page.goto('/settings/organization/git');
    await expect(
      page.getByRole('heading', { name: 'Organization settings are admin-only', exact: true }),
    ).toBeVisible();
    await beat();
  });

  await chapter('Ada, now the Owner, edits inside a workspace she never joined', async () => {
    // Ada holds no membership in `Platform`, and the project is private.
    expect(
      await adminDb.workspaceMembership.count({
        where: { userId: t.adaId, workspaceId: t.platformWorkspaceId },
      }),
    ).toBe(0);
    await signInAt(page, ADA, t, t.platformWorkspaceId);
    await page.goto(`/items/${t.secretItemKey}`);
    await expect(page.getByRole('heading', { level: 1, name: SECRET_TITLE })).toBeVisible();
    await beat();

    await page.goto(`/items/${t.secretItemKey}/edit`);
    await page.getByRole('textbox', { name: 'Title' }).fill(EDITED_TITLE);
    const saved = actionWrite(page, `/items/${t.secretItemKey}/edit`, t.secretItemId);
    await page.getByRole('button', { name: 'Save' }).click();
    expect((await saved).status()).toBe(200);
    await expect
      .poll(
        async () =>
          (await adminDb.workItem.findUniqueOrThrow({ where: { id: t.secretItemId } })).title,
      )
      .toBe(EDITED_TITLE);
    await page.goto(`/items/${t.secretItemKey}`);
    await expect(page.getByRole('heading', { level: 1, name: EDITED_TITLE })).toBeVisible();
    await beat();
  });

  await chapter('Account deletion: Olive is free to leave; Ada is sent to transfer', async () => {
    // Olive owns nothing now, so this organization no longer blocks her.
    await signInAt(page, OLIVE, t, t.homeWorkspaceId);
    await page.goto('/settings/account/data');
    await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
    await expect(page.getByText('Action needed', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Transfer ownership' })).toHaveCount(0);
    await beat();

    // Ada owns an organization other people belong to: the pane names it and
    // offers the one way out, which opens the transfer dialog on that org.
    await signInAt(page, ADA, t, t.homeWorkspaceId);
    await page.goto('/settings/account/data');
    await expect(page.getByRole('main').getByText('Action needed', { exact: true })).toBeVisible();
    // The blocking org's row: its size and Ada's role in it.
    await expect(
      page.getByRole('main').getByText('3 members · you are the owner', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Transfer ownership' }).click();
    await page.waitForURL('**/settings/organization?**');
    await expect(
      page.getByRole('dialog', { name: `Transfer ownership of ${ORG_NAME}` }),
    ).toBeVisible();
    await beat();
  });
});
