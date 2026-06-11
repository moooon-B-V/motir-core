// E2E: the Story-7.0 ready / dispatch surface (Subtask 7.0.8), driving the real
// shell. Closes the agent-dispatch promise from the user's seat — everything the
// `/ready` page (7.0.6) projects from `workItemsService.listReady` + `countReady`
// and the per-row "Copy `motir run`" affordance the BYOK CLI flow depends on:
//
//   - the sidebar "Ready" entry (between Issues and Boards) + its live count badge;
//   - the flat dispatch list, ordered `(type asc, priority desc, key asc)` —
//     type leads, priority orders within a type bucket (7.0.12). The seeded
//     ready items are all the same type (`task`), so the first row carries the
//     HIGHEST priority within that bucket (sort correctness from a user's seat;
//     7.0.10 leaf-only + 7.0.11/7.0.12 type-primary already shipped, so a childed
//     container never appears);
//   - the per-row copy affordance → the exact `motir run PROD-<n>` command on the
//     clipboard + the "Copied" toast;
//   - the row → peek interaction (the shipped IssueQuickView, NOT a full-page nav);
//   - the LIVE recompute: marking a blocked item's only blocker done makes it
//     appear AND increments the sidebar badge (the ReadinessBadge per-project
//     terminal classification, 2.4.5 / finding #21, projected as a list);
//   - the workspace-membership gate: /ready is NOT PM-only — a plain member sees it.
//
// @smoke — exercises the UI↔service seam structural unit tests can't: the Server
// Component read → the virtualized client list → the copy/toast/peek client
// interactions → the layout's count-badge plumbing re-rendering on reload.
//
// Setup uses ONLY auth (the shell `signIn` helper) + the 2.2.7 `_test` harness
// (work-items / work-item-links create + the gated `?status=` transition), built
// through the OWNER's API session before the browser signs in — the same
// seed-then-`signIn` shape the board-at-scale specs use. The member-access check
// is its OWN test (a fresh browser context) so neither journey shares page state.
// The empty-state branch is covered in vitest (7.0.7); standing up an empty-ready
// tenant in Playwright is more setup than the value warrants (per the 7.0.8 card).

import { expect, test, type APIRequestContext } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { signUp as apiSignUp, createProject, transition, linkBlockedBy } from './_helpers/workflow';
import { TEST_PASSWORD, BASE_URL, type TestUser } from './_helpers/work-item-setup';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces/middleware';
import { workspacesService } from '@/lib/services/workspacesService';

// Fixture build (API sign-up + project create + a handful of work items over the
// `_test` route) runs before the browser journey; 90s is generous headroom over
// the default 30s, matching the other multi-step shell specs.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Created {
  id: string;
  identifier: string;
  title: string;
}

interface ReadyTenant {
  owner: TestUser;
  member: TestUser;
  project: { id: string; identifier: string };
  aHigh: Created;
  blocked: Created;
  blocker: Created;
}

/** Create a work item through the `_test` route with an explicit kind+priority. */
async function mk(
  ctx: APIRequestContext,
  projectId: string,
  opts: { title: string; kind?: string; priority?: string },
): Promise<Created> {
  const res = await ctx.post('/api/_test/work-items', {
    data: { projectId, kind: opts.kind ?? 'task', title: opts.title, priority: opts.priority },
  });
  expect(res.status(), `create "${opts.title}"`).toBe(201);
  const dto = (await res.json()) as { id: string; identifier: string };
  return { id: dto.id, identifier: dto.identifier, title: opts.title };
}

/**
 * Seed a fresh single-project tenant with a deterministic ready set, built over
 * the OWNER's API session (before any browser sign-in). Three leaf tasks are
 * immediately ready (todo, no blockers); a fourth is blocked by a fifth that we
 * park IN_PROGRESS so the blocker itself stays OUT of the ready set (only `todo`
 * items are ready). That makes the later "mark the blocker done" flip a strict
 * +1 to the count — the blocker never counted, so the formerly-blocked item is a
 * net increment, not a swap. A second user is added as a plain MEMBER (not the PM)
 * for the membership-gate test. Initial ready set = the 3 leaf todos.
 */
