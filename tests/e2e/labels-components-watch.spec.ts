// E2E: the Story-5.4 labels · components · watchers journey (Subtask 5.4.11 —
// the Story CLOSER), driving all three shipped surfaces through the real stack:
//   - the Labels rail card (5.4.8): type-to-create (`perf-q3`), the inline
//     no-spaces 422 (the rejected text stays for correction), case-insensitive
//     autocomplete reuse on ANOTHER issue (original casing displayed — the
//     JRACLOUD-24907 wart-fix), coloured chips;
//   - the Components admin page (5.4.10) + rail card (5.4.8): admin CRUD with
//     a default assignee, per-issue assignment, the default-assignee-at-create
//     rule surfaced on a fresh issue, and the MOVE branch of the
//     move-or-remove delete (carriers repointed, issues untouched);
//   - the WatchControl + watchers popover (5.4.9): auto-watch on create
//     visible on first paint, the `W` shortcut (and its while-typing guard),
//     the composite click (toggle + open), the roster with the You pill,
//     admin add-watcher;
//   - the watcher notifications (5.4.5) through the REAL runtime (Next server
//     + Inngest dev server + the file outbox): a comment by another user
//     mails the watcher and never the actor; a status transition does the
//     same off the `work-item/transitioned` emit;
//   - the role pass: a project viewer gets read-only chips but CAN watch
//     (watching is not editing); a non-admin member gets the read-only
//     Components settings page;
//   - the strict a11y sweep (the 5.3.8 grammar): the detail rail with a chip
//     picker open, the header with the watchers popover open, and the
//     Components settings page (list + create modal + delete dialog).
//
// @smoke — exercises the UI↔service↔jobs seams the unit/component tests
// can't: the rail actions → labels/components/watchersService → revision
// writes, the popover's paged list route, the settings actions →
// componentsService, and the comment/transition → Inngest → email.send →
// file-outbox path the dev email console mirrors.
//
// Personas are seeded server-side (the 5.3.8 grammar: usersService +
// workspacesService + projectsService + a direct projectMembership write —
// the sanctioned setup reach). Selectors target the stable role/label hooks
// the components expose ("Edit Labels"/"Edit Components" FieldCard toggles,
// the MultiSelectPicker combobox + listbox, the watch button's aria-label
// with its live count, the settings rows' "Edit/Delete <name>" affordances).
// Combobox option names can include secondary text (the member email), so
// member options are matched by substring (the selector-gotcha rule).
//
// NOTE (components at create): `workItemsService.createWorkItem` accepts
// `componentIds` and the default-assignee rule is fully unit-tested, but NO
// shipped UI passes components at create (the create modal has no Components
// field — logged as a finding, not absorbed here). The fresh-issue scenario
// therefore seeds the create server-side and asserts the visible OUTCOME
// (the auto-assigned assignee + the component chip on the new issue's page).

import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';

const PWD = 'labels-watch-e2e-pass-123';
const PROJECT_NAME = 'Labels Watch Project';
const PROJECT_KEY = 'LCW';

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
    name: 'Labels Watch Workspace',
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

/** A work item created by `creator` (defaults to the owner — who auto-watches). */
async function seedIssue(
  tenant: Tenant,
  title: string,
  opts: { creatorId?: string; componentIds?: string[] } = {},
): Promise<{ id: string; identifier: string }> {
  const creatorId = opts.creatorId ?? tenant.owner.id;
  const dto = await workItemsService.createWorkItem(
    {
      projectId: tenant.projectId,
      kind: 'task',
      title,
      ...(opts.componentIds ? { componentIds: opts.componentIds } : {}),
    },
    { userId: creatorId, workspaceId: tenant.workspaceId },
  );
  return { id: dto.id, identifier: dto.identifier };
}

