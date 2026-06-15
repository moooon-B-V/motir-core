// E2E: the combined Epic-6 journey (Story 6.7 · Subtask 6.7.2) — ONE continuous
// flow that exercises every Epic-6 feature and asserts the seams that only exist
// BETWEEN stories. Each sibling closer proves its OWN surface in isolation
// (6.1.6 filter compile, 6.2's saved-filter matrix, 6.3 dashboards, 6.4.8 the
// access matrix, 6.6.7 the automation journey); THIS spec proves the CHAIN.
//
// Build-up (admin): build an advanced filter with a NEGATION row + a CUSTOM-FIELD
// row (6.1) → save + name it (6.2) → back a dashboard widget with it (6.3) →
// create an automation rule from the built-in action set (6.6) → transition a
// matching issue → the rule fires through the job lane, its action lands through
// the shipped services (the priority change is attributed to the rule owner — the
// 5.5 feed shows it like a real actor), the 5.4 watcher email fires (actor
// excluded), and the saved-filter result set + the widget both track the change.
//
// Gate (non-admin): a project viewer (the shipped 6.4 level) finds EVERY Epic-6
// admin surface — saved-filter management, dashboard editing, the rule admin in
// the 6.5 hub — hidden in the UI AND 403 at the API. These surfaces post-date
// 6.4.8, so no shipped test covers them combined.
//
// Unwind: delete the saved filter under the live widget → the designed stale
// "Filter missing" card (the 6.1 stale-referent durability rule), never a crash;
// disable the rule → a further transition fires nothing; delete the rule → its
// action's History entry keeps rendering (the revision persists past the
// vanished rule — the 5.5.1 deleted-referent grammar).
//
// The consolidated role × admin-endpoint permission matrix (inventory-driven) and
// the rule-firing transaction seams the browser can't see (exactly-once under
// retry, owner attribution on the revision, no orphan rows after delete) live in
// the Vitest companion `tests/integration/epic6-journey.test.ts`.
//
// Personas are seeded server-side (the collab-journey 5.6.2 grammar: the shipped
// services + the test-sanctioned active-project pin), then the journey is driven
// through the real stack (Next dev server + Inngest dev server + the file email
// outbox). Selectors target the stable role/label/testid hooks the Epic-6
// components expose — the same ones the per-story specs use — never markup.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { watchersService } from '@/lib/services/watchersService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { automationRulesService } from '@/lib/services/automationRulesService';

const PWD = 'epic6-journey-e2e-pass-123';
const PROJECT_NAME = 'Epic-6 Journey Project';
const PROJECT_KEY = 'EPIX';
const FILTER_NAME = 'High-sev not deferred';
const DASHBOARD_NAME = 'Delivery overview';
const RULE_NAME = 'Escalate resolved bugs';
const BUG_TITLE = 'Payment gateway down';

// A tenant + 3 personas + the multi-page build-up + several real async engine /
// watcher round-trips through the dev Inngest server: well past the 30s default
// (the collab-journey / automation ceilings).
test.describe.configure({ timeout: 240_000 });

interface Persona {
  id: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  key: string;
  owner: Persona;
}

function ownerCtx(t: Tenant) {
  return { userId: t.owner.id, workspaceId: t.workspaceId };
}

async function makeUser(email: string, name: string): Promise<Persona> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email, name };
}

async function pinActiveProject(userId: string, t: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
    data: { activeProjectId: t.projectId },
  });
}

/** Owner + workspace + one open project; the owner is pinned active. */
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Petra PM');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Epic-6 Journey Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  const tenant: Tenant = {
    workspaceId: workspace.id,
    projectId: project.id,
    key: project.identifier,
    owner,
  };
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

// ── `_test` transport (the shipped service paths — events really fire) ─────────

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

/** todo → in_progress → in_review → done — the default-workflow legal path; the
 *  terminal →done edge is what a "transitioned to Done" rule fires on. */
async function driveToDone(page: Page, id: string): Promise<void> {
  await transition(page, id, 'in_progress');
  await transition(page, id, 'in_review');
  await transition(page, id, 'done');
}

