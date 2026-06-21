// E2E: the advanced filter builder (Story 6.1) over the real stack
// (Next + Postgres).
//
// The FIRST test (Subtask 6.1.4) is the SPOT check: build a beyond-facet
// filter, assert the live results + count + `?filter=v1:` URL round-trip, and
// verify BOTH views (List + ancestor-retaining Tree) show the same match set
// off the one compiled predicate.
//
// The remaining tests are the STORY-CLOSING recipe journey (Subtask 6.1.6),
// the browser half of the Story 6.1 verification recipe that the integration
// matrix (tests/integration/work-items/filter-builder-matrix.test.ts) proves
// at the compile layer: the mixed multi-row filter (a custom-field row + a
// label row + a negation + a relative-date window) → results + count, the
// combinator flip, the zero-results + Clear all states, the one-way facet→
// builder upgrade + superseded facet button, a fresh-context `?filter=` URL
// restore, the Tree-parity view, and the strict axe sweep over the open
// builder.
//
// Setup mirrors issue-list-flow.spec.ts: sign up through the real UI, then
// seed the project + work items server-side through the shipped services
// (custom fields / labels / due dates land via direct writes, the integration
// seed convention, since the builder reads them from the project on load).

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
}

async function seedProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Filter Builder',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: user!.id, workspaceId: ws!.id }, projectId: project.id };
}

async function mk(
  seed: Seed,
  kind: WorkItemKindDto,
  title: string,
  parentId?: string,
  extra?: { priority?: WorkItemPriorityDto },
): Promise<{ id: string; title: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null, ...extra },
    seed.ctx,
  );
  return { id: dto.id, title: dto.title };
}

test('build a beyond-facet filter → live results + count + URL round-trip + Tree parity', async ({
  page,
}) => {
  const seed = await seedProject(page, 'builder@e2e.test', 'FLT');
  // An epic parent whose CHILDREN match (ancestor retention), plus noise.
  const epic = await mk(seed, 'epic', 'Auth epic');
  await mk(seed, 'bug', 'OAuth callback drops state', epic.id, { priority: 'high' });
  await mk(seed, 'bug', 'OAuth token refresh loops', epic.id, { priority: 'medium' });
  await mk(seed, 'bug', 'Lowest-priority oauth nit', epic.id, { priority: 'lowest' });
  await mk(seed, 'task', 'OAuth docs page', epic.id, { priority: 'high' });
  await mk(seed, 'story', 'Unrelated story');

  // ── Build in the LIST view: Kind any of (Bug) AND Priority none of (Lowest)
  //    AND Text contains "oauth" — negation = beyond facet expressiveness.
  await page.goto('/items?view=list');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();

  // Row 1 — the default Kind row; pick Bug.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await dialog.getByRole('combobox', { name: 'Kind values' }).click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await expect(dialog, 'dialog survives the live-apply push').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog, 'Esc closes only the value listbox, not the builder').toBeVisible();

  // Row 2 — Priority · is none of · Lowest.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row2 = dialog.getByRole('group', { name: 'Condition 2' });
  await row2.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Priority' }).click();
  await row2.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is none of' }).click();
  await row2.getByRole('combobox', { name: 'Priority values' }).click();
  await page.getByRole('option', { name: 'Lowest' }).click();
  await page.keyboard.press('Escape');

  // Row 3 — Text · contains · oauth.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row3 = dialog.getByRole('group', { name: 'Condition 3' });
  await row3.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Text title + description' }).click();
  await row3.getByRole('textbox', { name: 'Text values' }).fill('oauth');

  // Live-applied (the text row debounces 300ms): the URL carries the exact
  // versioned encoding of all three conditions — the codec round-trip.
  const expectedAst: FilterAst = {
    combinator: 'and',
    conditions: [
      { field: 'kind', operator: 'is_any_of', value: ['bug'] },
      { field: 'priority', operator: 'is_none_of', value: ['lowest'] },
      { field: 'text', operator: 'contains', value: 'oauth' },
    ],
  };
  const expectedParam = encodeURIComponent(encodeFilterParam(expectedAst));
  await expect(page).toHaveURL(new RegExp(expectedParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Advanced filter' })).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '2 work items match',
  );
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth callback drops state' }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth token refresh loops' }),
  ).toBeVisible();
  await expect(page.getByText('Lowest-priority oauth nit')).toHaveCount(0);
  await expect(page.getByText('OAuth docs page')).toHaveCount(0);

  // The facet [Filter] button is SUPERSEDED (negation can't down-convert).
  await expect(page.getByLabel('Managed in Advanced')).toBeVisible();

  // The applied summary chips render the conditions read-only.
  await expect(page.getByText('is none of Lowest')).toBeVisible();

  // ── URL round-trip: reload restores builder state + results.
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '2 work items match',
  );
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Advanced filter' })
      .getByRole('group', { name: 'Condition 3' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // ── Tree parity: the same compiled predicate, ancestor-retaining — the two
  //    matching bugs render UNDER their (muted, non-matching) epic ancestor.
  await page.getByRole('button', { name: /^View: / }).click();
  await page.getByRole('menuitemradio', { name: 'Tree' }).click();
  await expect(page).toHaveURL(/filter=v1%3A|filter=v1:/);
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '2 work items match',
  );
  // Row-level hasText (the issue-list-flow convention — the flexing title
  // column truncates at the test viewport, so per-text visibility is flaky).
  await expect(page.getByRole('row').filter({ hasText: 'Auth epic' })).toBeVisible(); // retained ancestor
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth callback drops state' }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth token refresh loops' }),
  ).toBeVisible();
  await expect(page.getByText('Lowest-priority oauth nit')).toHaveCount(0);
  await expect(page.getByText('Unrelated story')).toHaveCount(0);
});

