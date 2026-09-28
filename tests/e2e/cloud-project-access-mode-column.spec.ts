import { expect, test, type Browser, type Page } from '@playwright/test';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { db, resetDatabase } from './_helpers/db-reset';
import { signIn, signUp } from './_helpers/shell-session';

// Story MOTIR-6554 · Subtask MOTIR-6689 — the access MODE is the only access
// column anything reads, proven the way a person meets it: a Manager switches a
// project's access on the settings page, and a signed-out reader and a workspace
// member who was never added find out what they can read.
//
// Every read that decides "is this project public?" — the RLS policies, the
// public project read, the explore listing — keys on `access_mode` since
// MOTIR-6687. The integration gate (MOTIR-6688) proves that table by table; this
// proves the JOIN between the setter the settings page calls and every one of
// those readers, over the real stack.
//
// No acceptance video: this story adds no surface and changes nothing a person
// watches, so it accepts on its tests alone.
//
// Three contexts kept apart: the Manager (signed up through the UI), a Full
// workspace member created through `usersService` and never added to the
// project, and a fresh signed-out context per public read.
//
// DETERMINISM: every wait is on an authoritative signal — the access PATCH's own
// response, or the HTTP status of the read itself. No fixed timeouts.

const RUN = Date.now();
const MANAGER_EMAIL = `access-column-manager-${RUN}@example.com`;
const MEMBER_EMAIL = `access-column-member-${RUN}@example.com`;
const MEMBER_PASSWORD = 'access-column-e2e-pass-123';
const KEY = 'ACOL';
const SECOND_KEY = 'ACOLNEW';

// messages/en.json › settings.access / settings.buildInPublic
const ACCESS_GROUP = 'Project access mode';
const START_PUBLIC = 'Start building in public';
const MAKE_MEMBERS_ONLY = 'Make members only';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

type Seed = { workspaceId: string; managerId: string; projectId: string; itemKey: string };

/** The Manager's own workspace (resolved through the browser's session), one project and one item. */
async function seed(page: Page): Promise<Seed> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Access column',
    identifier: KEY,
  });
  // Pin it active, as the product's own create door does (MOTIR-4876).
  await projectsService.setActiveProject({
    userId: membership.userId,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Something to read' },
    { userId: membership.userId, workspaceId: workspace.id },
  );
  return {
    workspaceId: workspace.id,
    managerId: membership.userId,
    projectId: project.id,
    itemKey: item.identifier,
  };
}

/** Pick `mode` on the access control, confirm its dialog when it has one, and wait for the write. */
async function chooseMode(
  page: Page,
  mode: RegExp,
  confirm: { dialogButton: string } | null,
): Promise<void> {
  await page.goto('/settings/project/members');
  const written = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/projects/${KEY}/access` &&
      r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: ACCESS_GROUP })
    .getByRole('radio', { name: mode })
    .click();
  if (confirm) {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: confirm.dialogButton }).click();
  }
  expect((await written).status(), `the access write for ${mode}`).toBe(200);
}

/** The two public reads, from a fresh signed-out context: the project's status, and whether explore lists it. */
async function readSignedOut(
  browser: Browser,
  key: string,
): Promise<{ status: number; body: string; listed: boolean }> {
  const anon = await browser.newContext();
  try {
    const res = await anon.request.get(`/api/public/p/${key}`);
    const explore = await anon.request.get('/api/public/explore');
    expect(explore.status(), 'the explore listing answers').toBe(200);
    const page = (await explore.json()) as { items: Array<{ identifier: string }> };
    return {
      status: res.status(),
      body: await res.text(),
      listed: page.items.some((c) => c.identifier === key),
    };
  } finally {
    await anon.close();
  }
}

test('the access mode alone decides who reads a project — public, members only, open, and a new project', async ({
  page,
  browser,
}) => {
  // ── Not vacuous: this lane is cloud, and Public is offered ──────────────────
  expect(process.env['MOTIR_CLOUD'], 'the cloud lane sets MOTIR_CLOUD').toBe('true');

  await signUp(page, MANAGER_EMAIL);
  const s = await seed(page);

  // A Full workspace member, never added to the project, pinned to it — so the
  // item URL below asks about THIS project, whatever else the workspace holds.
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: MEMBER_PASSWORD,
    name: 'Una Added-nowhere',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: s.workspaceId });
  // Pin the member to THIS project before every read of its item. The pin must be
  // re-written each time: when the pinned project is one the member cannot enter,
  // the active-project resolver falls back to another project in the workspace
  // and PERSISTS that fallback (`projectsService` resolution step 2), so the
  // pointer does not survive the Members-only case below.
  const pinMember = () =>
    db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: member.id, workspaceId: s.workspaceId } },
      data: { activeProjectId: s.projectId },
    });
  await pinMember();
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, MEMBER_EMAIL, MEMBER_PASSWORD);

  await page.goto('/settings/project/members');
  await expect(
    page.getByRole('radiogroup', { name: ACCESS_GROUP }).getByRole('radio', { name: /^Public/ }),
    'Public is enabled on a cloud build',
  ).toBeEnabled();

  await test.step('1 — Public is readable signed out, and listed in Explore', async () => {
    await chooseMode(page, /^Public/, { dialogButton: START_PUBLIC });
    const read = await readSignedOut(browser, KEY);
    expect(read.status, 'GET /api/public/p/<KEY> signed out').toBe(200);
    expect(read.body).toContain(KEY);
    expect(read.listed, 'explore lists the public project').toBe(true);
  });

  await test.step('2 — Members only is not: 404 signed out, gone from Explore, not-found to the unadded member', async () => {
    await chooseMode(page, /^Members only/, { dialogButton: MAKE_MEMBERS_ONLY });
    const read = await readSignedOut(browser, KEY);
    expect(read.status, 'GET /api/public/p/<KEY> signed out').toBe(404);
    expect(read.listed, 'explore no longer lists it').toBe(false);

    await pinMember();
    const res = await memberPage.goto(`/items/${s.itemKey}`);
    expect(res?.status(), 'the unadded member reads not-found').toBe(404);
    await expect(memberPage.getByRole('heading', { name: s.itemKey })).toHaveCount(0);
  });

  await test.step('3 — Open to the workspace: the member reads it; signed out still 404', async () => {
    await chooseMode(page, /^Open to the workspace/, null);
    await pinMember();
    const res = await memberPage.goto(`/items/${s.itemKey}`);
    expect(res?.status(), 'the Full member now reads the item').toBe(200);
    const read = await readSignedOut(browser, KEY);
    expect(read.status, 'GET /api/public/p/<KEY> signed out').toBe(404);
    expect(read.listed).toBe(false);
  });

  await test.step('4 — a new project nobody set is Open to the workspace, and not in Explore', async () => {
    const second = await projectsService.createProject({
      workspaceId: s.workspaceId,
      actorUserId: s.managerId,
      name: 'Access column new',
      identifier: SECOND_KEY,
    });
    await projectsService.setActiveProject({
      userId: s.managerId,
      workspaceId: s.workspaceId,
      projectId: second.id,
    });
    await page.goto('/settings/project/members');
    await expect(
      page
        .getByRole('radiogroup', { name: ACCESS_GROUP })
        .getByRole('radio', { name: /^Open to the workspace/ }),
    ).toBeChecked();
    const read = await readSignedOut(browser, SECOND_KEY);
    expect(read.status).toBe(404);
    expect(read.listed).toBe(false);
  });

  await memberContext.close();
});