async function seedReadyTenant(): Promise<ReadyTenant> {
  const owner = await apiSignUp('e2e-ready-owner@example.com');
  const project = await createProject(owner, 'Ready Flow', 'RDY');
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.userId, workspaceId: owner.workspaceId } },
    data: { activeProjectId: project.id },
  });

  const aHigh = await mk(owner.ctx, project.id, { title: 'Highest leaf', priority: 'highest' });
  await mk(owner.ctx, project.id, { title: 'Medium leaf', priority: 'medium' });
  await mk(owner.ctx, project.id, { title: 'Low leaf', priority: 'low' });
  const blocker = await mk(owner.ctx, project.id, { title: 'The blocker', priority: 'lowest' });
  const blocked = await mk(owner.ctx, project.id, {
    title: 'Blocked until blocker done',
    priority: 'high',
  });
  await linkBlockedBy(owner.ctx, blocked.id, blocker.id);
  expect((await transition(owner.ctx, blocker.id, 'in_progress')).status()).toBe(200);

  const member = await apiSignUp('e2e-ready-member@example.com');
  await workspacesService.addMember({ userId: member.userId, workspaceId: owner.workspaceId });

  return { owner, member, project, aHigh, blocked, blocker };
}

test('@smoke /ready: badge · highest-first sort · copy command · peek · live recompute', async ({
  page,
  context,
}) => {
  const { owner, aHigh, blocked, blocker } = await seedReadyTenant();

  // Reading the clipboard back requires the permission grant for this origin;
  // there is no prior e2e clipboard pattern, so grant it here (per-context, not a
  // global config flag).
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });

  await signIn(page, owner.email, TEST_PASSWORD);

  // (2) Sidebar shows "Ready" between Issues and Boards, badge = 3 (> 0).
  const rail = page.getByRole('navigation', { name: 'Primary' });
  const readyLink = rail.getByRole('link', { name: 'Ready' });
  await expect(readyLink).toBeVisible();
  await expect(readyLink).toContainText('3');

  // (3) Open /ready; the list renders the 3 ready items and the FIRST row is the
  // highest-priority one (all 3 are the same type, so priority orders within the
  // single type bucket under the 7.0.12 `(type asc, priority desc, key asc)` sort).
  await readyLink.click();
  await expect(page).toHaveURL(/\/ready(\?|$)/);
  const list = page.getByRole('list', { name: 'Ready work items' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(aHigh.identifier);
  await expect(rows.first()).toContainText('Highest');

  // (4) The per-row copy affordance puts `motir run RDY-<n>` on the clipboard +
  // raises the "Copied" toast (panel-4 of the mockup).
  await rows.first().hover();
  await rows
    .first()
    .getByRole('button', { name: `Copy run command for ${aHigh.identifier}` })
    .click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toMatch(/^motir run RDY-\d+$/);
  expect(clip).toBe(`motir run ${aHigh.identifier}`);

  // (5) Row → peek opens the shipped IssueQuickView (?peek=<key>), NOT a full-page
  // navigation; Esc closes it and we stay on /ready.
  await rows
    .first()
    .getByRole('button', { name: `${aHigh.identifier} ${aHigh.title}` })
    .click();
  await expect(page).toHaveURL(/[?&]peek=/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/ready');

  // (6) Live recompute: drive the ONLY blocker to a terminal status. The
  // formerly-blocked item is now ready and appears in the list (4 total).
  expect((await transition(owner.ctx, blocker.id, 'in_review')).status()).toBe(200);
  expect((await transition(owner.ctx, blocker.id, 'done')).status()).toBe(200);
  await page.reload();
  await expect(rows).toHaveCount(4);
  await expect(list).toContainText(blocked.identifier);

  // (7) The sidebar badge tracks the new count (3 → 4) on reload.
  await expect(rail.getByRole('link', { name: 'Ready' })).toContainText('4');
});

test('@smoke /ready is a workspace-member surface, not PM-only', async ({ page, context }) => {
  const { member, owner, aHigh } = await seedReadyTenant();

  // Pin the member's active workspace to the OWNER's via the workspace cookie
  // (the member belongs to two workspaces after `addMember`; the cookie is how
  // the app selects the active one), then sign in as the plain member.
  await context.addCookies([
    { name: WORKSPACE_COOKIE_NAME, value: owner.workspaceId, url: BASE_URL },
  ]);
  await signIn(page, member.email, TEST_PASSWORD);

  // The member — NOT the project manager — sees the same ready surface: the
  // sidebar badge (3) and the list with the highest-priority row first (all
  // same type → priority orders within the bucket). /ready is gated on workspace
  // membership, not on being the PM.
  const readyLink = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Ready' });
  await expect(readyLink).toBeVisible();
  await expect(readyLink).toContainText('3');

  await readyLink.click();
  await expect(page).toHaveURL(/\/ready(\?|$)/);
  const rows = page.getByRole('list', { name: 'Ready work items' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(aHigh.identifier);
});
