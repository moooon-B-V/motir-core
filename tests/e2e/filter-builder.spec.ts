// E2E: the advanced filter builder (Story 6.1 · Subtask 6.1.4) — the SPOT
// check over the real stack (Next + Postgres): build a beyond-facet filter in
// the builder, assert the live results + count + `?filter=v1:` URL round-trip,
// and verify BOTH views (List + ancestor-retaining Tree) show the same match
// set off the one compiled predicate. The full recipe journey (Epic-5 rows,
// facet upgrade, zero-results, fresh-context URL restore, the strict axe
// sweep) is Subtask 6.1.6's remit and GROWS this file — don't duplicate it
// there.
//
// Setup mirrors issue-list-flow.spec.ts: sign up through the real UI, then
// seed the project + work items server-side through the shipped services.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';

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
  await page.goto('/issues?view=list');
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
