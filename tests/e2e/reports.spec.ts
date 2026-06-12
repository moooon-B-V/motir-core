// E2E: reports (Story 6.3 · Subtask 6.3.7) — the story-closing journey over the
// real stack (Next + Postgres), the Playwright half of Principle #18's
// Story-level review. The created-vs-resolved bucket matrix (day/week/month ×
// cumulative × reopen-net × window edges), the registry-driven statistic
// matrix, and the per-VIEWER gating are asserted exhaustively at the
// integration tier (tests/integration/reports/*.test.ts) — this spec does NOT
// re-assert those predicates. It drives the user-visible reports journey the
// Story 6.3 verification recipe calls out, through the browser:
//
//   A. the HUB lists the agile group (links into the shipped sprint surfaces)
//      + the analysis group, and opens both report pages;
//   B. CREATED VS RESOLVED — the difference/area chart + the URL-driven controls
//      (scope · period · days-back · cumulative); resolving an issue ticks the
//      resolved series up, reopening it nets back down (the done-predicate, live
//      through the page read);
//   C. STATUS DISTRIBUTION — the donut + legend track the statistic-type picker;
//   D. a11y — the strict WCAG sweep over both report pages.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { createTestWorkItem, makeWorkItemFixture, TEST_PASSWORD } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { Prisma } from '@prisma/client';

test.describe.configure({ timeout: 90_000 });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const HIGH_PRIORITY_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

let seq = 0;

interface Tenant {
  fx: WorkItemFixture;
  ownerEmail: string;
  /** A work item already resolved in-window (reopen target). */
  resolvedItemId: string;
  /** A work item still open in-window (resolve target). */
  openItemId: string;
}

/** Owner workspace + project (active pinned) + a saved filter + several issues
 * created in-window, exactly TWO resolved (a `todo → done` revision in-window).
 * Returns one resolved + one still-open item id for the live resolve/reopen. */
async function seedTenant(): Promise<Tenant> {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: `RP${seq}` });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: fx.ownerId, workspaceId: fx.workspaceId } },
    data: { activeProjectId: fx.projectId },
  });
  await savedFiltersService.create(
    fx.projectIdentifier,
    {
      name: 'High priority',
      visibility: 'project',
      filterParam: encodeFilterParam(HIGH_PRIORITY_AST),
    },
    fx.ctx,
  );

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const item = await createTestWorkItem(fx, { kind: 'task', title: `Report item ${i}` });
    await db.workItem.update({ where: { id: item.id }, data: { createdAt: daysAgo(2) } });
    ids.push(item.id);
  }
  // Resolve the first two (a done-category transition one day ago).
  await resolve(ids[0]!, fx.ownerId);
  await resolve(ids[1]!, fx.ownerId);

  return { fx, ownerEmail: fx.owner.email, resolvedItemId: ids[0]!, openItemId: ids[2]! };
}

/** Record a `todo → done` transition revision (a resolution) at the given age. */
async function resolve(workItemId: string, byId: string, age = 1): Promise<void> {
  await transition(workItemId, byId, 'todo', 'done', age);
}
/** Record a `done → todo` transition revision (a reopen). */
async function reopen(workItemId: string, byId: string, age = 1): Promise<void> {
  await transition(workItemId, byId, 'done', 'todo', age);
}
async function transition(
  workItemId: string,
  byId: string,
  from: string,
  to: string,
  age: number,
): Promise<void> {
  await db.workItemRevision.create({
    data: {
      workItemId,
      changedById: byId,
      changeKind: 'updated',
      changedAt: daysAgo(age),
      diff: { status: { from, to } } as Prisma.InputJsonValue,
    },
  });
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('reports @smoke', () => {
  test('A — the hub lists both groups and opens both report pages', async ({ page }) => {
    const t = await seedTenant();
    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();

    // Agile group — link cards into the shipped surfaces (never redrawn here).
    await expect(page.getByText('Burndown chart')).toBeVisible();
    await expect(page.getByText('Velocity chart')).toBeVisible();
    // Analysis group — the two report pages this story builds.
    await expect(page.getByRole('link', { name: /Created vs Resolved/ })).toBeVisible();

    // Open Created vs Resolved.
    await page.getByRole('link', { name: /Created vs Resolved/ }).click();
    await page.waitForURL(/\/reports\/created-vs-resolved/);
    await expect(page.getByRole('heading', { name: 'Created vs Resolved' })).toBeVisible();

    // Back to the hub, open Status distribution.
    await page.getByRole('link', { name: 'Reports' }).first().click();
    await page.waitForURL(/\/reports$/);
    await page.getByRole('link', { name: /Status distribution/ }).click();
    await page.waitForURL(/\/reports\/distribution/);
    await expect(page.getByRole('heading', { name: 'Status distribution' })).toBeVisible();
  });

  test('B — created vs resolved: chart + controls, and a resolution ticks the series up then nets back on reopen', async ({
    page,
  }) => {
    const t = await seedTenant();
    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    await page.goto('/reports/created-vs-resolved');
    await expect(page.getByRole('heading', { name: 'Created vs Resolved' })).toBeVisible();

    // The legend carries the totals as TEXT (colour never the sole signal):
    // 5 created, 2 resolved from the seed.
    await expect(page.getByText('Created · 5 total')).toBeVisible();
    await expect(page.getByText('Resolved · 2 total')).toBeVisible();

    // Controls drive the URL (a configured report is shareable).
    await page.getByRole('button', { name: 'Weekly' }).click();
    await page.waitForURL(/period=week/);
    await page.getByRole('button', { name: 'Cumulative', exact: true }).click();
    await page.waitForURL(/cumulative=true/);
    // Reset period back to Daily so the per-period totals stay legible.
    await page.getByRole('button', { name: 'Daily' }).click();
    await page.getByRole('button', { name: 'Per period' }).click();
    await page.waitForURL((u) => !u.search.includes('cumulative=true'));

    // Resolve a third issue (a real revision) → reload → the series ticks up.
    await resolve(t.openItemId, t.fx.ownerId);
    await page.reload();
    await expect(page.getByText('Resolved · 3 total')).toBeVisible();

    // Reopen one (done → todo in-window) → reload → the NET count drops back.
    await reopen(t.resolvedItemId, t.fx.ownerId);
    await page.reload();
    await expect(page.getByText('Resolved · 2 total')).toBeVisible();
  });

  test('C — status distribution: the donut + legend track the statistic-type picker', async ({
    page,
  }) => {
    const t = await seedTenant();
    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    await page.goto('/reports/distribution');
    await expect(page.getByRole('heading', { name: 'Status distribution' })).toBeVisible();

    // The donut renders (5 issues → a non-empty chart, exposed as a labelled img).
    await expect(page.getByRole('img', { name: 'Status distribution' })).toBeVisible({
      timeout: 15_000,
    });

    // Switching the statistic re-scopes the read through the URL.
    await page.getByRole('combobox', { name: 'Statistic type' }).click();
    await page.getByRole('option', { name: 'Priority' }).click();
    await page.waitForURL(/statistic=priority/);
    await expect(page.getByRole('img', { name: 'Status distribution' })).toBeVisible();
  });

  test('D — a11y: both report pages pass the strict axe sweep', async ({ page }) => {
    const t = await seedTenant();
    await signIn(page, t.ownerEmail, TEST_PASSWORD);

    await sweep(page, '/reports/created-vs-resolved', 'Created vs Resolved');
    await sweep(page, '/reports/distribution', 'Status distribution');
  });
});

async function sweep(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  // Settle the chart (it mounts client-side) before auditing.
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
}