function ownerCtx(tenant: Tenant) {
  return { userId: tenant.owner.id, workspaceId: tenant.workspaceId };
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/** The FieldCard chevron that opens a rail card's picker. */
function editToggle(page: Page, label: string): Locator {
  return page.getByRole('button', { name: `Edit ${label}`, exact: true });
}

/** The watch control — matched on its live aria-label (count included). */
function watchButton(page: Page): Locator {
  return page.getByRole('button', { name: /(Watch|Stop watching) — \d+ watching/ });
}

/** The watchers popover (a labelled dialog). */
function watchersPopover(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Watchers' });
}

async function gotoComponentsSettings(page: Page): Promise<void> {
  await page.goto('/settings/project/components');
  await expect(page.getByRole('heading', { name: 'Components', level: 1 })).toBeVisible();
}

/** Drive the create-component modal end to end (the 5.4.7 panel grammar). */
async function createComponentViaUi(
  page: Page,
  opts: { name: string; defaultAssignee?: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Add component' }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Name', { exact: true }).fill(opts.name);
  if (opts.defaultAssignee) {
    await modal.getByRole('combobox', { name: 'Default assignee' }).click();
    await page.getByPlaceholder('Search members…').fill(opts.defaultAssignee);
    await page.getByRole('option', { name: new RegExp(opts.defaultAssignee) }).click();
  }
  await modal.getByRole('button', { name: 'Create component' }).click();
  await expect(modal).toBeHidden();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Each test stands up a tenant + signs in + drives long picker/popover flows —
// heavier than the 30s default (the 5.3.8 precedent).
test.describe.configure({ timeout: 180_000 });

// ── the PM journey: labels → components → watch → notifications ─────────────

test('@smoke the PM type-creates labels, reuses them case-insensitively, and the no-spaces rule rejects inline', async ({
  page,
}) => {
  const tenant = await seedTenant('lcw-pm@example.com');
  const issueA = await seedIssue(tenant, 'Label holder');
  const issueB = await seedIssue(tenant, 'Second holder');
  await signIn(page, tenant.owner.email, PWD);

  // ── Type-create on issue A ─────────────────────────────────────────────────
  await page.goto(`/issues/${issueA.identifier}`);
  await expect(page.getByRole('heading', { name: 'Label holder' })).toBeVisible();
  await expect(page.getByText('No labels')).toBeVisible();

  await editToggle(page, 'Labels').click();
  const labelsInput = page.getByRole('combobox', { name: 'Labels' });
  await labelsInput.fill('perf-q3');
  await page.getByRole('option', { name: 'Create ‘perf-q3’' }).click();
  // The chip lands (the create row consumed the query).
  await expect(page.getByRole('button', { name: 'Remove perf-q3' })).toBeVisible();

  // ── The no-spaces rule rejects INLINE; the typed text stays ───────────────
  await labelsInput.fill('perf q3');
  await page.getByRole('option', { name: 'Create ‘perf q3’' }).click();
  const railError = page.locator('aside').getByRole('alert');
  await expect(railError).toContainText('Labels can’t contain spaces — use a hyphen: perf-q3');
  await expect(labelsInput).toHaveValue('perf q3');

  // ── Case-insensitive reuse on issue B: PERF-Q3 offers the SAME label,
  // original casing displayed (the JRACLOUD-24907 wart-fix) ─────────────────
  await page.goto(`/issues/${issueB.identifier}`);
  await editToggle(page, 'Labels').click();
  await page.getByRole('combobox', { name: 'Labels' }).fill('PERF-Q3');
  const reuseOption = page.getByRole('option', { name: 'perf-q3', exact: true });
  await expect(reuseOption).toBeVisible();
  // The autocomplete offered the EXISTING row — no second create row appears.
  await expect(page.getByRole('option', { name: 'Create ‘PERF-Q3’' })).toHaveCount(0);
  await reuseOption.click();
  await expect(page.getByRole('button', { name: 'Remove perf-q3' })).toBeVisible();

  // One label row serves both issues (find-or-create, case-insensitive).
  const rows = await db.label.findMany({ where: { projectId: tenant.projectId } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toBe('perf-q3');
});

test('@smoke the PM admin-creates components, assigns them, a defaulted create auto-assigns, and the MOVE delete repoints carriers', async ({
  page,
}) => {
  const tenant = await seedTenant('lcw-comp-pm@example.com');
  const bo = await makeUser('lcw-bo@example.com', 'Bo Philips');
  await addToWorkspace(bo.id, tenant.workspaceId);
  const issue = await seedIssue(tenant, 'Component holder');
  await signIn(page, tenant.owner.email, PWD);

  // ── Admin CRUD: API (default assignee Bo) + Web (no default) ──────────────
  await gotoComponentsSettings(page);
  await expect(page.getByText('No components yet')).toBeVisible();
  await createComponentViaUi(page, { name: 'API', defaultAssignee: 'Bo Philips' });
  await createComponentViaUi(page, { name: 'Web' });

  const componentRows = page.locator('[data-testid^="component-row-"]');
  await expect(componentRows).toHaveCount(2);
  await expect(componentRows.nth(0)).toContainText('API');
  await expect(componentRows.nth(0)).toContainText('Bo Philips');
  await expect(componentRows.nth(1)).toContainText('Web');

  // ── Assign both to the issue via the rail card ─────────────────────────────
  await page.goto(`/issues/${issue.identifier}`);
  await editToggle(page, 'Components').click();
  const compInput = page.getByRole('combobox', { name: 'Components' });
  await compInput.click();
  await page.getByRole('option', { name: 'API', exact: true }).click();
  await page.getByRole('option', { name: 'Web', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove API' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Web' })).toBeVisible();

  // ── The default-assignee-at-create rule, surfaced on a fresh issue. The
  // create goes through the service (no shipped UI passes components at
  // create — see the header note); the OUTCOME is asserted in the UI. ───────
  const api = (await db.component.findFirst({ where: { name: 'API' } }))!;
  const fresh = await seedIssue(tenant, 'Fresh defaulted issue', { componentIds: [api.id] });
  await page.goto(`/issues/${fresh.identifier}`);
  await expect(page.getByRole('heading', { name: 'Fresh defaulted issue' })).toBeVisible();
  // The component chip rendered, and the assignee auto-filled to Bo.
  await expect(page.getByText('API', { exact: true })).toBeVisible();
  await expect(page.getByText('Bo Philips').first()).toBeVisible();
  const freshRow = await db.workItem.findUnique({ where: { id: fresh.id } });
  expect(freshRow!.assigneeId).toBe(bo.id);

  // ── Delete API via the MOVE branch: carriers repoint to Web, issues
  // untouched; the holder already carrying Web keeps ONE (the dup skip) ──────
  await gotoComponentsSettings(page);
  await expect(componentRows.nth(0)).toContainText('2 issues');
  await page.getByRole('button', { name: 'Delete API', exact: true }).click();
  const confirm = page.getByRole('dialog');
  // .last(): the Modal renders an sr-only Radix title PLUS the visible serif
  // h2 with the same text — strict mode resolves two headings.
  await expect(confirm.getByRole('heading', { name: 'Delete API?' }).last()).toBeVisible();
  await expect(confirm.getByText(/is on/)).toContainText('2 work items');
  // The move radio is pre-selected when a target exists; pick Web explicitly.
  await expect(confirm.getByRole('radio', { name: /Move 2 work items to…/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await confirm.getByRole('combobox', { name: 'Move target component' }).click();
  await page.getByRole('option', { name: 'Web', exact: true }).click();
  // The editor removes the row OPTIMISTICALLY before the DELETE resolves —
  // wait for the actual response, or the navigation below races the commit
  // and the fresh issue renders pre-move (the 5.3.8 freshen-GET lesson).
  const deleted = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().includes('/api/components/'),
  );
  await confirm.getByRole('button', { name: 'Delete component' }).click();
  expect((await deleted).status()).toBe(200);
  await expect(confirm).toBeHidden();
  await expect(componentRows).toHaveCount(1);
  await expect(componentRows.nth(0)).toContainText('Web');

  // Both issues survived with Web exactly once.
  await page.goto(`/issues/${fresh.identifier}`);
  await expect(page.getByText('Web', { exact: true })).toBeVisible();
  const joins = await db.workItemComponent.findMany({
    where: { workItemId: { in: [issue.id, fresh.id] } },
  });
  expect(joins).toHaveLength(2); // one Web row per issue — never duplicated
});

test('@smoke watching: auto-watch on create, the W shortcut + typing guard, the popover roster, admin add, and the watcher emails', async ({
  page,
}) => {
  const tenant = await seedTenant('lcw-watch-pm@example.com');
  const bo = await makeUser('lcw-watch-bo@example.com', 'Bo Philips');
  const odie = await makeUser('lcw-watch-odie@example.com', 'Odie Walker');
  for (const p of [bo, odie]) {
    await addToWorkspace(p.id, tenant.workspaceId);
    await pinActiveProject(p.id, tenant);
  }
  const issue = await seedIssue(tenant, 'Watched task');
  await signIn(page, tenant.owner.email, PWD);

  // ── Auto-watch on create surfaces on first paint: the PM created the
  // issue, so the eye arrives PRESSED with count 1 ───────────────────────────
  await page.goto(`/issues/${issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Watched task' })).toBeVisible();
  const watch = watchButton(page);
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await expect(watch).toHaveAccessibleName('Stop watching — 1 watching');

  // ── W toggles both ways (outside text inputs) ──────────────────────────────
  await page.keyboard.press('w');
  await expect(watch).toHaveAttribute('aria-pressed', 'false');
  await expect(watch).toHaveAccessibleName('Watch — 0 watching');
  await page.keyboard.press('w');
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await expect(watch).toHaveAccessibleName('Stop watching — 1 watching');

  // ── …but never while typing (the input guard): type a 'w' into the comment
  // composer and the watch state holds ───────────────────────────────────────
  await page.getByRole('button', { name: 'Add a comment…' }).click();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('w');
  await expect(watch).toHaveAttribute('aria-pressed', 'true');

  // ── The composite click: toggles self-watch AND opens the roster ──────────
  await watch.click();
  const popover = watchersPopover(page);
  await expect(popover).toBeVisible();
  // The click toggled the PM OFF (the composite gesture's second half).
  await expect(watch).toHaveAttribute('aria-pressed', 'false');
  await expect(popover.getByText('Watchers · 0')).toBeVisible();

  // ── Admin add: Odie joins the roster via the member picker ────────────────
  await popover.getByLabel('Add a watcher…').fill('Odie');
  await popover.getByRole('button', { name: /Odie Walker/ }).click();
  await expect(popover.getByText('Odie Walker')).toBeVisible();
  await expect(watch).toHaveAccessibleName('Watch — 1 watching');

  // Close, then the composite click again: the PM is OFF, so the click
  // toggles them back ON and reopens — the reconciled roster lists both
  // rows, the PM's marked with the You pill.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await watch.click();
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await expect(watch).toHaveAccessibleName('Stop watching — 2 watching');
  await expect(popover.getByText('Watchers · 2')).toBeVisible();
  await expect(popover.getByText('Odie Walker')).toBeVisible();
  await expect(popover.getByText('You', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // ── The watcher email: Bo comments → Odie + the PM are watchers; the email
  // reaches Odie and the PM, never Bo (the actor) ────────────────────────────
  const boPage = await (await page.context().browser()!.newContext()).newPage();
  await signIn(boPage, bo.email, PWD);
  await boPage.goto(`/issues/${issue.identifier}`);
  await boPage.getByRole('button', { name: 'Add a comment…' }).click();
  await boPage.locator('.ProseMirror').click();
  await boPage.keyboard.type('A comment from Bo');
  await boPage.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(boPage.getByRole('button', { name: 'Add a comment…' })).toBeVisible();

  const odieEmail = await waitForEmail(odie.email, { timeoutMs: 30_000 });
  expect(odieEmail.subject).toBe(`Bo Philips commented on ${issue.identifier}: Watched task`);
  // Deep link unredacted in the plain text — the dev-console grep contract.
  expect(odieEmail.text).toContain(`/issues/${issue.identifier}`);
  // The actor is never notified — Bo auto-watched by commenting, yet gets
  // nothing about their own comment.
  expect((await emailsTo(bo.email)).filter((e) => e.subject.includes('commented on'))).toEqual([]);

  // ── The transition email rides work-item/transitioned: Bo moves the status,
  // the watchers are mailed, the actor is not ────────────────────────────────
  await boPage.getByRole('button', { name: 'Edit Status' }).click();
  await boPage.getByRole('combobox', { name: 'Status' }).click();
  await boPage.getByRole('option', { name: 'In Progress' }).click();
  // waitForEmail returns the LATEST match to Odie — poll until that's the
  // transition email (the comment email above is the earlier line).
  await expect(async () => {
    const latest = await waitForEmail(odie.email);
    expect(latest.subject).toBe(`Bo Philips moved ${issue.identifier} to In Progress`);
  }).toPass({ timeout: 30_000 });
  expect((await emailsTo(bo.email)).filter((e) => e.subject.includes('moved'))).toEqual([]);
  await boPage.context().close();
});

// ── the role pass: viewer (chips + watch) + non-admin member (settings) ──────

test('a viewer gets read-only chips but CAN watch; a non-admin member gets the read-only Components settings', async ({
  browser,
}) => {
  const tenant = await seedTenant('lcw-roles-owner@example.com');
  const member = await makeUser('lcw-roles-member@example.com', 'Mia Member');
  const viewer = await makeUser('lcw-roles-viewer@example.com', 'Vic Viewer');
  for (const p of [member, viewer]) {
    await addToWorkspace(p.id, tenant.workspaceId);
    await pinActiveProject(p.id, tenant);
  }
  await grantProjectRole(member.id, tenant, 'member');
  await grantProjectRole(viewer.id, tenant, 'viewer');

  const issue = await seedIssue(tenant, 'Role holder');
  await labelsService.addLabel(issue.id, 'perf-q3', ownerCtx(tenant));
  const web = await componentsService.createComponent(
    { key: PROJECT_KEY, name: 'Web' },
    ownerCtx(tenant),
  );
  await componentsService.addComponent(issue.id, web.id, ownerCtx(tenant));

  // Viewer: chips render, no edit toggles, no manage rows — but the watch
  // control works (watching is not editing, the verified permission split).
  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await signIn(viewerPage, viewer.email, PWD);
  await viewerPage.goto(`/issues/${issue.identifier}`);
  await expect(viewerPage.getByText('perf-q3')).toBeVisible();
  await expect(viewerPage.getByText('Web', { exact: true })).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Edit Labels' })).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: 'Edit Components' })).toHaveCount(0);

  const viewerWatch = watchButton(viewerPage);
  await expect(viewerWatch).toHaveAttribute('aria-pressed', 'false');
  await viewerWatch.click(); // composite: watches + opens the roster
  await expect(viewerWatch).toHaveAttribute('aria-pressed', 'true');
  await expect(viewerWatch).toHaveAccessibleName('Stop watching — 2 watching');
  const viewerPopover = watchersPopover(viewerPage);
  await expect(viewerPopover.getByText('You', { exact: true })).toBeVisible();
  // No manage affordances: no add-watcher input, no per-row remove.
  await expect(viewerPopover.getByLabel('Add a watcher…')).toHaveCount(0);
  await expect(viewerPopover.getByRole('button', { name: /Remove .* from watchers/ })).toHaveCount(
    0,
  );
  await viewerCtx.close();

  // Non-admin member: the Components settings page renders read-only.
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await signIn(memberPage, member.email, PWD);
  await memberPage.goto('/settings/project/components');
  await expect(memberPage.getByRole('heading', { name: 'Components', level: 1 })).toBeVisible();
  await expect(memberPage.getByText('Only project admins can manage components.')).toBeVisible();
  await expect(memberPage.locator('[data-testid^="component-row-"]')).toContainText('Web');
  await expect(memberPage.getByRole('button', { name: 'Add component' })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Edit Web', exact: true })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Delete Web', exact: true })).toHaveCount(0);
  await memberCtx.close();
});

// ── the strict a11y sweep (the 5.3.8 grammar) ────────────────────────────────

test('the detail route is axe-clean with the chip picker and the watchers popover open (WCAG 2.1 AA; strict)', async ({
  page,
}) => {
  const tenant = await seedTenant('lcw-a11y-detail@example.com');
  const issue = await seedIssue(tenant, 'A11y holder');
  await labelsService.addLabel(issue.id, 'perf-q3', ownerCtx(tenant));
  const web = await componentsService.createComponent(
    { key: PROJECT_KEY, name: 'Web' },
    ownerCtx(tenant),
  );
  await componentsService.addComponent(issue.id, web.id, ownerCtx(tenant));

  await signIn(page, tenant.owner.email, PWD);
  await page.goto(`/issues/${issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'A11y holder' })).toBeVisible();

  // The Labels picker open (combobox + listbox + chips). The sweep scopes to
  // the RAIL (the <aside> — the 5.4.8 surface): the 2.4.6 sweep owns the full
  // route, and the main column's comment composer carries a pre-existing
  // contrast miss (finding #82) that is 5.1's surface, not this Story's.
  await editToggle(page, 'Labels').click();
  await page.getByRole('combobox', { name: 'Labels' }).click();
  await expect(page.getByRole('option', { name: 'perf-q3', exact: true })).toBeVisible();

  const pickerResults = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include('aside')
    .analyze();
  expect(
    pickerResults.violations,
    formatViolations('issue rail (labels picker open)', pickerResults.violations as AxeViolation[]),
  ).toEqual([]);

  // The watchers popover open — it portals out of the header, so the sweep
  // includes the header (the eye + count control) and the popover dialog.
  await page.keyboard.press('Escape');
  await watchButton(page).click();
  await expect(watchersPopover(page)).toBeVisible();
  await expect(page.getByLabel('Add a watcher…')).toBeVisible();

  const popoverResults = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include('header')
    .include('[role="dialog"]')
    .analyze();
  expect(
    popoverResults.violations,
    formatViolations(
      'issue header (watchers popover open)',
      popoverResults.violations as AxeViolation[],
    ),
  ).toEqual([]);
});

test('the Components settings page is axe-clean — list, create modal, and delete dialog (WCAG 2.1 AA; strict)', async ({
  page,
}) => {
  const tenant = await seedTenant('lcw-a11y-settings@example.com');
  const bo = await makeUser('lcw-a11y-bo@example.com', 'Bo Philips');
  await addToWorkspace(bo.id, tenant.workspaceId);
  const api = await componentsService.createComponent(
    { key: PROJECT_KEY, name: 'API', defaultAssigneeId: bo.id },
    ownerCtx(tenant),
  );
  await componentsService.createComponent({ key: PROJECT_KEY, name: 'Web' }, ownerCtx(tenant));
  const issue = await seedIssue(tenant, 'Sweep holder');
  await componentsService.addComponent(issue.id, api.id, ownerCtx(tenant));

  await signIn(page, tenant.owner.email, PWD);
  await gotoComponentsSettings(page);
  await expect(page.locator('[data-testid^="component-row-"]')).toHaveCount(2);

  const listResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    listResults.violations,
    formatViolations(
      '/settings/project/components (list)',
      listResults.violations as AxeViolation[],
    ),
  ).toEqual([]);

  // The create modal — fields filled, the member picker CLOSED. The open
  // listbox's active row puts --el-text-muted secondary text on --el-surface
  // (4.16:1) — the finding-#82 pair, a shared Combobox-primitive surface
  // whose fix is token-level and owned by that finding, not this Story's
  // settings page (the 5.3.8 scoping precedent).
  await page.getByRole('button', { name: 'Add component' }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Name', { exact: true }).fill('Billing');
  await expect(modal.getByRole('combobox', { name: 'Default assignee' })).toBeVisible();

  const modalResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    modalResults.violations,
    formatViolations(
      '/settings/project/components (create modal)',
      modalResults.violations as AxeViolation[],
    ),
  ).toEqual([]);
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toBeHidden();

  // The move-or-remove delete dialog with the radio choice + target picker.
  await page.getByRole('button', { name: 'Delete API', exact: true }).click();
  const confirm = page.getByRole('dialog');
  // .last(): sr-only Radix title + the visible serif h2 share the text.
  await expect(confirm.getByRole('heading', { name: 'Delete API?' }).last()).toBeVisible();
  await expect(confirm.getByRole('radiogroup')).toBeVisible();

  const deleteResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    deleteResults.violations,
    formatViolations(
      '/settings/project/components (delete dialog)',
      deleteResults.violations as AxeViolation[],
    ),
  ).toEqual([]);
});