// ── the 6.1.6 recipe seed: an epic of issues spanning kind / priority / a
//    select custom field / a label / a due date — enough that the mixed AND
//    filter resolves to exactly one row. CF + labels + due dates land via
//    direct writes (the project reads them on load).
interface RecipeSeed extends Seed {
  ids: { epic: string; b1: string; b2: string; b3: string; task: string; story: string };
}

async function seedRecipe(page: Page, email: string): Promise<RecipeSeed> {
  const seed = await seedProject(page, email, 'REC');
  const epic = await mk(seed, 'epic', 'Auth epic');
  const b1 = await mk(seed, 'bug', 'OAuth callback drops state', epic.id, { priority: 'high' });
  const b2 = await mk(seed, 'bug', 'OAuth token refresh loops', epic.id, { priority: 'medium' });
  const b3 = await mk(seed, 'bug', 'Lowest-priority oauth nit', epic.id, { priority: 'lowest' });
  const task = await mk(seed, 'task', 'OAuth docs page', epic.id, { priority: 'high' });
  const story = await mk(seed, 'story', 'Unrelated story');

  const common = { workspaceId: seed.ctx.workspaceId, projectId: seed.projectId };
  const severity = await db.customFieldDefinition.create({
    data: { ...common, key: 'severity', label: 'Severity', fieldType: 'select', position: 'a0' },
  });
  const high = await db.customFieldOption.create({
    data: { fieldId: severity.id, label: 'High', position: 'a0' },
  });
  await db.customFieldOption.create({
    data: { fieldId: severity.id, label: 'Low', position: 'a1' },
  });
  await db.customFieldValue.create({
    data: {
      workspaceId: seed.ctx.workspaceId,
      workItemId: b1.id,
      fieldId: severity.id,
      valueOptionId: high.id,
    },
  });

  const perf = await db.label.create({
    data: { ...common, name: 'perf-q3', nameLower: 'perf-q3' },
  });
  await db.workItemLabel.createMany({
    data: [
      { workItemId: b1.id, labelId: perf.id },
      { workItemId: task.id, labelId: perf.id },
    ],
  });

  const due = new Date(Date.now() + 5 * 86_400_000);
  await db.workItem.updateMany({
    where: { id: { in: [b1.id, b2.id, task.id] } },
    data: { dueDate: due },
  });

  return {
    ...seed,
    ids: {
      epic: epic.id,
      b1: b1.id,
      b2: b2.id,
      b3: b3.id,
      task: task.id,
      story: story.id,
    },
  };
}

