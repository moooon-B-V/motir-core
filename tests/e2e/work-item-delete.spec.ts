// E2E: PERMANENT DELETE with subtree cascade from the user's seat (Story 2.8 ·
// Subtask 2.8.6) — the end-to-end composition proof the 2.8.4 component test
// (`work-item-actions-menu.test.tsx`) explicitly deferred here ("E2E coverage of
// the full delete/archive round-trip is Subtask 2.8.6"). Story 2.8 ships the
// irreversible delete: a DELETE route (2.8.3) over the 2.8.2 service, the ⋯
// actions menu + cascade-count confirm dialog (2.8.4), the delete-preview read
// (2.8.7), and the MCP `delete_work_item` tool (2.8.5). The per-piece guarantees
// are locked as units/integration:
//   * cascade (root + every descendant + links gone), the audit revision, the
//     permission gate (NotProjectAdminError), and the already-deleted /
//     cross-workspace races → `tests/integration/work-items/delete.test.ts`;
//   * the menu's permission GATING + the dialog's cascade-count rendering →
//     `tests/components/work-item-actions-menu.test.tsx`;
//   * the MCP round-trip (delete → the whole subtree 404s) →
//     `tests/mcp/delete-tool.test.ts`.
// This file proves those seams COMPOSE for a real signed-in user against the
// real shell (Next + Postgres):
//
//   1. ADMIN deletes a MID-LEVEL node from its detail page. The ⋯ menu offers
//      BOTH the reversible Archive AND the danger Delete… (archive-vs-delete both
//      offered); the confirm dialog NAMES the cascade ("Delete 3 items" for a
//      story + 2 subtasks) and carries the "Archive instead" escape hatch. After
//      confirming, the page REDIRECTS to /items and the whole subtree is gone
//      while the ANCESTOR survives — asserted authoritatively through the `_test`
//      service route (404 on each deleted id, 200 on the epic), never a timeout.
//   2. A NON-PERMITTED member (workspace member, no project-admin / manage
//      capability) opens the SAME menu on a surviving item: Delete… is ABSENT
//      (the manage gate), while Archive + Copy link remain — the end-to-end proof
//      that delete is gated more tightly than edit, and that a non-admin still
//      gets the reversible action.
//
// Setup mirrors the comments / work-item-type specs: the admin signs up through
// the real UI (auto-workspace → /dashboard), the project + the 3-level subtree +
// the second member are minted SERVER-SIDE through the shipped services (the one
// sanctioned cross-layer reach for tests — the surface under test is the delete
// UI, not creation), and the project is pinned active so the /items/[key] route
// resolves it. Every wait is on an AUTHORITATIVE signal (the redirect URL, a
// menuitem's visibility, the service-route status) per CLAUDE.md "E2E waits on
// the AUTHORITATIVE signal" — no `waitForTimeout`.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn, signUp, SHELL_PASSWORD } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  workspaceId: string;
  projectId: string;
  epic: { id: string; identifier: string };
  story: { id: string; identifier: string };
  sub1: { id: string; identifier: string };
  sub2: { id: string; identifier: string };
}

const ADMIN_EMAIL = 'e2e-wi-delete-admin@example.com';
const MEMBER_EMAIL = 'e2e-wi-delete-member@example.com';

/**
 * Admin signs up via the UI (auto-workspace), then server-side: a project (pinned
 * active), a 3-level tree epic → story → [sub1, sub2], and a second workspace
 * MEMBER (a plain member: canEdit on an `open` project, but NOT the project-admin
 * "manage" capability delete requires) with the project pinned active so they can
 * sign in and reach /items/[key]. Leaves the page signed in as the admin.
 */
async function seed(page: Page): Promise<Seed> {
  await signUp(page, ADMIN_EMAIL);
  const local = ADMIN_EMAIL.split('@')[0]!;
  const admin = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(admin, 'admin exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: admin!.id,
    name: 'Deletable work',
    identifier: 'DEL',
  });
  const adminCtx = { userId: admin!.id, workspaceId: ws!.id };

  // epic → story → [sub1, sub2]: deleting the STORY cascades to 2 subtasks
  // (totalCount 3) while the epic ANCESTOR survives.
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Parent epic' },
    adminCtx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Doomed story', parentId: epic.id },
    adminCtx,
  );
  const sub1 = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: 'Doomed subtask one', parentId: story.id },
    adminCtx,
  );
  const sub2 = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: 'Doomed subtask two', parentId: story.id },
    adminCtx,
  );

  // Pin the project active for the admin so /items/[key] resolves it.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: admin!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  // …and pin the active WORKSPACE cookie. The detail PAGE resolves its workspace
  // from the active project, but a getWorkspaceContext-gated API (the
  // delete-preview / delete routes) resolves it from the `workspace_id` cookie,
  // falling back to "first membership" when unset — ambiguous the moment a user
  // holds more than one workspace. A real signed-in user always has this cookie
  // in sync with their active project; pinning it makes the API resolution
  // deterministic (the active-workspace analogue of the activeProjectId pin).
  await pinWorkspaceCookie(page, ws!.id);

  // The non-admin member — a plain workspace member (no project-admin role), the
  // project pinned active so a signed-in member lands on the project shell.
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: SHELL_PASSWORD,
    name: 'Plain Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: ws!.id });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: member.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });

  return {
    workspaceId: ws!.id,
    projectId: project.id,
    epic: { id: epic.id, identifier: epic.identifier },
    story: { id: story.id, identifier: story.identifier },
    sub1: { id: sub1.id, identifier: sub1.identifier },
    sub2: { id: sub2.id, identifier: sub2.identifier },
  };
}

