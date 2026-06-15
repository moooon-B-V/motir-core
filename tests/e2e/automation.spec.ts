// E2E: Automation rules (Story 6.6 · Subtask 6.6.7) — the story-closing journey
// proven end to end over the REAL stack (Next + Postgres + the Inngest dev server
// that runs the engine job). It drives the verification recipe the story was built
// to satisfy:
//
//   1. AUTHOR a rule in the when/if/then editor (trigger config + a 6.1.4
//      condition row + a set-field action) and see it listed enabled with owner;
//   2. FIRE it from a real workflow transition → within the async window the run
//      lands a Success audit row and the action took effect; a non-matching item
//      logs No actions (the condition gated it);
//   3. a FAILURE (an illegal transition action) records a Failure row with the
//      expandable error detail;
//   4. an AUTO-DISABLED rule surfaces its banner + Re-enable, and re-enabling
//      clears it (the failure-ops UI);
//   5. a NON-ADMIN member is locked out of the whole surface (the verified Jira
//      admin-only scope — no nav entry, the no-access page on direct nav);
//   6. a11y: a strict axe sweep over the list, the editor, and the audit log.
//
// The engine matrix (every trigger × action × condition cell), the loop /
// idempotency / retention proofs, and the caps live at the integration tier
// (tests/automation/*) — this spec does NOT re-assert them; it drives the
// user-visible journey through the browser. The EPIC-wide journey (filters +
// permissions + automation firing together) stays in Story 6.7.
//
// The async wait is on the engine's WRITE (the execution row), polled through the
// DB — never a sleep (the jobs-flow.spec precedent). Firing goes through the
// `_test` transport, which calls the SAME shipped service paths the UI does
// (workItemsService.createWorkItem / updateStatus), so the post-commit
// work-item/created + work-item/transitioned events the engine consumes really
// fire. Tenant setup follows the settings-area precedent: a multi-user,
// one-workspace scenario can't be reached through sign-up (each sign-up mints its
// own workspace), so personas are seeded through the shipped services and the
// active-project pin uses the test-sanctioned BYPASSRLS DB reach.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { automationRulesService } from '@/lib/services/automationRulesService';

const PWD = 'automation-e2e-pass-123';
const PROJECT_NAME = 'Auto Project';
const PROJECT_KEY = 'AUTO';

// WCAG 2.1 Level A + AA — the same ruleset the shell + settings-area sweeps name,
// scoped explicitly so the bar can't drift when axe-core bumps.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Tenant {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerId: string;
  ownerEmail: string;
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

// An owner + workspace + one open project, owner pinned active so the
// active-project-scoped automation route resolves on every render.
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olivia Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Auto Workspace',
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
    projectKey: project.identifier,
    ownerId: owner.id,
    ownerEmail,
  };
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

// ── `_test` transport helpers (the shipped service paths — events really fire) ──

interface Created {
  id: string;
  identifier: string;
}

async function createItem(page: Page, projectId: string, kind: string, title: string) {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind, title },
  });
  expect(res.status(), `create ${kind} "${title}"`).toBe(201);
  return (await res.json()) as Created;
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

// Walk an item todo → in_progress → in_review → done (the default-workflow legal
// path). The terminal →done edge is what a "transitioned to Done" rule fires on.
async function driveToDone(page: Page, id: string): Promise<void> {
  await transition(page, id, 'in_progress');
  await transition(page, id, 'in_review');
  await transition(page, id, 'done');
}

// Poll the engine's WRITE — the execution row — rather than sleeping. Returns once
// the rule has at least `min` rows of the wanted status (the Inngest dev server has
// processed the event), or fails the spec on timeout.
async function waitForExecution(
  ruleId: string,
  status: 'success' | 'failure' | 'no_actions',
  min = 1,
): Promise<void> {
  await expect
    .poll(() => db.automationRuleExecution.count({ where: { ruleId, status } }), {
      timeout: 30_000,
      message: `awaiting ${min} ${status} execution(s) for rule ${ruleId}`,
    })
    .toBeGreaterThanOrEqual(min);
}

async function ruleIdByName(projectId: string, name: string): Promise<string> {
  const rule = await db.automationRule.findFirstOrThrow({ where: { projectId, name } });
  return rule.id;
}

