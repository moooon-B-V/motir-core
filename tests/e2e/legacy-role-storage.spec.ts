import { expect, test, type Page, type Response } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { isAppRoleE2E, type ServerDbRole } from './_helpers/appRoleServer';
import {
  HARBOR,
  LRS_PASSWORD,
  seedLegacyRoleStorage,
  type LegacyRoleStorageSeed,
} from './_helpers/legacy-role-storage-seed';
import { createWorkspace, signIn } from './_helpers/shell-session';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { INVITE_IDENTIFIER_PREFIX } from '@/lib/services/workspaceInvitesService';

// THE LEGACY ROLE STORAGE, RETIRED — THE STORY E2E (Story MOTIR-6469 · Subtask
// MOTIR-6564). Nothing reads or writes `workspace_membership.role` /
// `project_membership.role` any more; this walks the flows a person uses to GET
// a role, in a real browser against a production build, and checks each lands
// the right one:
//
//   1. an org Admin creates a workspace from the product's own control → Manager;
//   2. an invite minted by THIS build, accepted → Member;
//   3. an invite minted BEFORE MOTIR-6562 (legacy `role` key only) → refused,
//      since MOTIR-6569 retired the fallback that mapped it;
//   4. the Manager makes the invitee a Viewer and adds them to a private project:
//      it opens for them, read-only, and a direct write is refused;
//   5. an unknown / expired token and an outsider get the app's refused states.
//
// ── The lane ────────────────────────────────────────────────────────────────
// The card asks for the `E2E_APP_ROLE=1` lane, where the SERVER connects as
// `motir_app` and RLS executes — the only configuration in which an invite
// accept's membership insert is checked against the policy. Under that flag the
// spec REQUIRES the server to be the non-bypass role before its first case (the
// guard `app-role-surfaces.spec.ts` uses), so it cannot pass as the owner.
//
// ⚠️ No CI workflow sets `E2E_APP_ROLE=1` (`grep -rn E2E_APP_ROLE .github/` is
// empty), so unlike `app-role-surfaces` this file does NOT skip without it: the
// PR's ordinary shard runs every flow against the owner-role server, and the
// app-role run is the local / nightly one. Skipping would leave the flows
// executed nowhere.
//
// No acceptance video: the story adds no user-visible surface.
//
// LOCATOR DISCIPLINE (MOTIR-3737): every locator after a navigation is
// role-based, so the outgoing subtree React keeps mounted cannot match it.

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let seed: LegacyRoleStorageSeed;
let harborId = '';
/** Harbor's project and its card — made private BEFORE anyone joins (case 1). */
let project: { id: string; identifier: string };
let item: { id: string; identifier: string; title: string };

const picker = (page: Page, name: string) =>
  page.getByRole('combobox', { name: `Role for ${name}` });

async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, LRS_PASSWORD);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 30_000,
  });
}

async function openMembers(page: Page): Promise<void> {
  const res = await page.goto('/settings/workspace');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
}

async function committedRole(userId: string): Promise<string | undefined> {
  const row = await adminDb.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: harborId } },
  });
  return row?.workspaceRole;
}