/** Add a condition row, then set its field — the builder renders the registry,
 * so a row is field-picker → operator-picker → value-editor. */
async function setField(dialog: ReturnType<Page['getByRole']>, n: number, field: string) {
  const row = dialog.getByRole('group', { name: `Condition ${n}` });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await dialog.page().getByRole('option', { name: field, exact: true }).click();
  return row;
}

test('the recipe: a custom-field + label + negation + relative-date filter → one match, axe-clean, fresh-context restore, Tree parity', async ({
  page,
  browser,
}) => {
  const email = 'recipe@e2e.test';
  await seedRecipe(page, email);

  await page.goto('/items?view=list');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();

  // Row 1 — Kind is any of (Bug) — the default kind row.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await dialog.getByRole('combobox', { name: 'Kind values' }).click();
  await page.getByRole('option', { name: 'Bug', exact: true }).click();
  await page.keyboard.press('Escape');

  // Row 2 — a CUSTOM-FIELD row: Severity is any of (High).
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await setField(dialog, 2, 'Severity');
  await dialog.getByRole('combobox', { name: 'Severity values' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.keyboard.press('Escape');

  // Row 3 — a LABEL row: Label is any of (perf-q3) — the bounded autocomplete.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await setField(dialog, 3, 'Label');
  await dialog.getByRole('combobox', { name: 'Label values' }).click();
  await page.getByRole('option', { name: 'perf-q3', exact: true }).click();
  await page.keyboard.press('Escape');

  // Row 4 — a RELATIVE-DATE row: Due in the next 30 days.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row4 = await setField(dialog, 4, 'Due');
  await row4.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'in the next' }).click();
  await row4.getByRole('textbox', { name: 'Day count' }).fill('30');

  // Row 5 — a NEGATION row: Priority is none of (Lowest).
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row5 = await setField(dialog, 5, 'Priority');
  await row5.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is none of' }).click();
  await row5.getByRole('combobox', { name: 'Priority values' }).click();
  await page.getByRole('option', { name: 'Lowest', exact: true }).click();
  await page.keyboard.press('Escape');

  // The strict axe sweep over the OPEN builder (every editor kind present:
  // enum picker, CF picker, label picker, day-count input, negation picker).
  const builderResults = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include('[role="dialog"]')
    .analyze();
  expect(builderResults.violations, JSON.stringify(builderResults.violations, null, 2)).toEqual([]);

  // AND of all five rows resolves to exactly the one bug that carries them all.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '1 work item matches',
  );
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth callback drops state' }),
  ).toBeVisible();
  await expect(page.getByText('OAuth token refresh loops')).toHaveCount(0);
  await expect(page.getByText('OAuth docs page')).toHaveCount(0);
  await expect(page.getByText('Lowest-priority oauth nit')).toHaveCount(0);

  // The facet button is SUPERSEDED — the AST (CF rows, negation) can't
  // down-convert into the quick facet bar.
  await expect(page.getByLabel('Managed in Advanced')).toBeVisible();

  // Fresh-context URL round-trip: a NEW signed-in browser opening the shared
  // `?filter=v1:` URL restores the exact result + builder state.
  const sharedUrl = page.url();
  expect(sharedUrl).toContain('filter=v1');
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await signIn(page2, email, SHELL_PASSWORD);
  await page2.goto(sharedUrl);
  await expect(page2.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '1 work item matches',
  );
  await page2.getByRole('button', { name: /^Advanced/ }).click();
  await expect(
    page2
      .getByRole('dialog', { name: 'Advanced filter' })
      .getByRole('group', { name: 'Condition 5' }),
  ).toBeVisible();
  await ctx2.close();

  // Tree parity: the same compiled predicate, ancestor-retaining — the one
  // matching bug renders under its (muted, non-matching) epic ancestor.
  await page.getByRole('button', { name: /^View: / }).click();
  await page.getByRole('menuitemradio', { name: 'Tree' }).click();
  await expect(page).toHaveURL(/filter=v1/);
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '1 work item matches',
  );
  await expect(page.getByRole('row').filter({ hasText: 'Auth epic' })).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth callback drops state' }),
  ).toBeVisible();
  await expect(page.getByText('OAuth token refresh loops')).toHaveCount(0);
});

