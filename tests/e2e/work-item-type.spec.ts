// E2E: the Story-2.7 CLOSING JOURNEY (Subtask 2.7.8) — work-item TYPE +
// EXECUTOR from the user's seat. Story 2.7 promotes two pieces of planning
// metadata from prose to STRUCTURE: a leaf-only `type` (code/design/…/chore) and
// an `executor` (coding_agent | human) seeded from the type→executor default
// map. The per-piece guarantees are locked by 2.7.7's integration suite; this
// file proves the UI seams COMPOSE for a real user in one signed-in session
// against the real shell (Next + Postgres):
//
//   1. CREATE a leaf (Task) and pick `type = code` in the create modal — assert
//      the executor control SEEDED to "Coding agent" (the 2.7.3 default map).
//      Create a second leaf, pick `type = manual` — assert it seeded to "Human",
//      OVERRIDE it back to "Coding agent", assert the override sticks, create.
//      Read both back via the `_test` service route: the structured fields
//      persisted (the override too).
//   2. DETAIL rail — the first item shows the hued `code` type chip + the
//      "Coding agent" executor indicator, both inline-editable (the picker opens
//      in place).
//   3. LEAF-ONLY — open a create, switch kind to Story: the Work type control is
//      ABSENT (type is carried only on task/subtask/bug, never epic/story).
//   4. FILTER — on /issues build a `type is any of [Code]` condition over the
//      6.1.x Advanced filter: the code item is present, the manual item absent;
//      flip the value to [Manual] and assert the inverse.
//
// @smoke — exercises the create-modal picker (2.7.4) → the service seed-if-absent
// (2.7.3/2.7.5) → the detail-rail inline cells (2.7.4) → the FilterAST `type`
// facet (2.7.6). Setup mirrors epic2-acceptance: sign up through the real UI
// (auto-workspace → /dashboard), seed the project + pin it active SERVER-SIDE
// through the shipped projectsService (the one sanctioned cross-layer reach for
// tests), then drive every type/executor interaction through the UI — that is
// the surface under test. The card says "sign in as the seeded zhuyue@motir.co";
// the E2E suite truncates the DB per test (no `db:seed` tenant exists here), so
// per the established convention every spec self-seeds via signUp — the
// already-shipped test harness (ladder rung 2) over the card's prose.
//
// Known selector gotchas heeded (memory: prodect-e2e-selector-gotchas +
// new-superstring-label-breaks-getByRole): the KIND picker's accessible name is
// "Type", a SUBSTRING of the new "Work type" picker — so the kind combobox is
// matched with `exact: true` and the work-type combobox by its full name; the
// executor Segmented is a `role="group"` named "Executor" whose options are real
// buttons carrying `aria-pressed` (matched with `{ pressed }`); the detail
// FieldCard chevron's name is `Edit <label>` ("Edit Work type" / "Edit
// Executor"); the filter value control's name is `<field> values` ("Type
// values"). Type/work-type option names are the label alone (the glyph is
// aria-hidden), matched `exact` so "Code" never collides with "Content".

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  userId: string;
  workspaceId: string;
  projectId: string;
}

const CODE_TITLE = 'Build the auth API';
const MANUAL_TITLE = 'Provision the blob store';

/** Sign up (auto-workspace), create a project server-side + pin it active so the
 *  project-scoped /issues route resolves it. Mirrors epic2-acceptance's
 *  seedActiveProject. */
async function seedActiveProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Typed work',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

interface ItemRow {
  id: string;
  identifier: string;
  title: string;
}

/** Resolve a created item (id + identifier) by its title via the project list
 *  route — robust against toast overlap between two back-to-back creates. */
async function resolveByTitle(page: Page, projectId: string, title: string): Promise<ItemRow> {
  const items = (await (
    await page.request.get(`/api/_test/work-items?projectId=${projectId}`)
  ).json()) as ItemRow[];
  const found = items.find((i) => i.title === title);
  expect(found, `item "${title}" is listed`).toBeTruthy();
  return found!;
}

/** Read one work item back via the `_test` service-layer route. */
async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Open the create modal, set kind = Task + the work-type, run the per-item
 *  asserts (executor seeding/override), submit, and wait for the modal to close
 *  (the deterministic success signal — the modal unmounts only on a 2xx create). */
async function createTypedTask(
  page: Page,
  args: { title: string; workType: string; assert: () => Promise<void> },
): Promise<void> {
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByLabel('Title').fill(args.title);
  // Kind defaults to Task (a leaf) so the Work type picker is present; set it
  // explicitly anyway. `exact` — "Type" is a substring of "Work type".
  await page.getByRole('combobox', { name: 'Type', exact: true }).click();
  await page.getByRole('option', { name: 'Task', exact: true }).click();
  // Pick the work type → seeds the executor from the default map.
  await page.getByRole('combobox', { name: 'Work type' }).click();
  await page.getByRole('option', { name: args.workType, exact: true }).click();
  await args.assert();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // The modal's Create button unmounts on success → a clean signal that won't
  // collide with a lingering toast when the next create opens.
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeHidden();
}

