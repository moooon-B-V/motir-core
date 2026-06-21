// E2E: the archive → archived view → restore round-trip from the user's seat
// (Story 2.9 · Subtask 2.9.4) — the end-to-end composition proof that the 2.9
// archive-management surface works for a real signed-in user against the real
// shell (Next + Postgres). Story 2.9 ships the durable archive surface that
// replaces the transient Undo toast: a dedicated `/items/archived` view (2.9.3)
// over the service's `listArchivedWorkItems` page read, a per-item Restore that
// calls the existing unarchive route (`DELETE /api/work-items/[id]/archive`), and
// the `canBrowse`/`canEdit` access split (2.9.1 — a viewer sees the list but not
// Restore). The per-piece guarantees are locked at the unit/component/integration
// tiers (the service page read + access gate, the `archivedRows` shaper, the
// `ArchivedWorkItemsList` island's optimistic-drop + gating). This file proves
// those seams COMPOSE end-to-end:
//
//   1. An EDITOR archives a work item from the ⋯ actions menu → the archive POST
//      returns 200 (the authoritative signal, armed BEFORE the action) and the
//      item leaves the active issues list. The archived view then lists it; the
//      per-item Restore fires the unarchive DELETE (200, armed before the click),
//      the row leaves the archived view, the item returns to the active list, and
//      its detail History feed shows the `unarchived` ("restored") revision.
//   2. The archived view PAGINATES: with > one page of archived items, page 1
//      caps at the 50-row page size (no load-everything) and page 2 holds the
//      tail — the server re-reads per `?page=`, awaited via the URL + the
//      "Showing m–n of N" range the Server Component renders.
//   3. A non-editor (project VIEWER on a private project — the 2.9.1 access
//      decision) sees the archived view and the archived item, but has NO Restore
//      (the action column is dropped for a browse-only viewer).
//
// Setup mirrors work-item-delete / project-access: personas are minted SERVER-SIDE
// through the shipped services (the sanctioned cross-layer reach for tests — the
// surface under test is the archive UI, not creation), the project is pinned
// active + the `workspace_id` cookie pinned so the active-project routes and the
// getWorkspaceContext-gated archive API resolve deterministically, and the GATE
// itself is exercised in the browser. Every wait is on an AUTHORITATIVE signal
// (the archive/unarchive response status, a committed server read, a role state)
// per CLAUDE.md "E2E tests wait on the AUTHORITATIVE signal" — no `waitForTimeout`.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// Heavy per-test setup (credential accounts hashed, real sign-in, and the
// pagination test archives a full page-plus of items via the service) — generous
// headroom over the 30s default, matching project-access / work-item-delete.
test.describe.configure({ timeout: 120_000 });

const PWD = 'archive-flow-e2e-pass-123';

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerId: string;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  // Release the worktree-side Prisma pool so it doesn't keep the runner alive
  // past the last test (mirrors project-isolation / work-item-delete).
  await db.$disconnect();
});

/** A sign-in-able credential account (real password hash → `signIn` works). */
async function makeUser(email: string, name: string): Promise<{ id: string; email: string }> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email };
}

/** Owner + workspace + one OPEN project, all via the shipped services. The owner
 *  is the always-pass tier (canEdit + canManage); tests layer personas on top. */
async function seedTenant(ownerEmail: string, identifier: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Olive Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Archive Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Archivable work',
    identifier,
  });
  return { workspaceId: workspace.id, projectId: project.id, ownerId: owner.id };
}

/** The owner's service context (the editor that creates + archives the fixtures). */
function ownerCtx(t: Tenant) {
  return { userId: t.ownerId, workspaceId: t.workspaceId };
}

/** Pin a project active for a user so the active-project routes (/items,
 *  /items/archived) resolve it on every render — the sanctioned direct write
 *  board-at-scale / project-access use. */
async function pinActiveProject(userId: string, t: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
    data: { activeProjectId: t.projectId },
  });
}

/** Pin the active-workspace cookie the getWorkspaceContext-gated archive routes
 *  read (`workspace_id`), so workspace resolution is deterministic for a user who
 *  holds more than one workspace (the analogue of the activeProjectId pin). */
async function pinWorkspaceCookie(page: Page, workspaceId: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'workspace_id', value: workspaceId, domain: 'localhost', path: '/' }]);
}

/** Grant an explicit project membership with a role — the controlled way to make
 *  a browse-only VIEWER on a private project (project-access's precedent). */
async function grantProjectRole(
  userId: string,
  t: Tenant,
  role: 'admin' | 'member' | 'viewer',
): Promise<void> {
  await db.projectMembership.create({
    data: { userId, workspaceId: t.workspaceId, projectId: t.projectId, role },
  });
}