// The rule list's per-row overflow → its "View log" item opens the audit log.
async function openLog(page: Page, ruleName: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${ruleName}` }).click();
  await page.getByRole('menuitem', { name: 'View log' }).click();
  await expect(page.getByRole('heading', { name: `Run history — ${ruleName}` })).toBeVisible();
}

test.describe('automation rules — author → fire → audit', () => {
  // Argon2 sign-ins + a real async engine round-trip per test — generous headroom
  // over the 30s default.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke author a transition-triggered rule, fire it, and the run audits Success — a non-matching item logs No actions', async ({
    page,
  }) => {
    const tenant = await seedTenant('auto-owner-1@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    // ── Author the rule in the editor ────────────────────────────────────────
    await page.goto('/settings/project/automation');
    await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create rule' }).click();

    await page.getByRole('textbox', { name: 'Rule name' }).fill('Prioritise resolved bugs');

    // When: item transitioned → to Done.
    await page.getByRole('combobox', { name: 'Trigger' }).click();
    await page.getByRole('option', { name: 'Item transitioned' }).click();
    await page.getByRole('combobox', { name: 'To status' }).click();
    await page.getByRole('option', { name: 'Done', exact: true }).click();

    // If: Kind is any of (Bug) — the reused 6.1.4 condition row.
    await page.getByRole('button', { name: 'Add condition' }).click();
    await page.getByRole('combobox', { name: 'Kind values' }).click();
    await page.getByRole('option', { name: 'Bug' }).click();

    // Then: set Priority = Highest.
    await page.getByRole('button', { name: 'Add action' }).click();
    await page.getByRole('combobox', { name: 'Action type' }).click();
    await page.getByRole('option', { name: 'Set field' }).click();
    await page.getByRole('combobox', { name: 'Field to set' }).click();
    await page.getByRole('option', { name: 'Priority' }).click();
    await page.getByRole('combobox', { name: 'Priority', exact: true }).click();
    await page.getByRole('option', { name: 'Highest' }).click();

    await page.getByRole('button', { name: 'Save rule' }).click();

    // Listed with the trigger summary (the per-row overflow button is the
    // toast-free anchor — `getByText(name)` also matches the success toast).
    await expect(
      page.getByRole('button', { name: 'Actions for Prioritise resolved bugs' }),
    ).toBeVisible();
    await expect(page.getByText('When transitioned')).toBeVisible();

    const ruleId = await ruleIdByName(tenant.projectId, 'Prioritise resolved bugs');

    // ── Fire it: move a Bug to Done → the rule runs and sets the priority ─────
    const bug = await createItem(page, tenant.projectId, 'bug', 'Login 500s');
    await driveToDone(page, bug.id);
    await waitForExecution(ruleId, 'success');

    const bugRow = await db.workItem.findUniqueOrThrow({ where: { id: bug.id } });
    expect(bugRow.priority).toBe('highest');

    // ── A non-matching item (a task) logs No actions (the condition gated) ────
    const task = await createItem(page, tenant.projectId, 'task', 'Update docs');
    await driveToDone(page, task.id);
    await waitForExecution(ruleId, 'no_actions');

    // ── The audit log shows both runs ────────────────────────────────────────
    await openLog(page, 'Prioritise resolved bugs');
    await expect(page.getByText('Success').first()).toBeVisible();
    await expect(page.getByText('No actions').first()).toBeVisible();
  });

  test('an illegal transition action records a Failure with expandable error detail', async ({
    page,
  }) => {
    const tenant = await seedTenant('auto-owner-2@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    await page.goto('/settings/project/automation');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await page.getByRole('textbox', { name: 'Rule name' }).fill('Force to done');
    // When: item created (the default trigger). Then: Transition → Done — illegal
    // from the initial todo, so every run is a recorded Failure.
    await page.getByRole('button', { name: 'Add action' }).click();
    await page.getByRole('combobox', { name: 'Target status' }).click();
    await page.getByRole('option', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.getByRole('button', { name: 'Actions for Force to done' })).toBeVisible();

    const ruleId = await ruleIdByName(tenant.projectId, 'Force to done');

    // Fire by creating an item (born in todo → todo→done is illegal).
    await createItem(page, tenant.projectId, 'task', 'Anything');
    await waitForExecution(ruleId, 'failure');

    await openLog(page, 'Force to done');
    await expect(page.getByText('Failure').first()).toBeVisible();
    // Expand the failure detail → the typed engine error surfaces.
    await page.getByRole('button', { name: 'Toggle error detail' }).first().click();
    await expect(page.getByText('This run failed')).toBeVisible();
  });

  test('an auto-disabled rule shows the banner; re-enabling clears it', async ({ page }) => {
    const tenant = await seedTenant('auto-owner-3@example.com');
    // Seed a rule through the shipped service, then put it in the auto-disabled
    // terminal state directly (the engine reaches it after 10 consecutive
    // failures; pinning it is the test-sanctioned BYPASSRLS reach, like the
    // settings tests pin state).
    await automationRulesService.create(
      tenant.projectKey,
      {
        name: 'Flaky rule',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'transition', toStatusId: 'done' }],
      },
      { userId: tenant.ownerId, workspaceId: tenant.workspaceId },
    );
    await db.automationRule.updateMany({
      where: { projectId: tenant.projectId, name: 'Flaky rule' },
      data: { enabled: false, consecutiveFailureCount: 10 },
    });

    await signIn(page, tenant.ownerEmail, PWD);
    await page.goto('/settings/project/automation');

    // The auto-disabled banner + the Re-enable affordance.
    await expect(
      page.getByText(/disabled automatically after 10 consecutive failures/),
    ).toBeVisible();
    const reEnable = page.getByRole('button', { name: 'Re-enable' });
    await expect(reEnable).toBeVisible();

    await reEnable.click();

    // The banner clears (the rule re-enables and its failure tally resets).
    await expect(
      page.getByText(/disabled automatically after 10 consecutive failures/),
    ).toBeHidden();
    await expect
      .poll(async () => {
        const row = await db.automationRule.findFirstOrThrow({
          where: { projectId: tenant.projectId, name: 'Flaky rule' },
        });
        return { enabled: row.enabled, count: row.consecutiveFailureCount };
      })
      .toEqual({ enabled: true, count: 0 });
  });

  test('a non-admin member is locked out of the automation surface', async ({ page }) => {
    const tenant = await seedTenant('auto-owner-4@example.com');
    // A plain workspace member (no project admin role) on the open project.
    const member = await makeUser('auto-member@example.com', 'Mary Member');
    await workspacesService.addMember({ userId: member.id, workspaceId: tenant.workspaceId });
    await pinActiveProject(member.id, tenant);

    await signIn(page, member.email, PWD);

    // Direct nav → the admin-only no-access page (the verified Jira scope).
    await page.goto('/settings/project/automation');
    await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toHaveCount(0);

    // …and the settings nav never offers the entry to a non-admin.
    await page.goto('/settings/project');
    const nav = page.getByRole('navigation', { name: 'Project settings' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Rules', exact: true })).toHaveCount(0);
  });

  test('@a11y the list, editor, and audit log are axe-clean', async ({ page }) => {
    const tenant = await seedTenant('auto-owner-5@example.com');
    // Seed a rule + one execution row so the list and log have content to audit.
    const rule = await automationRulesService.create(
      tenant.projectKey,
      {
        name: 'Audited rule',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      { userId: tenant.ownerId, workspaceId: tenant.workspaceId },
    );
    // A success row with a since-deleted (null) triggering item → the log renders
    // its tombstone state, which the sweep audits too (workItemId is SetNull on
    // delete, per the 6.6.2 schema).
    await db.automationRuleExecution.create({
      data: {
        ruleId: rule.id,
        status: 'success',
        workItemId: null,
        durationMs: 5,
        eventId: 'a11y-seed-1',
      },
    });

    // The list's last-run cell has two faint states the success row above does
    // not reach — "Never run" (no executions) and "No actions" (a no_actions
    // run). Bug 6.17: both rendered in the decorative `--el-text-faint` token and
    // failed AA color-contrast. Seed a rule for each so the `list` axe sweep
    // below actually audits them (the success row alone never did — which is how
    // the bug slipped this @a11y test and was only caught in the 6.7.3 corpus
    // sweep).
    await automationRulesService.create(
      tenant.projectKey,
      {
        name: 'Never-run rule',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      { userId: tenant.ownerId, workspaceId: tenant.workspaceId },
    );
    const noActionsRule = await automationRulesService.create(
      tenant.projectKey,
      {
        name: 'No-actions rule',
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      { userId: tenant.ownerId, workspaceId: tenant.workspaceId },
    );
    await db.automationRuleExecution.create({
      data: {
        ruleId: noActionsRule.id,
        status: 'no_actions',
        workItemId: null,
        durationMs: 2,
        eventId: 'a11y-seed-noactions',
      },
    });

    await signIn(page, tenant.ownerEmail, PWD);

    // The list — including the never-run / no-actions last-run labels (6.17).
    await page.goto('/settings/project/automation');
    await expect(page.getByText('Audited rule')).toBeVisible();
    await expect(page.getByText('Never run')).toBeVisible();
    await expect(page.getByText('No actions', { exact: false })).toBeVisible();
    await expectAxeClean(page, 'list');

    // The editor (every offered trigger/action config kind reachable; open it).
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText('When', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add action' }).click();
    await expectAxeClean(page, 'editor');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The audit log.
    await openLog(page, 'Audited rule');
    await expect(page.getByText('Success').first()).toBeVisible();
    await expectAxeClean(page, 'audit-log');
  });
});

async function expectAxeClean(page: Page, label: string): Promise<void> {
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

// Render axe violations as a readable block so a CI failure points straight at the
// rule + element (mirrors shell-a11y / settings-area).
function formatViolations(label: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${label}:\n${lines.join('\n')}`;
}