/** Pin the active-workspace cookie the getWorkspaceContext-gated API routes read
 *  (`workspace_id`), so workspace resolution is deterministic for a user who
 *  holds more than one workspace. */
async function pinWorkspaceCookie(page: Page, workspaceId: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'workspace_id', value: workspaceId, domain: 'localhost', path: '/' }]);
}

/** GET a work item through the `_test` service route — 200 + DTO if it exists,
 *  404 once it (or an ancestor's cascade) has removed it. The authoritative
 *  post-condition read (no existence leak: a deleted id is an indistinguishable
 *  404). */
async function itemStatus(page: Page, id: string): Promise<number> {
  return (await page.request.get(`/api/_test/work-items?id=${id}`)).status();
}

test('@smoke Story 2.8: admin deletes a subtree from detail → cascade gone, ancestor survives, redirect', async ({
  page,
}) => {
  const s = await seed(page);

  // The story still exists, with its two subtasks, before we delete.
  expect(await itemStatus(page, s.story.id), 'story exists pre-delete').toBe(200);

  await page.goto(`/items/${s.story.identifier}`);
  await expect(page.getByRole('heading', { name: 'Doomed story', level: 1 })).toBeVisible();

  // ── Open the ⋯ actions menu — archive-vs-delete are BOTH offered ────────────
  await page.getByRole('button', { name: `Actions for ${s.story.identifier}` }).click();
  const menu = page.getByRole('menu', { name: `Actions for ${s.story.identifier}` });
  await expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  // `/^Delete/` (not the literal "Delete…") so the match is robust to the
  // ellipsis glyph in the label copy.
  await expect(menu.getByRole('menuitem', { name: /^Delete/ })).toBeVisible();

  await menu.getByRole('menuitem', { name: /^Delete/ }).click();

  // ── The confirm dialog NAMES the cascade + offers Archive instead ───────────
  const dialog = page.getByRole('alertdialog', { name: 'Delete this work item?' });
  await expect(dialog).toBeVisible();
  // Wait on the AUTHORITATIVE "preview loaded" signal FIRST: the destructive
  // button states the WHOLE-subtree magnitude ("Delete 3 items") only once the
  // 2.8.7 getDeletePreview fetch resolves — until then `preview` is null and the
  // dialog renders a TRANSIENT leaf-shaped body ("no child items"). Asserting the
  // cascade text before this signal races that transient state (the timeout is
  // generous to cover a cold route compile / slow fetch).
  const confirm = dialog.getByRole('button', { name: 'Delete 3 items' });
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  // Now the cascade impact is named in WORDS: 2 descendants, both subtasks.
  // `toContainText` over the dialog avoids strict-mode multi-match on the nested
  // <strong>/<span> the rich-text render produces.
  await expect(dialog).toContainText('2 descendants');
  await expect(dialog).toContainText('2 subtasks');
  await expect(dialog.getByRole('button', { name: 'Archive instead' })).toBeVisible();

  // ── Confirm → the surface redirects to /items (the authoritative signal) ───
  await confirm.click();
  await page.waitForURL('**/items', { timeout: 30_000 });

  // ── The whole subtree is gone; the ancestor epic survives ───────────────────
  await expect(async () => {
    expect(await itemStatus(page, s.story.id), 'deleted story 404s').toBe(404);
    expect(await itemStatus(page, s.sub1.id), 'cascaded subtask one 404s').toBe(404);
    expect(await itemStatus(page, s.sub2.id), 'cascaded subtask two 404s').toBe(404);
    expect(await itemStatus(page, s.epic.id), 'ancestor epic survives').toBe(200);
  }).toPass();

  // The deleted item's detail route now 404s for the user too (no stale page).
  await page.goto(`/items/${s.story.identifier}`);
  await expect(page.getByText('Doomed story', { exact: true })).toHaveCount(0);
});

test('Story 2.8: a non-admin member sees Archive but NOT Delete (the manage gate)', async ({
  page,
}) => {
  const s = await seed(page);

  // Switch from the admin (still signed in from seed()) to the plain member —
  // drop the admin session cookie first so /sign-in renders the form rather than
  // bouncing an already-authenticated browser to /dashboard.
  await page.context().clearCookies();
  await signIn(page, MEMBER_EMAIL, SHELL_PASSWORD);
  await pinWorkspaceCookie(page, s.workspaceId);

  await page.goto(`/items/${s.epic.identifier}`);
  await expect(page.getByRole('heading', { name: 'Parent epic', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: `Actions for ${s.epic.identifier}` }).click();
  const menu = page.getByRole('menu', { name: `Actions for ${s.epic.identifier}` });

  // Delete is the project-admin MANAGE capability — a plain member never sees the
  // row (hidden, not shown-disabled). The reversible Archive (canEdit on `open`)
  // and Copy link remain available.
  await expect(menu.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
});
