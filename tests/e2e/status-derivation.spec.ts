import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// E2E: bidirectional status derivation (Story MOTIR-1615 · Subtask MOTIR-1624) —
// the story's verification recipe, automated over the REAL stack (Next +
// Postgres + the Inngest dev server that runs the derivation job).
//
//   1. the SETTINGS surface — both switches ship ON, each turns off
//      independently, and the change persists across a reload;
//   2. UPWARD — a child's transition rolls its parent up all three rungs, and
//      transitively to the grandparent;
//   3. DOWNWARD — a parent set Done completes its children, including one nobody
//      started, and transitively to a grandchild;
//   4. the OFF states — each direction is suppressed by its own switch, with the
//      other still working.
//
// ── Why the waits look like this (CLAUDE.md § E2E authoritative signal) ──
// Derivation is ASYNCHRONOUS: the transition commits, emits, and the job derives
// afterwards. So there is no response to await for the DERIVED item — the
// authoritative signal is the derived row itself, polled through the DB exactly
// as the automation spec polls for its execution row. Never a sleep, and never
// an assertion against optimistic UI. The transitions that DRIVE the flow go
// through the `_test` transport, which calls the SAME shipped
// `workItemsService.updateStatus` the UI does, so the post-commit
// `work-item/transitioned` events really fire.
//
// The ladder / cascade matrix, the toggles' service semantics, and the
// termination proof live at the integration tier
// (tests/integration/workflows/*) — this spec does not re-assert them; it drives
// the user-visible journey.

const PWD = 'derivation-e2e-pass-123';
const PROJECT_NAME = 'Derivation Project';
const PROJECT_KEY = 'DERIV';

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerId: string;
  ownerEmail: string;
}

async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: ownerEmail,
    password: PWD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Derivation Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    ownerEmail,
  };
}

// ── `_test` transport (the shipped service paths — events really fire) ────────