/** Open `/invite/accept?token=…` as the signed-in invitee and accept; settle on the 200. */
async function acceptInvite(page: Page, token: string): Promise<void> {
  await page.goto(`/invite/accept?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: `Join ${HARBOR}` })).toBeVisible({
    timeout: 30_000,
  });
  const accepted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/invites\/[^/]+\/accept$/.test(r.url()),
  );
  await page.getByRole('button', { name: 'Accept invite' }).click();
  expect((await accepted).status(), 'the accept route').toBe(200);
}

/** A Server Action POSTed to `pathname`, told apart by a body substring. */
function serverAction(page: Page, pathname: string, needle: string): Promise<Response> {
  return page.waitForResponse((res) => {
    const req = res.request();
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      (req.postData() ?? '').includes(needle)
    );
  });
}

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedLegacyRoleStorage(`lrs${Date.now().toString(36)}`);
});

test('0 · the lane: under E2E_APP_ROLE=1 the server really is `motir_app`, with RLS live', async ({
  baseURL,
}) => {
  test.skip(!isAppRoleE2E(), 'the owner-role lane — see this file’s header');
  const res = await fetch(`${baseURL}/api/_test/db-role`);
  expect(res.status, 'the db-role probe must answer').toBe(200);
  const role = (await res.json()) as ServerDbRole;
  expect(role.currentUser, 'the SERVER must be connected as the non-bypass role').toBe('motir_app');
  expect(role.bypassesRls, 'a BYPASSRLS role makes the insert-under-policy case vacuous').toBe(
    false,
  );
});

test('1 · an org Admin creates a workspace, and the Members page lists them as its Manager', async ({
  page,
}) => {
  await signInAs(page, seed.maya.email);
  await createWorkspace(page, HARBOR);

  const harbor = await adminDb.workspace.findFirstOrThrow({
    where: { organizationId: seed.organizationId, name: HARBOR },
  });
  harborId = harbor.id;
  await expect.poll(() => committedRole(seed.maya.id)).toBe('manager');

  // Arrange case 4's project now, through the services: going PRIVATE adds every
  // CURRENT workspace member to the project, so it must happen before the
  // invitees join, or there would be nobody left for the Manager to add.
  project = await adminDb.project.findFirstOrThrow({
    where: { workspaceId: harborId },
    orderBy: { createdAt: 'asc' },
  });
  const mayaCtx = { userId: seed.maya.id, workspaceId: harborId };
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: seed.maya.id,
    ctx: mayaCtx,
    level: 'private',
  });
  item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Chart the harbour lights' },
    mayaCtx,
  );

  await openMembers(page);
  await expect(picker(page, seed.maya.name)).toContainText('Manager');
});

test('2 · an invite minted by this build, accepted, lands a Member', async ({ page }) => {
  await signInAs(page, seed.maya.email);
  await openMembers(page);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(seed.iris.email);
  const sent = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith(`/api/workspaces/${harborId}/invites`),
  );
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  expect((await sent).status(), 'the invite route').toBe(200);

  // The token comes from the database: the invite EMAIL is not under test.
  const row = await adminDb.verification.findFirstOrThrow({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: seed.iris.email },
    },
  });
  expect(JSON.parse(row.value)).toMatchObject({ workspaceRole: 'member' });

  await signInAs(page, seed.iris.email);
  await acceptInvite(page, row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length));
  await expect.poll(() => committedRole(seed.iris.id)).toBe('member');

  await signInAs(page, seed.maya.email);
  await openMembers(page);
  await expect(picker(page, seed.iris.name)).toContainText('Member');
});

test('3 · an invite minted BEFORE MOTIR-6562 (legacy `role` only) is refused, and lands nobody', async ({
  page,
}) => {
  const token = `lrs-pre-release-${Date.now().toString(36)}`;
  // Byte-for-byte the payload the pre-MOTIR-6562 build wrote: no `workspaceRole`.
  await adminDb.verification.create({
    data: {
      identifier: INVITE_IDENTIFIER_PREFIX + token,
      value: JSON.stringify({
        workspaceId: harborId,
        email: seed.pip.email,
        role: 'member',
        inviterUserId: seed.maya.id,
      }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  // Every such token lapsed after 7 days (`INVITE_EXPIRY_MS`), so MOTIR-6569
  // retired the fallback: the payload no longer parses, and the page shows the
  // same invalid-invite state as an unknown token.
  await signInAs(page, seed.pip.email);
  const res = await page.goto(`/invite/accept?token=${encodeURIComponent(token)}`);
  expect(res?.status()).toBeLessThan(500);
  await expect(
    page.getByRole('heading', { name: 'This invite has already been used' }),
  ).toBeVisible();
  expect(await committedRole(seed.pip.id)).toBeUndefined();
});

test('4 · made a Viewer and added to a private project, the invitee reads it and cannot write', async ({
  page,
}) => {
  // Both land in Harbor's project (the fixture's arrangement, not the subject).
  expect(
    await adminDb.projectMembership.count({
      where: { projectId: project.id, userId: seed.iris.id },
    }),
    'Iris joined after the project went private, so nobody added her yet',
  ).toBe(0);
  for (const id of [seed.maya.id, seed.iris.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: id, workspaceId: harborId } },
      data: { activeProjectId: project.id },
    });
    await adminDb.user.update({ where: { id }, data: { lastActiveProjectId: project.id } });
  }

  // The Manager makes Iris a Viewer on the Members page.
  await signInAs(page, seed.maya.email);
  await openMembers(page);
  const control = picker(page, seed.iris.name);
  await expect(control).toBeEnabled();
  await control.scrollIntoViewIfNeeded();
  await control.click();
  const write = serverAction(page, '/settings/workspace', seed.iris.id);
  await page.getByRole('option', { name: /^Viewer(\s|$)/ }).click();
  expect((await write).status(), 'the role change').toBe(200);
  await expect.poll(() => committedRole(seed.iris.id), { timeout: 20_000 }).toBe('viewer');

  // …and adds her to the private project.
  await page.goto('/settings/project/members');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
  const added = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.url().endsWith(`/api/projects/${project.identifier}/members`),
  );
  await page.getByRole('combobox', { name: 'Add a project member' }).click();
  await page.getByRole('option', { name: new RegExp(seed.iris.name) }).click();
  expect((await added).status(), 'the project add').toBe(201);
  await expect
    .poll(() =>
      adminDb.projectMembership.count({ where: { projectId: project.id, userId: seed.iris.id } }),
    )
    .toBe(1);

  // Signed in as Iris, the project's card opens — read-only.
  await signInAs(page, seed.iris.email);
  await page.goto(`/items/${item.identifier}`);
  await expect(page.getByRole('heading', { name: item.title, level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  const readOnly = page.getByRole('button', {
    name: /— You have read-only access to this project$/,
  });
  await expect(readOnly.first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);

  // Her items list renders the card too.
  await page.goto('/items');
  await expect(page.getByRole('link', { name: new RegExp(item.title) }).first()).toBeVisible({
    timeout: 30_000,
  });

  // A direct write is refused by the server, and nothing changed.
  const refused = await page.request.patch(`/api/work-items/${item.id}/estimate`, {
    data: { points: 3 },
  });
  expect(refused.status(), 'a Viewer’s direct estimate write').toBe(403);
  const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
  expect(after.storyPoints).toBeNull();
});

test('5 · an unknown or expired token shows the invalid-invite state, never a 500', async ({
  page,
}) => {
  const expired = `lrs-expired-${Date.now().toString(36)}`;
  await adminDb.verification.create({
    data: {
      identifier: INVITE_IDENTIFIER_PREFIX + expired,
      value: JSON.stringify({
        workspaceId: harborId,
        email: seed.oscar.email,
        workspaceRole: 'member',
        inviterUserId: seed.maya.id,
      }),
      expiresAt: new Date(Date.now() - 60 * 1000),
    },
  });

  await signInAs(page, seed.oscar.email);
  const unknown = await page.goto('/invite/accept?token=lrs-no-such-token');
  expect(unknown?.status()).toBeLessThan(500);
  await expect(
    page.getByRole('heading', { name: 'This invite has already been used' }),
  ).toBeVisible();

  const stale = await page.goto(`/invite/accept?token=${expired}`);
  expect(stale?.status()).toBeLessThan(500);
  await expect(page.getByRole('heading', { name: 'This invite has expired' })).toBeVisible();
  expect(await committedRole(seed.oscar.id)).toBeUndefined();
});

test('6 · an outsider opening the workspace’s project card gets the not-found state', async ({
  page,
}) => {
  await signInAs(page, seed.oscar.email);
  const res = await page.goto(`/items/${item.identifier}`);
  expect(res?.status(), 'no existence leak: a card in a workspace you are not in').toBe(404);
});
