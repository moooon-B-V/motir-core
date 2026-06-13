// E2E: the Story-5.3 custom-fields journey (Subtask 5.3.8) — the Story CLOSER,
// driving BOTH shipped surfaces through the real stack:
//   - the Fields admin page (5.3.6): create one field of each of the five
//     types (select w/ a seeded option set), the in-modal options editor,
//     archive-an-in-use-option, and the delete-field confirm that names the
//     value count (the team-managed hard-delete truth);
//   - the detail rail (5.3.7): the "Show more fields (N)" disclosure, all five
//     per-type inline editors (Input / DatePicker grid / Combobox / member
//     Combobox keyboard path), persistence across reload, the
//     archived-option rendering split (kept on the holding issue, gone from
//     the picker), and the revision trail (`customFields.<key>` diffs —
//     asserted at the data layer; the History STREAM rendering is Story 5.5);
//   - the role pass: a non-admin member gets the read-only settings page, a
//     project viewer gets the read-only rail;
//   - the strict a11y sweep (extends the settings + 2.4.6 sweeps): the Fields
//     page with the create modal open, and the rail with editors open.
//
// @smoke — exercises the UI↔service seams the unit/component tests can't: the
// modal fetch flows → customFieldsService, the rail's
// setCustomFieldValueAction → customFieldValuesService → revision write. The
// rail keeps the picked value OPTIMISTICALLY on success (no router.refresh —
// the inline-edit rule), so this spec waits on the action's authoritative
// network signal, never an optimistic on-screen value, before reading the DB.
//
// Personas are seeded server-side (the project-access grammar: usersService +
// workspacesService + projectsService + a direct projectMembership write —
// the sanctioned setup reach; the dev/CI test DB runs BYPASSRLS). Selectors
// target the stable role/label hooks the components expose (the "Edit
// <field>" FieldCard toggles, the labelled Comboboxes/DatePicker, the
// settings rows' "Edit/Delete <label>" affordances) — never brittle text.
// Combobox option names can include secondary text (the member email), so
// member options are matched by substring (the selector-gotcha rule).

import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { formatDate } from '@/lib/utils/datetime';

const PWD = 'custom-fields-e2e-pass-123';
const PROJECT_NAME = 'Custom Fields Project';
const PROJECT_KEY = 'CFLD';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: unknown }>;
}

