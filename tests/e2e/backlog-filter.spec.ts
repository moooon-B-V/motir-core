// E2E: backlog filtering — the Story-8.8 closing journey (Subtask 8.8.18).
//
// @smoke — proves the backlog's once-dead `[Filter]` seam is now the SAME shipped
// /issues filter primitives, backlog-scoped (exactly as the board did, 6.15.3). A
// signed-in user on `/backlog` opens the toolbar Filter, narrows by a quick KIND
// facet, and BOTH regions re-project: the backlog region AND the sprint container
// (the sprint read became filter-aware in 8.8.20). The active filter rides the
// URL so it survives a reload; a no-match filter shows the distinct filtered-empty
// state; "View all work items" carries the active filter into the navigator.
//
// Assertions wait on the authoritative `/api/backlog` re-projection RESPONSE (its
// filter param), never the optimistic popover (CLAUDE.md). The filtered-read
// matrix (predicate · count · cursor · 422 · keeps-done) is proven at the
// integration tier (tests/integration/sprints/sprint-filter.test.ts +
// backlog/filter.test.ts); the backlog buildHref + the enabled seam at the unit
// tier (tests/backlog/backlog-filter-href.test.ts + tests/components/
// backlog-filter.test.tsx). This spec proves them composed over the real stack.
//
// Mirrors backlog.spec.ts's setup: in-process seeding through the shipped services
// (the sanctioned cross-layer reach for E2E setup), the project pinned active.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKind } from '@prisma/client';

const PASSWORD = 'backlog-filter-e2e-9';
const OWNER = 'e2e-backlog-filter-owner@motir.dev';
const BACKLOG_LIST = 'Backlog work items'; // backlogListLabel — the bottom region's <ul>
const SPRINT_NAME = 'Sprint Alpha';

// Backlog cards span kinds so a KIND facet narrows to a DISTINCT result: only
// B-BUG is a bug in the backlog; only S-BUG is a bug in the sprint.
const B_BUG = 'Backlog bug card';
const B_STORY = 'Backlog story card';
const B_TASK = 'Backlog task card';
const S_BUG = 'Sprint bug card';
const S_STORY = 'Sprint story card';

interface Seed {
  sprintId: string;
}

async function seedIssue(
  ctx: ServiceContext,
  projectId: string,
  kind: WorkItemKind,
  title: string,
  sprintId?: string,
): Promise<void> {
  await backlogService.createBacklogIssue(
    projectId,
    { kind, title, sprintId: sprintId ?? null },
    ctx,
  );
}

/** A signed-in-able tenant with one active project, a sprint of 2 (bug+story),
 *  and a backlog of 3 (bug+story+task) — each through the shipped service so it
 *  gets a real backlog_rank (the backlog.spec.ts seeding convention). */
async function seedTenant(): Promise<Seed> {
  const owner = await usersService.createUser({ email: OWNER, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Backlog Filter E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Filtered',
    identifier: 'FBK',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  const sprint = await sprintsService.createSprint(project.id, { name: SPRINT_NAME }, ctx);
  // Sprint set (bug + story) — proves the sprint container re-projects (8.8.20).
  await seedIssue(ctx, project.id, 'bug', S_BUG, sprint.id);
  await seedIssue(ctx, project.id, 'story', S_STORY, sprint.id);
  // Backlog set (bug + story + task).
  await seedIssue(ctx, project.id, 'bug', B_BUG);
  await seedIssue(ctx, project.id, 'story', B_STORY);
  await seedIssue(ctx, project.id, 'task', B_TASK);
  return { sprintId: sprint.id };
}

/** A `/api/backlog` GET response matcher keyed on whether the kind facet rode it. */
function backlogGet(filtered: boolean) {
  return (r: { request(): { method(): string }; url(): string }) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    if (u.pathname !== '/api/backlog') return false;
    return filtered ? u.searchParams.has('kind') : !u.searchParams.has('kind');
  };
}

const backlogList = (page: Page) => page.getByRole('list', { name: BACKLOG_LIST });
const sprintList = (page: Page) => page.getByRole('list', { name: `${SPRINT_NAME} work items` });

test.describe.configure({ timeout: 120_000 });

test.describe('backlog filtering (Story 8.8.18)', () => {
  let seed: Seed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedTenant();
  });

  test('@smoke narrows BOTH regions by a kind facet; URL + reload + filtered-empty + view-all', async ({
    page,
  }) => {
    await signIn(page, OWNER, PASSWORD);
    await page.goto('/backlog');

    // Baseline — the full backlog (3 cards) and the sprint (2 cards) render.
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: 30_000 });
    for (const title of [B_BUG, B_STORY, B_TASK]) {
      await expect(backlogList(page).getByText(title)).toBeVisible();
    }
    await expect(sprintList(page).getByText(S_BUG)).toBeVisible();
    await expect(sprintList(page).getByText(S_STORY)).toBeVisible();
    // The sprint count badge starts at its full committed count (2).
    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('2');

    // The quick popover is CLOSED — its facet listboxes are not mounted.
    await expect(page.getByRole('listbox', { name: 'Kind' })).toHaveCount(0);

    // KIND = Bug → the backlog re-projects (assert on the filtered RESPONSE), and
    // both regions narrow to their bug card; the non-matching cards leave the DOM.
    const resP = page.waitForResponse(backlogGet(true));
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('listbox', { name: 'Kind' })
      .getByRole('option', { name: 'Bug' })
      .click();
    expect((await resP).ok(), 'filtered backlog re-projection').toBe(true);

    await expect(page).toHaveURL(/kind=bug/);
    await expect(backlogList(page).getByText(B_BUG)).toBeVisible();
    await expect(backlogList(page).getByText(B_STORY)).toHaveCount(0);
    await expect(backlogList(page).getByText(B_TASK)).toHaveCount(0);
    // The sprint container re-projects too (8.8.20): only its bug; badge = 1 of 2.
    await expect(sprintList(page).getByText(S_BUG)).toBeVisible();
    await expect(sprintList(page).getByText(S_STORY)).toHaveCount(0);
    await expect(page.getByTestId(`sprint-count-${seed.sprintId}`)).toHaveText('1 of 2');

    // "View all work items" carries the active filter into the navigator.
    await expect(page.getByRole('link', { name: 'View all work items' })).toHaveAttribute(
      'href',
      /kind=bug/,
    );

    // RELOAD — the filter rides the URL, so both regions re-project to it.
    const reloadP = page.waitForResponse(backlogGet(true));
    await page.reload();
    expect((await reloadP).ok()).toBe(true);
    await expect(page).toHaveURL(/kind=bug/);
    await expect(backlogList(page).getByText(B_BUG)).toBeVisible();
    await expect(backlogList(page).getByText(B_STORY)).toHaveCount(0);

    // FILTERED-EMPTY — narrow the text to something nothing matches → the distinct
    // filtered-empty state (NOT the brand-new-backlog create prompt).
    await page.goto('/backlog?q=zzz-nothing-matches-this');
    await expect(page.getByTestId('backlog-filtered-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No work items match this filter')).toBeVisible();
    // Clear filter returns to the bare /backlog.
    await page.getByRole('link', { name: 'Clear filter' }).click();
    await expect(page).toHaveURL(/\/backlog$/);
    await expect(backlogList(page).getByText(B_STORY)).toBeVisible();
  });
});