test('@smoke Story 2.7: create typed items (default-seed + override) → detail chips → leaf-only → filter by type', async ({
  page,
}) => {
  const email = 'e2e-work-item-type@example.com';
  const seed = await seedActiveProject(page, email, 'WIT');
  await page.goto('/issues');

  // ── 1a. CREATE a `code` task — executor DEFAULT-SEEDS to "Coding agent" ──────
  await createTypedTask(page, {
    title: CODE_TITLE,
    workType: 'Code',
    assert: async () => {
      const exec = page.getByRole('group', { name: 'Executor' });
      await expect(exec).toBeVisible();
      await expect(
        exec.getByRole('button', { name: 'Coding agent', pressed: true }),
        'code seeds executor → coding_agent',
      ).toBeVisible();
    },
  });

  // ── 1b. CREATE a `manual` task — seeds "Human", then OVERRIDE to "Coding agent" ─
  await createTypedTask(page, {
    title: MANUAL_TITLE,
    workType: 'Manual',
    assert: async () => {
      const exec = page.getByRole('group', { name: 'Executor' });
      await expect(
        exec.getByRole('button', { name: 'Human', pressed: true }),
        'manual seeds executor → human',
      ).toBeVisible();
      // Override the seed — the seed is not a lock.
      await exec.getByRole('button', { name: 'Coding agent' }).click();
      await expect(
        exec.getByRole('button', { name: 'Coding agent', pressed: true }),
        'override sticks → coding_agent',
      ).toBeVisible();
      await expect(exec.getByRole('button', { name: 'Human', pressed: false })).toBeVisible();
    },
  });

  // Persistence: the structured fields landed (the override too — not the map default).
  const codeItem = await resolveByTitle(page, seed.projectId, CODE_TITLE);
  const manualItem = await resolveByTitle(page, seed.projectId, MANUAL_TITLE);
  await expect(async () => {
    const it = await getItem(page, codeItem.id);
    expect(it.type).toBe('code');
    expect(it.executor).toBe('coding_agent');
  }).toPass();
  await expect(async () => {
    const it = await getItem(page, manualItem.id);
    expect(it.type).toBe('manual');
    expect(it.executor).toBe('coding_agent'); // the override, NOT the "human" default
  }).toPass();

  // ── 2. DETAIL rail — hued chip + executor indicator render + inline-edit ─────
  await page.goto(`/issues/${codeItem.identifier}`);
  await expect(page.getByRole('heading', { name: CODE_TITLE, level: 1 })).toBeVisible();
  // The type chip and executor indicator render the labels (glyphs aria-hidden).
  await expect(page.getByText('Code', { exact: true })).toBeVisible();
  await expect(page.getByText('Coding agent', { exact: true })).toBeVisible();
  // Inline-editable: the Work type cell opens its picker in place (autoOpen).
  await page.getByRole('button', { name: 'Edit Work type' }).click();
  await expect(page.getByRole('combobox', { name: 'Work type' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Design', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // The Executor cell is editable too (its chevron is present).
  await expect(page.getByRole('button', { name: 'Edit Executor' })).toBeVisible();

  // ── 3. LEAF-ONLY — the Work type control is ABSENT for a container kind ──────
  await page.goto('/issues');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByLabel('Title').fill('A story has no work type');
  await page.getByRole('combobox', { name: 'Type', exact: true }).click();
  await page.getByRole('option', { name: 'Story', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Work type' }),
    'Work type is leaf-only — absent for a Story',
  ).toHaveCount(0);
  await page.keyboard.press('Escape'); // close the modal without creating
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeHidden();

  // ── 4. FILTER by type over the Advanced filter builder (2.7.6) ──────────────
  await page.goto('/issues?view=list');
  await expect(page.getByRole('row').filter({ hasText: CODE_TITLE })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: MANUAL_TITLE })).toBeVisible();

  await page.getByRole('button', { name: 'Advanced' }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row = dialog.getByRole('group', { name: 'Condition 1' });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Type', exact: true }).click();
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is any of', exact: true }).click();
  // Value = Code → only the code item matches.
  await row.getByRole('combobox', { name: 'Type values' }).click();
  await page.getByRole('option', { name: 'Code', exact: true }).click();
  await page.keyboard.press('Escape'); // close the listbox (not the dialog)
  await page.keyboard.press('Escape'); // close the dialog → apply
  await expect(dialog).not.toBeVisible();

  await expect(page.getByRole('row').filter({ hasText: CODE_TITLE })).toBeVisible();
  await expect(page.getByText(MANUAL_TITLE)).toHaveCount(0);

  // Flip the value to Manual → the inverse slice (toggle Code off, Manual on).
  await page.getByRole('button', { name: 'Advanced' }).click();
  await expect(dialog).toBeVisible();
  await row.getByRole('combobox', { name: 'Type values' }).click();
  await page.getByRole('option', { name: 'Code', exact: true }).click(); // deselect
  await page.getByRole('option', { name: 'Manual', exact: true }).click(); // select
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();

  await expect(page.getByRole('row').filter({ hasText: MANUAL_TITLE })).toBeVisible();
  await expect(page.getByText(CODE_TITLE)).toHaveCount(0);
});