function formatViolations(surface: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${surface}:\n${lines.join('\n')}`;
}

interface Persona {
  id: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  owner: Persona;
}

async function makeUser(email: string, name: string): Promise<Persona> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email, name };
}

async function addToWorkspace(userId: string, workspaceId: string): Promise<void> {
  await workspacesService.addMember({ userId, workspaceId });
}

async function grantProjectRole(
  userId: string,
  tenant: Tenant,
  role: 'admin' | 'member' | 'viewer',
): Promise<void> {
  await db.projectMembership.create({
    data: { userId, workspaceId: tenant.workspaceId, projectId: tenant.projectId, role },
  });
}

async function pinActiveProject(userId: string, tenant: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: tenant.workspaceId } },
    data: { activeProjectId: tenant.projectId },
  });
}

/** Owner + workspace + one open project; the owner is pinned active. */
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Petra PM');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Fields Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  const tenant: Tenant = { workspaceId: workspace.id, projectId: project.id, owner };
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

/** A work item the values land on; returns { id, identifier } (CFLD-1). */
async function seedIssue(tenant: Tenant): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: tenant.projectId, kind: 'task', title: 'Field holder' },
    { userId: tenant.owner.id, workspaceId: tenant.workspaceId },
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** The owner-actor input for server-side customFieldsService seeding. */
function ownerActor(tenant: Tenant) {
  return {
    key: PROJECT_KEY,
    actorUserId: tenant.owner.id,
    ctx: { userId: tenant.owner.id, workspaceId: tenant.workspaceId },
  };
}

// ── UI helpers ────────────────────────────────────────────────────────────────

async function gotoFields(page: Page): Promise<void> {
  await page.goto('/settings/project/fields');
  // exact: the list's "Custom fields" heading would substring-match 'Fields'.
  await expect(page.getByRole('heading', { name: 'Fields', exact: true })).toBeVisible();
}

/** Drive the create-field modal end to end (the 5.3.4 panel-3 grammar). */
async function createFieldViaUi(
  page: Page,
  opts: { label: string; type: 'Text' | 'Number' | 'Date' | 'Select' | 'User'; options?: string[] },
): Promise<void> {
  await page.getByRole('button', { name: 'Add field' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Label', { exact: true }).fill(opts.label);
  // The radio's accessible name is "<Type> <type description>" — anchor on the
  // type word so "Text"/"Select" don't cross-match descriptions.
  await modal.getByRole('radio', { name: new RegExp(`^${opts.type}\\b`) }).click();
  for (const option of opts.options ?? []) {
    await modal.getByRole('button', { name: 'Add option' }).click();
    await modal.getByPlaceholder('Option label').last().fill(option);
  }
  await modal.getByRole('button', { name: 'Create field' }).click();
  await expect(modal).toBeHidden();
}

/** The FieldCard chevron that opens a custom field's inline editor. */
function editToggle(page: Page, label: string): Locator {
  return page.getByRole('button', { name: `Edit ${label}`, exact: true });
}

/** The FieldCard hosting a custom field — the toggle's Card ancestor. Value
 *  assertions scope here so e.g. a "High" priority pill elsewhere on the page
 *  can't collide with the Severity card's "High" (strict-mode safety). */
function fieldCard(page: Page, label: string): Locator {
  return editToggle(page, label).locator('..').locator('..');
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Each test stands up a tenant + signs in + drives long modal/editor flows —
// heavier than the 30s default (the shell-a11y precedent).
test.describe.configure({ timeout: 180_000 });

// ── the PM journey: define → set each type → persist → archive → delete ──────

test('the PM defines the five field types, sets each on an issue inline, and the values persist with revision diffs', async ({
  page,
}) => {
  const tenant = await seedTenant('cf-pm@example.com');
  const issue = await seedIssue(tenant);
  await signIn(page, tenant.owner.email, PWD);

  // ── Define (Fields admin, the 5.3.4 mockup) ────────────────────────────────
  await gotoFields(page);
  await expect(page.getByText('No custom fields yet')).toBeVisible();

  await createFieldViaUi(page, {
    label: 'Severity',
    type: 'Select',
    options: ['Low', 'Medium', 'High'],
  });
  await createFieldViaUi(page, { label: 'Customer', type: 'Text' });
  await createFieldViaUi(page, { label: 'Effort', type: 'Number' });
  await createFieldViaUi(page, { label: 'Go-live', type: 'Date' });
  await createFieldViaUi(page, { label: 'Stakeholder', type: 'User' });

  // All five list in creation (position) order with their type glosses.
  const rows = page.locator('[data-testid^="field-row-"]');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('Severity');
  await expect(rows.nth(0)).toContainText('3 options');
  await expect(rows.nth(1)).toContainText('Customer');
  await expect(rows.nth(4)).toContainText('Stakeholder');

  // ── Set each type inline on the rail (the 5.3.5 mockup) ───────────────────
  await page.goto(`/issues/${issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Field holder' })).toBeVisible();

  // All five are empty → all sit behind the disclosure.
  const showMore = page.getByRole('button', { name: 'Show more fields (5)' });
  await expect(showMore).toHaveAttribute('aria-expanded', 'false');
  await showMore.click();

  // text — commits on blur (the Estimate grammar).
  await editToggle(page, 'Customer').click();
  await page.getByRole('textbox', { name: 'Customer', exact: true }).fill('Acme Corp');
  await page.keyboard.press('Tab');
  await expect(fieldCard(page, 'Customer')).toContainText('Acme Corp');

  // number.
  await editToggle(page, 'Effort').click();
  await page.getByRole('textbox', { name: 'Effort', exact: true }).fill('3.5');
  await page.keyboard.press('Tab');
  await expect(fieldCard(page, 'Effort')).toContainText('3.5');

  // date — the DatePicker grid; pick today (the aria-current cell), the one
  // day guaranteed on the visible month.
  await editToggle(page, 'Go-live').click();
  const calendar = page.getByRole('dialog', { name: 'Go-live' });
  await expect(calendar).toBeVisible();
  await calendar.locator('button[aria-current="date"]').click();
  const todayIso = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  await expect(fieldCard(page, 'Go-live')).toContainText(formatDate(todayIso, 'en'));

  // select — the Combobox opens on edit; pick High.
  await editToggle(page, 'Severity').click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await expect(fieldCard(page, 'Severity')).toContainText('High');

  // ── Reload: the four values persist; Stakeholder still sits behind the
  // disclosure with the updated count ────────────────────────────────────────
  await page.reload();
  await expect(fieldCard(page, 'Customer')).toContainText('Acme Corp');
  await expect(fieldCard(page, 'Effort')).toContainText('3.5');
  await expect(fieldCard(page, 'Go-live')).toContainText(formatDate(todayIso, 'en'));
  await expect(fieldCard(page, 'Severity')).toContainText('High');
  await expect(editToggle(page, 'Stakeholder')).toBeHidden();
  await page.getByRole('button', { name: 'Show more fields (1)' }).click();

  // user — the searchable member Combobox, driven by keyboard; the option
  // name carries the email secondary, so match by substring. The set is
  // OPTIMISTIC — the card shows "Petra PM" from the local override the instant
  // it's picked, BEFORE the Server Action commits — so the on-screen text is
  // NOT a commit signal. Wait for the action's POST to land (200) before
  // reading the revision trail straight from the DB below, or the stakeholder
  // write races the read and its diff is missing (the inline-edit
  // authoritative-signal rule; the other four are covered by the reload above).
  await editToggle(page, 'Stakeholder').click();
  await page.getByPlaceholder('Search members…').fill('Petra');
  const stakeholderWrite = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().includes(issue.identifier) && r.status() === 200,
  );
  await page.getByRole('option', { name: /Petra PM/ }).click();
  await stakeholderWrite;
  await expect(fieldCard(page, 'Stakeholder')).toContainText('Petra PM');

  // Every field now holds a value → the disclosure is gone entirely.
  await expect(page.getByRole('button', { name: /Show more fields/ })).toHaveCount(0);

  // ── The revision trail recorded one customFields.<key> diff per set (the
  // 1.4.6 entries Story 5.5 renders; no stream UI yet, so assert the data) ───
  const revisions = await db.workItemRevision.findMany({
    where: { workItemId: issue.id, changeKind: 'updated' },
  });
  const diffKeys = revisions.flatMap((r) => Object.keys(r.diff as Record<string, unknown>));
  expect(diffKeys).toEqual(
    expect.arrayContaining([
      'customFields.customer',
      'customFields.effort',
      'customFields.go-live',
      'customFields.severity',
      'customFields.stakeholder',
    ]),
  );

  // ── Archive an in-use option: kept on the holding issue, gone from the
  // picker (the verified split) ──────────────────────────────────────────────
  await gotoFields(page);
  await page.getByRole('button', { name: 'Edit Severity', exact: true }).click();
  const editModal = page.getByRole('dialog');
  const highRow = editModal.locator('[data-testid^="option-row-"]').filter({ hasText: 'High' });
  await highRow.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(highRow.getByText('Archived', { exact: true })).toBeVisible();
  // An in-use option's Delete is disabled (the archive-instead affordance).
  await expect(highRow.getByRole('button', { name: 'Delete High', exact: true })).toBeDisabled();
  await editModal.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/issues/${issue.identifier}`);
  // Still rendered on the holding issue, with the archived mark…
  await expect(fieldCard(page, 'Severity')).toContainText('High (archived)');
  // …but excluded from new selection in the picker.
  await editToggle(page, 'Severity').click();
  await expect(page.getByRole('option', { name: 'Low', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /High/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ── Delete the field: the confirm names the value count, the values die,
  // the rail card disappears (the team-managed hard delete) ─────────────────
  await gotoFields(page);
  // Opening the confirm kicks off a freshen GET for the value count (the
  // 5.3.4 legend). Let it land before confirming — the count under test is
  // the FRESH one, and confirming inside the round-trip hits the
  // stale-freshen-clobbers-optimistic-delete race (finding #81).
  const freshened = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().includes('/fields'),
  );
  await page.getByRole('button', { name: 'Delete Severity', exact: true }).click();
  await freshened;
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Delete Severity?' })).toBeVisible();
  await expect(confirm.getByText(/values on/)).toContainText('1 issue');
  // The admin list drops the row OPTIMISTICALLY (before the DELETE resolves),
  // so the row-count → 4 is NOT a commit signal. Wait for the DELETE /api/fields
  // response to land before navigating to the issue, or the rail re-renders the
  // not-yet-deleted field (the optimistic-delete-vs-read race, finding #81 /
  // the authoritative-signal rule).
  const fieldDeleted = page.waitForResponse(
    (r) =>
      r.request().method() === 'DELETE' && r.url().includes('/api/fields/') && r.status() === 200,
  );
  await confirm.getByRole('button', { name: 'Delete field' }).click();
  await fieldDeleted;
  await expect(page.locator('[data-testid^="field-row-"]')).toHaveCount(4);

  await page.goto(`/issues/${issue.identifier}`);
  await expect(fieldCard(page, 'Customer')).toContainText('Acme Corp');
  await expect(editToggle(page, 'Severity')).toHaveCount(0);
  await expect(page.getByText('High (archived)')).toHaveCount(0);
});

// ── the role pass: non-admin member (settings) + viewer (rail) ───────────────

test('a non-admin member gets the read-only Fields page; a project viewer gets the read-only rail', async ({
  browser,
}) => {
  const tenant = await seedTenant('cf-owner@example.com');
  const issue = await seedIssue(tenant);

  // Seed a field + a value server-side (the owner acts; the UI under test is
  // the read-only degradation, not the write path).
  const customer = await customFieldsService.createField({
    ...ownerActor(tenant),
    label: 'Customer',
    fieldType: 'text',
  });
  await customFieldValuesService.setValue(issue.id, customer.id, 'Acme Corp', {
    userId: tenant.owner.id,
    workspaceId: tenant.workspaceId,
  });

  const member = await makeUser('cf-member@example.com', 'Mia Member');
  const viewer = await makeUser('cf-viewer@example.com', 'Vic Viewer');
  for (const p of [member, viewer]) {
    await addToWorkspace(p.id, tenant.workspaceId);
  }
  await grantProjectRole(member.id, tenant, 'member');
  await grantProjectRole(viewer.id, tenant, 'viewer');
  await pinActiveProject(member.id, tenant);
  await pinActiveProject(viewer.id, tenant);

  // Member: the Fields page renders read-only — values visible, no mutation
  // affordances, the quiet permission line (the 6.4 read-only grammar).
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await signIn(memberPage, member.email, PWD);
  await gotoFields(memberPage);
  await expect(memberPage.getByText('Customer', { exact: true })).toBeVisible();
  await expect(memberPage.getByText('Only project admins can manage fields.')).toBeVisible();
  await expect(memberPage.getByRole('button', { name: 'Add field' })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Edit Customer' })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Delete Customer' })).toHaveCount(0);
  await memberCtx.close();

  // Viewer: the rail renders values but no editors (no FieldCard chevrons).
  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await signIn(viewerPage, viewer.email, PWD);
  await viewerPage.goto(`/issues/${issue.identifier}`);
  await expect(viewerPage.getByText('Acme Corp')).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Edit Customer' })).toHaveCount(0);
  await viewerCtx.close();
});

// ── the strict a11y sweep (extends the settings + 2.4.6 sweeps) ──────────────

test('the Fields settings page is axe-clean, list and create modal alike (WCAG 2.1 AA; strict)', async ({
  page,
}) => {
  const tenant = await seedTenant('cf-a11y-settings@example.com');
  await customFieldsService.createField({
    ...ownerActor(tenant),
    label: 'Severity',
    fieldType: 'select',
    options: ['Low', 'Medium', 'High'],
  });
  await customFieldsService.createField({
    ...ownerActor(tenant),
    label: 'Customer',
    fieldType: 'text',
  });
  await signIn(page, tenant.owner.email, PWD);
  await gotoFields(page);
  await expect(page.locator('[data-testid^="field-row-"]')).toHaveCount(2);

  const listResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    listResults.violations,
    formatViolations('/settings/project/fields (list)', listResults.violations as AxeViolation[]),
  ).toEqual([]);

  // The create modal with the five-type picker + the options editor open.
  await page.getByRole('button', { name: 'Add field' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('radio', { name: /^Select\b/ }).click();
  await modal.getByRole('button', { name: 'Add option' }).click();
  await modal.getByPlaceholder('Option label').last().fill('Low');

  const modalResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    modalResults.violations,
    formatViolations(
      '/settings/project/fields (create modal)',
      modalResults.violations as AxeViolation[],
    ),
  ).toEqual([]);
});

test('the detail rail with custom-field editors open is axe-clean (WCAG 2.1 AA; strict)', async ({
  page,
}) => {
  const tenant = await seedTenant('cf-a11y-rail@example.com');
  const issue = await seedIssue(tenant);
  const severity = await customFieldsService.createField({
    ...ownerActor(tenant),
    label: 'Severity',
    fieldType: 'select',
    options: ['Low', 'Medium', 'High'],
  });
  await customFieldsService.createField({
    ...ownerActor(tenant),
    label: 'Customer',
    fieldType: 'text',
  });
  await customFieldValuesService.setValue(
    issue.id,
    severity.id,
    (await db.customFieldOption.findFirst({ where: { fieldId: severity.id, label: 'High' } }))!.id,
    { userId: tenant.owner.id, workspaceId: tenant.workspaceId },
  );

  await signIn(page, tenant.owner.email, PWD);
  await page.goto(`/issues/${issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Field holder' })).toBeVisible();

  // The disclosure expanded + the text editor open. The sweep scopes to the
  // RAIL (the <aside> — the 5.3.7 surface this Story closes): the 2.4.6 sweep
  // owns the full route, and the main column's comment composer carries a
  // pre-existing contrast miss (finding #82 — --el-text-muted on --el-surface
  // at 4.16:1) that is 5.1's surface, not custom fields'.
  await page.getByRole('button', { name: 'Show more fields (1)' }).click();
  await editToggle(page, 'Customer').click();
  await expect(page.getByRole('textbox', { name: 'Customer', exact: true })).toBeVisible();

  const editorResults = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include('aside')
    .analyze();
  expect(
    editorResults.violations,
    formatViolations('issue rail (text editor open)', editorResults.violations as AxeViolation[]),
  ).toEqual([]);

  // The select Combobox open — its menu PORTALS to <body> (the rail is not a
  // dialog), so the listbox is swept via its own include alongside the rail.
  await page.keyboard.press('Escape');
  await editToggle(page, 'Severity').click();
  await expect(page.getByRole('option', { name: 'Low', exact: true })).toBeVisible();

  const pickerResults = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include('aside')
    .include('[role="listbox"]')
    .analyze();
  expect(
    pickerResults.violations,
    formatViolations('issue rail (select picker open)', pickerResults.violations as AxeViolation[]),
  ).toEqual([]);
});