test('@smoke Story 2.9: editor archives → archived view → restore → back in active views + restored activity', async ({
  page,
}) => {
  const t = await seedTenant('e2e-archive-editor@example.com', 'ARE');
  const target = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind: 'epic', title: 'Archivable epic' },
    ownerCtx(t),
  );

  await pinActiveProject(t.ownerId, t);
  await signIn(page, 'e2e-archive-editor@example.com', PWD);
  await pinWorkspaceCookie(page, t.workspaceId);

  // ── The item starts in the active issues list ───────────────────────────────
  await page.goto('/items?view=list');
  await expect(page.getByTestId(`issue-row-${target.identifier}`)).toBeVisible();

  // ── Archive it from the ⋯ actions menu on its detail page ───────────────────
  await page.goto(`/items/${target.identifier}`);
  await expect(page.getByRole('heading', { name: 'Archivable epic', level: 1 })).toBeVisible();

  // Arm the archive-POST wait BEFORE the action (CLAUDE.md "E2E waits on the
  // AUTHORITATIVE signal") so the optimistic toast + navigation can't outrun it.
  const archiveResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/work-items/${target.id}/archive`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: `Actions for ${target.identifier}` }).click();
  const menu = page.getByRole('menu', { name: `Actions for ${target.identifier}` });
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  expect((await archiveResp).status()).toBe(200);
  // The detail surface navigates back to /items on archive (onArchived → leave).
  await page.waitForURL('**/items');

  // ── It left the active issues list ──────────────────────────────────────────
  await page.goto('/items?view=list');
  await expect(page.getByTestId(`issue-row-${target.identifier}`)).toHaveCount(0);

  // ── Open the archived view via the toolbar [Archived] entry-point ───────────
  await page.getByRole('link', { name: /Archived/ }).click();
  await page.waitForURL('**/items/archived');
  await expect(page.getByRole('heading', { name: 'Archived work items', level: 1 })).toBeVisible();
  const archivedRow = page.getByTestId(`archived-row-${target.identifier}`);
  await expect(archivedRow).toBeVisible();

  // ── Restore — wait on the unarchive DELETE 200 (armed BEFORE the click) ─────
  const restoreResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/work-items/${target.id}/archive`) && r.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: `Restore ${target.identifier}` }).click();
  expect((await restoreResp).status()).toBe(200);
  // The row leaves the archived view (the optimistic drop is now server-confirmed).
  await expect(archivedRow).toHaveCount(0);

  // ── It is back in the active issues list ────────────────────────────────────
  await page.goto('/items?view=list');
  await expect(page.getByTestId(`issue-row-${target.identifier}`)).toBeVisible();

  // ── Its detail History feed shows the restore (the `unarchived` revision) ───
  await page.goto(`/items/${target.identifier}?activity=history`);
  await expect(page.getByRole('list', { name: 'History' })).toContainText('restored the work item');
});

test('Story 2.9: the archived view paginates — page 1 caps at the page size, page 2 holds the rest', async ({
  page,
}) => {
  const t = await seedTenant('e2e-archive-pager@example.com', 'ARP');

  // 51 archived items → 2 pages at the fixed 50-row page size. Asserting that
  // page 1 shows exactly 50 (not all 51) is the proof the read is server-paged
  // and never loads everything.
  const TOTAL = 51;
  for (let i = 0; i < TOTAL; i++) {
    const item = await workItemsService.createWorkItem(
      { projectId: t.projectId, kind: 'epic', title: `Archived epic ${i + 1}` },
      ownerCtx(t),
    );
    await workItemsService.archiveWorkItem(item.id, ownerCtx(t));
  }

  await pinActiveProject(t.ownerId, t);
  await signIn(page, 'e2e-archive-pager@example.com', PWD);
  await pinWorkspaceCookie(page, t.workspaceId);

  await page.goto('/items/archived');
  await expect(page.getByRole('heading', { name: 'Archived work items', level: 1 })).toBeVisible();

  // Page 1: exactly the page size of rows + the server-rendered range/total.
  const rows = page.locator('[data-testid^="archived-row-"]');
  await expect(rows).toHaveCount(50);
  await expect(page.getByText('Showing 1–50 of 51')).toBeVisible();

  // Page 2 — the URL drives a server re-read; await the committed URL + the new
  // range the Server Component renders before asserting the tail (never the
  // optimistic click alone). Mirrors the /items List pager E2E.
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForURL((url) => url.searchParams.get('page') === '2');
  await expect(page.getByText('Showing 51–51 of 51')).toBeVisible();
  await expect(rows).toHaveCount(1);
});

test('Story 2.9: a non-editor (project viewer) sees the archived view + item but no Restore', async ({
  page,
}) => {
  const t = await seedTenant('e2e-archive-owner@example.com', 'ARV');
  const item = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind: 'epic', title: 'Archived for the viewer' },
    ownerCtx(t),
  );
  await workItemsService.archiveWorkItem(item.id, ownerCtx(t));

  // A genuine browse-only viewer: a workspace member granted the project VIEWER
  // role on a PRIVATE project (browse, no edit — the 2.9.1 access decision the
  // archived view honours). `viewer` on `private` is the project-access matrix's
  // "can browse but cannot edit" cell.
  const viewer = await makeUser('e2e-archive-viewer@example.com', 'Val Viewer');
  await workspacesService.addMember({ userId: viewer.id, workspaceId: t.workspaceId });
  await grantProjectRole(viewer.id, t, 'viewer');
  await db.project.update({ where: { id: t.projectId }, data: { accessLevel: 'private' } });
  await pinActiveProject(viewer.id, t);

  await signIn(page, 'e2e-archive-viewer@example.com', PWD);
  await pinWorkspaceCookie(page, t.workspaceId);

  await page.goto('/items/archived');
  // The view renders for a browse-only viewer (NOT the no-access state) — 2.9.1.
  await expect(page.getByRole('heading', { name: 'Archived work items', level: 1 })).toBeVisible();
  await expect(page.getByText(/access to this project/i)).toHaveCount(0);
  // …and the archived item is listed…
  await expect(page.getByTestId(`archived-row-${item.identifier}`)).toBeVisible();
  // …but a non-editor has NO Restore (the action column is dropped, not disabled).
  await expect(page.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
});