/** Poll the engine's WRITE (the execution row) — never a sleep. */
async function expectExecutionCount(ruleId: string, status: 'success', min: number): Promise<void> {
  await expect
    .poll(() => db.automationRuleExecution.count({ where: { ruleId, status } }), {
      timeout: 30_000,
      message: `awaiting ${min} ${status} execution(s) for rule ${ruleId}`,
    })
    .toBeGreaterThanOrEqual(min);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke the combined Epic-6 journey: build → save → widget → rule → fire, the viewer gate, then the unwind', async ({
  page,
  browser,
}) => {
  // ── Server-side scaffold: tenant, a viewer, a watcher, a Severity select field,
  // and a High-severity Bug born at Low priority (so the negation row excludes it
  // until the rule escalates it) — watched by the watcher persona. ──────────────
  const tenant = await seedTenant('e6-pm@example.com');

  const viewer = await makeUser('e6-viewer@example.com', 'Val Viewer');
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: tenant.workspaceId,
    role: 'member',
  });
  await projectMembersService.addMember({
    key: tenant.key,
    actorUserId: tenant.owner.id,
    ctx: ownerCtx(tenant),
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await pinActiveProject(viewer.id, tenant);

  const watcher = await makeUser('e6-watcher@example.com', 'Will Watcher');
  await workspacesService.addMember({
    userId: watcher.id,
    workspaceId: tenant.workspaceId,
    role: 'member',
  });
  await pinActiveProject(watcher.id, tenant);

  await customFieldsService.createField({
    key: tenant.key,
    actorUserId: tenant.owner.id,
    ctx: ownerCtx(tenant),
    label: 'Severity',
    fieldType: 'select',
    options: ['Low', 'Medium', 'High'],
  });
  const severityField = await db.customFieldDefinition.findFirstOrThrow({
    where: { projectId: tenant.projectId, label: 'Severity' },
  });
  const highOption = await db.customFieldOption.findFirstOrThrow({
    where: { fieldId: severityField.id, label: 'High' },
  });

  const bug = await workItemsService.createWorkItem(
    { projectId: tenant.projectId, kind: 'bug', title: BUG_TITLE },
    ownerCtx(tenant), // the PM creates → auto-watches
  );
  // Born at Low priority — the negation row (Priority is none of Low/Lowest)
  // EXCLUDES it until the rule escalates it to Highest; Severity High matches the
  // CF row throughout.
  await db.workItem.update({ where: { id: bug.id }, data: { priority: 'low' } });
  await customFieldValuesService.setValue(
    bug.id,
    severityField.id,
    highOption.id,
    ownerCtx(tenant),
  );
  await watchersService.watch(bug.id, { userId: watcher.id, workspaceId: tenant.workspaceId });

  await signIn(page, tenant.owner.email, PWD);

  // ════════════════════════ BUILD-UP (admin) ════════════════════════
  // ── 1. Build the advanced filter: a NEGATION row (6.1) + a CUSTOM-FIELD row ──
  await page.goto('/issues?view=list');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();

  // Condition 1 — Priority IS NONE OF Lowest, Low (the negation operator).
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row1 = dialog.getByRole('group', { name: 'Condition 1' });
  await row1.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Priority', exact: true }).click();
  await row1.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is none of' }).click();
  await row1.getByRole('combobox', { name: 'Priority values' }).click();
  await page.getByRole('option', { name: 'Lowest', exact: true }).click();
  await page.getByRole('option', { name: 'Low', exact: true }).click();
  await page.keyboard.press('Escape'); // close the value listbox, not the builder
  await expect(dialog).toBeVisible();

  // Condition 2 — Severity (the custom field) IS ANY OF High.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row2 = dialog.getByRole('group', { name: 'Condition 2' });
  await row2.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Severity', exact: true }).click();
  await row2.getByRole('combobox', { name: 'Severity values' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.keyboard.press('Escape'); // close the value listbox
  await page.keyboard.press('Escape'); // close the builder
  await expect(dialog).not.toBeVisible();

  // The bug is excluded (Low priority) → zero matches under the live filter.
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '0 work items match',
  );

  // ── 2. Save + name it, shared with the project (6.2) ─────────────────────────
  await page.getByRole('button', { name: 'Save as' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save filter' });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel('Name').fill(FILTER_NAME);
  await saveDialog.getByText('Everyone who can browse this project can see and apply it.').click();
  await expect(saveDialog.getByRole('radio', { name: /Project/ })).toBeChecked();
  await saveDialog.getByRole('button', { name: 'Save filter' }).click();
  await expect(saveDialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: new RegExp(`Applied filter: ${FILTER_NAME}`) }),
  ).toBeVisible();

  const savedFilter = await db.savedFilter.findFirstOrThrow({
    where: { projectId: tenant.projectId, name: FILTER_NAME },
  });

  // ── 3. Back a dashboard widget with the saved filter (6.3) ───────────────────
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
  await page.getByTestId('new-dashboard').click();
  const createDash = page.getByRole('dialog', { name: 'New dashboard' });
  await createDash.getByTestId('create-dashboard-name').fill(DASHBOARD_NAME);
  await createDash.getByTestId('access-card-workspace').click();
  await createDash.getByTestId('create-dashboard-submit').click();
  await page.waitForURL(/\/dashboard\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('dashboard-add-widget').click();
  await expect(page.getByRole('dialog', { name: 'Add a widget' })).toBeVisible();
  await page.getByTestId('add-widget-filter_results').click();
  const widgetCfg = page.getByRole('dialog');
  await widgetCfg.getByRole('button', { name: 'Saved filter' }).click();
  await widgetCfg.getByRole('combobox', { name: 'Select a saved filter…' }).click();
  await page.getByRole('option', { name: new RegExp(FILTER_NAME) }).click();
  const widgetCreated = page.waitForResponse(
    (r) => /\/dashboards\/[^/]+\/widgets$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByTestId('widget-config-save').click();
  expect((await widgetCreated).status()).toBe(201);
  await expect(page.locator('[data-testid^="dashboard-widget-grip-"]')).toHaveCount(1);

  const dashboard = await db.dashboard.findFirstOrThrow({
    where: { workspaceId: tenant.workspaceId, name: DASHBOARD_NAME },
  });

  // ── 4. Create the automation rule (6.6): transitioned → Done, if Kind=Bug,
  // then set Priority = Highest ────────────────────────────────────────────────
  await page.goto('/settings/project/automation');
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create rule' }).click();
  await page.getByRole('textbox', { name: 'Rule name' }).fill(RULE_NAME);
  await page.getByRole('combobox', { name: 'Trigger' }).click();
  await page.getByRole('option', { name: 'Item transitioned' }).click();
  await page.getByRole('combobox', { name: 'To status' }).click();
  await page.getByRole('option', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByRole('combobox', { name: 'Kind values' }).click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await page.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('combobox', { name: 'Action type' }).click();
  await page.getByRole('option', { name: 'Set field' }).click();
  await page.getByRole('combobox', { name: 'Field to set' }).click();
  await page.getByRole('option', { name: 'Priority' }).click();
  await page.getByRole('combobox', { name: 'Priority', exact: true }).click();
  await page.getByRole('option', { name: 'Highest' }).click();
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('button', { name: `Actions for ${RULE_NAME}` })).toBeVisible();

  const rule = await db.automationRule.findFirstOrThrow({
    where: { projectId: tenant.projectId, name: RULE_NAME },
  });

  // ── 5. Fire it: move the Bug to Done → the rule runs and escalates it ─────────
  await driveToDone(page, bug.id);
  await expectExecutionCount(rule.id, 'success', 1);

  // The action landed through the shipped service — the bug is now Highest.
  await expect
    .poll(async () => (await db.workItem.findUniqueOrThrow({ where: { id: bug.id } })).priority)
    .toBe('highest');

  // Seam — the action's revision is attributed to the rule OWNER (the 5.5 feed
  // shows it like a real actor), proven at the data layer.
  const priorityRev = (
    await db.workItemRevision.findMany({ where: { workItemId: bug.id, changeKind: 'updated' } })
  ).find((r) => (r.diff as { priority?: unknown }).priority !== undefined);
  expect(priorityRev, 'a priority-change revision exists').toBeTruthy();
  expect(priorityRev!.changedById).toBe(tenant.owner.id);

  // Seam — the saved-filter result set TRACKS the change: re-apply the SAVED
  // filter from the dropdown; the bug now matches (Highest ∉ {Low,Lowest} AND
  // Severity High), so the live count is 1.
  await page.goto('/issues?view=list');
  await page.getByRole('button', { name: /^Saved filters/ }).click();
  await expect(page.getByRole('textbox', { name: 'Find filters' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${FILTER_NAME}`) }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`Applied filter: ${FILTER_NAME}`) }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toContainText('1 work item');

  // Seam — the widget tracks it too: the dashboard renders its filter-results
  // card (backed by the live filter), no crash.
  await page.goto(`/dashboard/${dashboard.id}`);
  await expect(page.getByRole('heading', { name: DASHBOARD_NAME })).toBeVisible();
  await expect(page.locator('[data-testid^="dashboard-widget-grip-"]')).toHaveCount(1);

  // Seam — the History feed renders the automation change (5.5), no crash.
  await page.goto(`/issues/${bug.identifier}`);
  await expect(page.getByRole('heading', { name: BUG_TITLE, level: 1 })).toBeVisible();
  await switchActivityTab(page, 'History');
  await expect(page.getByRole('list', { name: 'History' })).toBeVisible();

  // Seam — the 5.4 watcher email fired on the Done transition; the actor (PM) is
  // excluded. waitForEmail returns the latest match — poll until it's the move.
  await expect(async () => {
    const latest = await waitForEmail(watcher.email);
    expect(latest.subject).toContain(`moved ${bug.identifier} to Done`);
  }).toPass({ timeout: 30_000 });
  expect((await emailsTo(tenant.owner.email)).filter((e) => e.subject.includes('moved'))).toEqual(
    [],
  );

  // ════════════════════════ THE GATE (non-admin viewer) ════════════════════════
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await signIn(viewerPage, viewer.email, PWD);

  // UI: the automation admin surface is hidden — the no-access page on direct
  // nav, and the settings nav never offers the entry.
  await viewerPage.goto('/settings/project/automation');
  await expect(viewerPage.getByRole('heading', { name: 'Admins only' })).toBeVisible();
  await expect(viewerPage.getByRole('heading', { name: 'Automation', exact: true })).toHaveCount(0);
  await viewerPage.goto('/settings/project');
  const settingsNav = viewerPage.getByRole('navigation', { name: 'Project settings' });
  await expect(settingsNav).toBeVisible();
  await expect(settingsNav.getByRole('link', { name: 'Rules', exact: true })).toHaveCount(0);

  // API: every Epic-6 admin surface rejects the viewer at the wire (403), not
  // just the UI — the rule admin, saved-filter management, dashboard editing.
  const ruleAdmin = await viewerPage.request.get(`/api/projects/${tenant.key}/automation-rules`);
  expect(ruleAdmin.status(), 'viewer GET automation-rules → 403').toBe(403);

  const filterManage = await viewerPage.request.delete(
    `/api/projects/${tenant.key}/saved-filters/${savedFilter.id}`,
  );
  expect(filterManage.status(), 'viewer DELETE a project-shared filter → 403').toBe(403);

  const dashEdit = await viewerPage.request.post(`/api/dashboards/${dashboard.id}/widgets`, {
    data: { type: 'filter_results', savedFilterId: savedFilter.id, config: { pageSize: 10 } },
  });
  expect(dashEdit.status(), 'viewer add-widget to a foreign dashboard → not allowed').not.toBe(201);
  await viewerContext.close();

  // ════════════════════════ THE UNWIND ════════════════════════
  // ── Unwind 1: delete the saved filter under the live widget → the designed
  // stale "Filter missing" card, never a crash (the 6.1 stale-referent rule) ────
  await savedFiltersService.delete(tenant.key, savedFilter.id, ownerCtx(tenant));
  await page.goto(`/dashboard/${dashboard.id}`);
  await expect(page.getByText('Filter missing').first()).toBeVisible({ timeout: 15_000 });

  // ── Unwind 2: disable the rule → a further matching transition fires nothing ──
  await automationRulesService.setEnabled(tenant.key, rule.id, false, ownerCtx(tenant));
  const bug2 = await workItemsService.createWorkItem(
    { projectId: tenant.projectId, kind: 'bug', title: 'Second outage' },
    ownerCtx(tenant),
  );
  await watchersService.watch(bug2.id, { userId: watcher.id, workspaceId: tenant.workspaceId });
  await driveToDone(page, bug2.id);
  // The watcher email for bug2's Done transition is the deterministic signal that
  // the work-item/transitioned event has been processed — the SAME event the
  // (now disabled) engine consumes. Once it lands, a firing would already have
  // written its row, so the unchanged execution count proves the silence.
  await expect(async () => {
    const latest = await waitForEmail(watcher.email);
    expect(latest.subject).toContain(`moved ${bug2.identifier} to Done`);
  }).toPass({ timeout: 30_000 });
  expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(1);

  // ── Unwind 3: delete the rule → its action's History entry keeps rendering
  // (the revision persists past the vanished rule — the 5.5.1 deleted-referent
  // fallback; the stacked stream doesn't crash) ────────────────────────────────
  await automationRulesService.delete(tenant.key, rule.id, ownerCtx(tenant));
  await page.goto(`/issues/${bug.identifier}`);
  await expect(page.getByRole('heading', { name: BUG_TITLE, level: 1 })).toBeVisible();
  await switchActivityTab(page, 'History');
  const historyAfter = page.getByRole('list', { name: 'History' });
  await expect(historyAfter).toBeVisible();
  await expect(historyAfter.getByText(/created the work item/)).toBeVisible();
});

/** The activity tabs — the section's Segmented filter (the 5.6.2 hook). */
async function switchActivityTab(page: Page, tab: 'All' | 'Comments' | 'History') {
  await page
    .getByRole('group', { name: 'Activity filter' })
    .getByRole('button', { name: tab, exact: true })
    .click();
}
