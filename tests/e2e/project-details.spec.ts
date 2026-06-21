// E2E: the editable project Details page + the change-key journey (Story 6.8 ·
// Subtask 6.8.5) — the story-closing recipe driven end-to-end over the real
// stack. It exercises the verification recipe the Story was built to satisfy:
//
//   1. RENAME the project on the Details page → the save bar reports "Saved" and
//      the project SWITCHER reflects the new name;
//   2. set an AVATAR (preset icon + colour) → it round-trips through save (the
//      picker re-opens with the same selection) and the switcher chip stops
//      showing the mono key-letters;
//   3. CHANGE THE KEY PROD → NIF through the guarded modal — the consequence copy
//      is spelled out verbatim ("every issue identifier becomes NIF-…", "old PROD
//      links keep working"); after confirm the Details key + Previous-keys row
//      update;
//   4. an OLD issue link `/items/PROD-1` 308-redirects to `/items/NIF-1` (the
//      canonical URL lands in the bar);
//   5. REVERT (reclaim the own previous key) NIF → PROD — Previous-keys now lists
//      NIF and old NIF links redirect to PROD;
//   6. a NON-ADMIN member sees the values but NONE of the editing controls;
//   7. a11y: a strict axe sweep over the Details page, the open avatar picker, the
//      change-key modal, and the release-key confirm.
//
// The exhaustive rename-tx / collision / resolution MATRICES are proven at the
// integration tier (project-details-service / project-alias-resolution /
// project-details-journey) — this spec does NOT re-assert them; it drives the
// user-visible journey through the browser.
//
// Tenant setup follows the settings-area / project-access precedent: a multi-user
// one-workspace scenario can't be reached through the sign-up UI (each sign-up
// mints its own workspace), so personas are seeded through the shipped services
// and the active-project pin uses the test-sanctioned direct DB reach.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkspaceContext } from '@/lib/workspaces/context';

const PWD = 'project-details-e2e-pass-123';
const PROJECT_NAME = 'Details E2E';
const PROJECT_KEY = 'PROD';

// WCAG 2.1 Level A + AA — the same ruleset the shell + settings-area sweeps name.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerEmail: string;
  ownerCtx: WorkspaceContext;
}

async function makeUser(email: string, name: string): Promise<{ id: string; email: string }> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email };
}

async function pinActiveProject(userId: string, t: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
    data: { activeProjectId: t.projectId },
  });
}

// Owner + workspace + one project keyed PROD, owner pinned active, plus two seeded
// issues (PROD-1, PROD-2) so the rename re-keys real rows and the redirect has a
// concrete target.
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olivia Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Details Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  const tenant: Tenant = { workspaceId: workspace.id, projectId: project.id, ownerEmail, ownerCtx };
  for (const title of ['First issue', 'Second issue']) {
    await workItemsService.createWorkItem({ projectId: project.id, kind: 'task', title }, ownerCtx);
  }
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

function switcher(page: Page) {
  return page.getByRole('button', { name: 'Switch project' });
}