async function createItem(
  page: Page,
  projectId: string,
  kind: string,
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind, title, ...(parentId ? { parentId } : {}) },
  });
  expect(res.status(), `create ${kind} "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

/** The detail rail's Status field card — the Pill beside the "Edit Status"
 *  chevron, scoped so an activity-log mention of the same label can't match
 *  (the github.spec precedent). */
function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

/** The authoritative signal for a DERIVED status: the row itself, polled until
 *  the async job has landed it. Never a sleep. */
async function expectDerivedStatus(id: string, status: string, what: string): Promise<void> {
  await expect
    .poll(async () => (await db.workItem.findUniqueOrThrow({ where: { id } })).status, {
      timeout: 30_000,
      message: `awaiting derived status "${status}" on ${what}`,
    })
    .toBe(status);
}

/** The negative: give the job the SAME window it would need to fire, then assert
 *  nothing moved. Without the wait a passing assertion would only prove the job
 *  had not run YET. */
async function expectStatusUnchanged(id: string, status: string, what: string): Promise<void> {
  await expect
    .poll(async () => (await db.workItem.findUniqueOrThrow({ where: { id } })).status, {
      timeout: 8_000,
      intervals: [1_000],
      message: `expecting ${what} to stay "${status}"`,
    })
    .toBe(status);
}

// ── The settings surface ─────────────────────────────────────────────────────

function rollupSwitch(page: Page) {
  return page.getByRole('switch', { name: /Roll up parent status from children/i });
}
function cascadeSwitch(page: Page) {
  return page.getByRole('switch', { name: /Complete children when a parent is done/i });
}

async function openWorkflowSettings(page: Page): Promise<void> {
  await page.goto('/settings/project/workflow');
  await expect(page.getByTestId('status-automation')).toBeVisible();
}

/** Flip a switch and SAVE, waiting on the PATCH's 200 before returning — the
 *  write must be committed before anything reads it back. */
async function setSwitches(
  page: Page,
  want: { rollup?: boolean; cascade?: boolean },
): Promise<void> {
  if (want.rollup !== undefined) {
    const s = rollupSwitch(page);
    if ((await s.getAttribute('aria-checked')) !== String(want.rollup)) await s.click();
  }
  if (want.cascade !== undefined) {
    const s = cascadeSwitch(page);
    if ((await s.getAttribute('aria-checked')) !== String(want.cascade)) await s.click();
  }
  // Arm BEFORE the click so the response can't be missed.
  const saved = page.waitForResponse(
    (r) => r.url().includes('/status-automation') && r.request().method() === 'PATCH',
  );
  await page.getByTestId('status-automation-save').click();
  expect((await saved).status()).toBe(200);
}

test.describe('bidirectional status derivation — settings, rollup, cascade', () => {
  // Argon2 sign-ins + real async job round-trips per test.
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke both switches ship ON, turn off independently, and persist across a reload', async ({
    page,
  }) => {
    const tenant = await seedTenant('deriv-settings@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    await openWorkflowSettings(page);

    // The opinion, on by default — what every project starts at.
    await expect(rollupSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(cascadeSwitch(page)).toHaveAttribute('aria-checked', 'true');
    // The consequence sentence the design makes load-bearing.
    await expect(page.getByText('This includes children nobody has started yet.')).toBeVisible();

    // The upward-only preference the two-switch model exists to express.
    await setSwitches(page, { cascade: false });

    await page.reload();
    await expect(page.getByTestId('status-automation')).toBeVisible();
    await expect(rollupSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(cascadeSwitch(page)).toHaveAttribute('aria-checked', 'false');

    // Authoritative: the column itself, not just the rendered switch.
    const project = await db.project.findUniqueOrThrow({ where: { id: tenant.projectId } });
    expect(project.autoRollupParentStatus).toBe(true);
    expect(project.autoCompleteChildrenOnParentDone).toBe(false);
  });

  test('UPWARD — a child transition rolls the parent up all three rungs, and on to the grandparent', async ({
    page,
  }) => {
    const tenant = await seedTenant('deriv-up@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    const epic = await createItem(page, tenant.projectId, 'epic', 'Epic');
    const story = await createItem(page, tenant.projectId, 'story', 'Story', epic.id);
    const a = await createItem(page, tenant.projectId, 'subtask', 'Child A', story.id);
    const b = await createItem(page, tenant.projectId, 'subtask', 'Child B', story.id);

    // Rung 1 — the first child starts.
    await transition(page, a.id, 'in_progress');
    await expectDerivedStatus(story.id, 'in_progress', 'the story');
    // …and transitively, from ONE user transition.
    await expectDerivedStatus(epic.id, 'in_progress', 'the epic (grandparent)');

    // Rung 2 — the LAST open child reaches review.
    await transition(page, b.id, 'in_progress');
    await transition(page, a.id, 'in_review');
    await transition(page, b.id, 'in_review');
    await expectDerivedStatus(story.id, 'in_review', 'the story');

    // Rung 3 — every child done.
    await transition(page, a.id, 'done');
    await transition(page, b.id, 'done');
    await expectDerivedStatus(story.id, 'done', 'the story');
    await expectDerivedStatus(epic.id, 'done', 'the epic (grandparent)');

    // Visible where the user reads it — the derived status on the story's own
    // detail rail, addressed by the identifier the create returned rather than a
    // guessed key ordinal.
    await page.goto(`/items/${story.identifier}`);
    await expect(statusCard(page)).toContainText('Done');
  });

  test('DOWNWARD — a parent set Done completes its children, including one nobody started', async ({
    page,
  }) => {
    const tenant = await seedTenant('deriv-down@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    const story = await createItem(page, tenant.projectId, 'story', 'Story');
    const task = await createItem(page, tenant.projectId, 'task', 'Mid task', story.id);
    const leaf = await createItem(page, tenant.projectId, 'subtask', 'Grandchild', task.id);

    // The parent finishes while its children are untouched — `todo`, a status no
    // legal user path can move to `done` in one hop.
    await transition(page, story.id, 'in_progress');
    await transition(page, story.id, 'done');

    await expectDerivedStatus(task.id, 'done', 'the direct child');
    // …and transitively down, by re-emission.
    await expectDerivedStatus(leaf.id, 'done', 'the grandchild');
  });

  test('the ROLLUP switch off suppresses the upward direction only', async ({ page }) => {
    const tenant = await seedTenant('deriv-off-up@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    await openWorkflowSettings(page);
    await setSwitches(page, { rollup: false, cascade: true });

    const story = await createItem(page, tenant.projectId, 'story', 'Story');
    const child = await createItem(page, tenant.projectId, 'subtask', 'Child', story.id);

    await transition(page, child.id, 'in_progress');
    await expectStatusUnchanged(story.id, 'todo', 'the story');

    // The OTHER direction still works — the switches are independent.
    const other = await createItem(page, tenant.projectId, 'story', 'Other story');
    const otherChild = await createItem(page, tenant.projectId, 'subtask', 'Kid', other.id);
    await transition(page, other.id, 'in_progress');
    await transition(page, other.id, 'done');
    await expectDerivedStatus(otherChild.id, 'done', "the other story's child");
  });

  test('the CASCADE switch off suppresses the downward direction only', async ({ page }) => {
    const tenant = await seedTenant('deriv-off-down@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    await openWorkflowSettings(page);
    await setSwitches(page, { rollup: true, cascade: false });

    const story = await createItem(page, tenant.projectId, 'story', 'Story');
    const child = await createItem(page, tenant.projectId, 'subtask', 'Child', story.id);

    await transition(page, story.id, 'in_progress');
    await transition(page, story.id, 'done');
    await expectStatusUnchanged(child.id, 'todo', 'the child');

    // The upward direction still works.
    const other = await createItem(page, tenant.projectId, 'story', 'Other story');
    const otherChild = await createItem(page, tenant.projectId, 'subtask', 'Kid', other.id);
    await transition(page, otherChild.id, 'in_progress');
    await expectDerivedStatus(other.id, 'in_progress', 'the other story');
  });
});