test('the combinator flip widens the set; the zero-results + Clear all states resolve', async ({
  page,
}) => {
  await seedRecipe(page, 'combinator@e2e.test');

  await page.goto('/items?view=list');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();

  // Two kind rows on the SAME field — an issue is exactly one kind, so
  // "Match all (Story AND Bug)" is impossible → the zero-results state.
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  await dialog.getByRole('combobox', { name: 'Kind values' }).click();
  await page.getByRole('option', { name: 'Story', exact: true }).click();
  await page.keyboard.press('Escape');

  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row2 = await setField(dialog, 2, 'Kind');
  await row2.getByRole('combobox', { name: 'Kind values' }).click();
  await page.getByRole('option', { name: 'Bug', exact: true }).click();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('No work items match this filter')).toBeVisible();

  // Flip the combinator to "Match any" → Story OR Bug → the 1 story + 3 bugs.
  // The Segmented combinator is a labelled group of toggle BUTTONS ("all" /
  // "any"), not radios.
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await dialog.getByRole('button', { name: 'any', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '4 work items match',
  );

  // Clear all → the filter is dropped and the full project list returns.
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await dialog.getByRole('button', { name: 'Clear all' }).click();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/filter=v1/);
  await expect(page.getByRole('row').filter({ hasText: 'Unrelated story' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Auth epic' })).toBeVisible();
});

test('the facet state upgrades losslessly into builder rows (one-way "Edit in Advanced")', async ({
  page,
}) => {
  await seedRecipe(page, 'upgrade@e2e.test');

  await page.goto('/items?view=list');
  // Build a quick FACET first: Kind = Bug → the 3 bugs render (the count-line
  // status is an ADVANCED-filter element, so it isn't shown for facets alone).
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('listbox', { name: 'Kind' }).getByRole('option', { name: 'Bug' }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'OAuth callback drops state' }),
  ).toBeVisible();
  await expect(page.getByText('Unrelated story')).toHaveCount(0);

  // "Edit in Advanced" (the facet popover footer) carries the facet in as a
  // Kind row — LOSSLESS: the facet params swap for the `?filter=v1:` AST and
  // the result set is unchanged (now an ADVANCED filter, so the count-line
  // status renders, at the same 3).
  await page.getByRole('button', { name: 'Edit in Advanced' }).click();
  await expect(page).toHaveURL(/filter=v1/);
  await expect(page.getByRole('status').filter({ hasText: 'match' })).toHaveText(
    '3 work items match',
  );

  // The carried row is in the builder. Reload for a deterministically-closed
  // builder (the upgrade's auto-open races the navigation), then open it from
  // the restored URL and confirm the Kind row is present.
  await page.reload();
  await page.getByRole('button', { name: /^Advanced/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('group', { name: 'Condition 1' }).getByRole('combobox', { name: 'Field' }),
  ).toContainText('Kind');

  // Add a negation row — now the builder state is beyond facet expressiveness,
  // so the facet button reads as superseded (no silent down-conversion).
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row2 = await setField(dialog, 2, 'Priority');
  await row2.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is none of' }).click();
  await row2.getByRole('combobox', { name: 'Priority values' }).click();
  await page.getByRole('option', { name: 'Lowest', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Managed in Advanced')).toBeVisible();
});