test.describe('project-details — the editable Details + change-key journey', () => {
  // Multiple argon2 sign-ins + several router.refresh round-trips per test.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke rename + avatar → switcher updates; change key PROD→NIF → old links redirect; reclaim restores PROD', async ({
    page,
  }) => {
    const tenant = await seedTenant('pd-owner-1@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    // ── Land on the editable Details page (admin) ────────────────────────────
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    await expect(page.getByText('Admin', { exact: true })).toBeVisible();

    // ── 1. Rename → Saved → the switcher reflects the new name ───────────────
    const nameInput = page.getByRole('textbox', { name: 'Name' });
    const saveButton = page.getByRole('button', { name: 'Save changes' });
    await nameInput.fill('Details E2E Renamed');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    // Wait for the "Saved" status — it appears only after the action RESOLVES ok
    // (justSaved=true) and router.refresh() fires, so the write is committed before
    // we navigate. (The button is also disabled DURING the in-flight transition, so
    // toBeDisabled would race ahead of the commit — don't use it as the signal.)
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.goto('/items');
    await expect(switcher(page)).toContainText('Details E2E Renamed');
    // No avatar yet → the mono key-letters chip ("PR") is present in the trigger.
    await expect(switcher(page).getByText('PR', { exact: true })).toBeVisible();

    // ── 2. Avatar: pick a preset icon + colour, save, and prove it round-trips ─
    await page.goto('/settings/project');
    await page.getByRole('button', { name: 'Change avatar' }).click();
    await page.getByRole('radio', { name: 'rocket' }).click();
    await page.getByRole('radio', { name: 'lavender' }).click();
    await page.keyboard.press('Escape'); // close the popover; selection is staged
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // Re-open the picker → the saved selection is reflected (round-tripped through
    // the server + router.refresh).
    await page.getByRole('button', { name: 'Change avatar' }).click();
    await expect(page.getByRole('radio', { name: 'rocket' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('radio', { name: 'lavender' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');

    // The switcher chip now shows the preset (the mono "PR" letters are gone).
    await page.goto('/items');
    await expect(switcher(page).getByText('PR', { exact: true })).toHaveCount(0);
    await expect(switcher(page)).toContainText('Details E2E Renamed');

    // ── 3. Change the key PROD → NIF (consequence copy asserted) ─────────────
    await page.goto('/settings/project');
    await page.getByRole('button', { name: 'Change key', exact: false }).click();
    const keyModal = page.getByRole('dialog');
    await expect(keyModal.getByRole('heading', { name: 'Change project key' })).toBeVisible();
    await keyModal.getByRole('textbox', { name: 'New key' }).fill('NIF');
    await expect(keyModal.getByText('Available', { exact: true })).toBeVisible();
    // Noun-agnostic ("issue" vs "work item" — the catalog noun varies by runtime
    // terminology): assert the stable parts of the consequence copy.
    await expect(keyModal.getByText(/identifier becomes NIF/)).toBeVisible();
    await expect(keyModal.getByText(/Old PROD-? links keep working/)).toBeVisible();
    await keyModal.getByRole('button', { name: 'Change key', exact: true }).click();

    // The Details page now shows PROD as a previous (retired) key — scope to the
    // Previous-keys row (a listitem carrying a Release control) so the assertion
    // can't be satisfied by the live-key field instead.
    await expect(page.getByText('Previous keys')).toBeVisible();
    const prodPrevRow = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Release' }) });
    await expect(prodPrevRow).toContainText('PROD');

    // ── 4. An old issue link 308-redirects to its canonical NIF identifier ───
    await page.goto('/items/PROD-1');
    await page.waitForURL('**/items/NIF-1');
    expect(new URL(page.url()).pathname).toBe('/items/NIF-1');
    await expect(page.getByText('NIF-1', { exact: true })).toBeVisible();

    // ── 5. Reclaim the own previous key (revert): NIF → PROD ─────────────────
    // PROD goes live again and NIF becomes the retired key. (The reverse old-link
    // redirect — NIF-1 → PROD-1 — is proven deterministically by the integration
    // journey test; it is NOT re-asserted through the browser here because NIF-1
    // was already loaded as a LIVE page in step 4, so the dev route cache can
    // serve that stale render and make a re-visit flaky.)
    await page.goto('/settings/project');
    await page.getByRole('button', { name: 'Change key', exact: false }).click();
    const revertModal = page.getByRole('dialog');
    await revertModal.getByRole('textbox', { name: 'New key' }).fill('PROD');
    await expect(revertModal.getByText('Available', { exact: true })).toBeVisible();
    await revertModal.getByRole('button', { name: 'Change key', exact: true }).click();
    // The Previous-keys row now lists NIF (and no longer PROD — it's live again).
    const nifPrevRow = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Release' }) });
    await expect(nifPrevRow).toContainText('NIF');
    await expect(nifPrevRow).not.toContainText('PROD');
  });

  test('a non-admin member sees the Details values but NONE of the editing controls', async ({
    page,
  }) => {
    const tenant = await seedTenant('pd-owner-2@example.com');
    const member = await makeUser('pd-member@example.com', 'Mary Member');
    await workspacesService.addMember({ userId: member.id, workspaceId: tenant.workspaceId });
    await pinActiveProject(member.id, tenant);

    await signIn(page, member.email, PWD);
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();

    // The values are visible… (scope the name to the main pane — it also appears
    // in the settings rail header, which would make a bare match ambiguous).
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(page.locator('#main').getByText(PROJECT_NAME, { exact: true })).toBeVisible();
    // …but every editing affordance is absent (the hide is presentation; the
    // PATCH/DELETE reject server-side too — proven at the service tier).
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change key', exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change avatar' })).toHaveCount(0);
  });

  test('@a11y the Details page, avatar picker, change-key modal, and release confirm are axe-clean', async ({
    page,
  }) => {
    const tenant = await seedTenant('pd-owner-3@example.com');
    // Retire a key up front (PROD→NIF) so the Previous-keys row + Release control
    // render and can be swept.
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: tenant.ownerCtx });

    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    await expect(page.getByText('Previous keys')).toBeVisible();

    // Details page (with the Previous-keys / Release controls present).
    await sweep(page, '/settings/project — Details');

    // The avatar picker popover.
    await page.getByRole('button', { name: 'Change avatar' }).click();
    await expect(page.getByRole('radio', { name: 'rocket' })).toBeVisible();
    await sweep(page, 'avatar picker (open)');
    await page.keyboard.press('Escape');

    // The change-key modal.
    await page.getByRole('button', { name: 'Change key', exact: false }).click();
    await expect(page.getByRole('heading', { name: 'Change project key' })).toBeVisible();
    await sweep(page, 'change-key modal');
    await page.keyboard.press('Escape');

    // The release-key confirm. The retired key is PROD (PROD→NIF made NIF live and
    // PROD the alias), so the confirm reads "Release PROD?".
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Release PROD/ })).toBeVisible();
    await sweep(page, 'release-key confirm');
  });
});

async function sweep(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, formatViolations(label, results.violations as AxeViolation[])).toEqual(
    [],
  );
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[] }[];
}

function formatViolations(label: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${label}:\n${lines.join('\n')}`;
}
