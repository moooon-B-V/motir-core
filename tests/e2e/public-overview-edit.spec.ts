// E2E: Story 6.16 — the editable public hero + in-place public-page editing
// (Subtask 6.16.8, verifying 6.16.5 + 6.16.6). The on-page admin editor in a
// real browser, end to end:
//
//   1. an admin opens their OWN public project page, hits "Edit page", and edits
//      in place — replaces the tagline, ADDS and REMOVES a tag, writes the README
//      body — then Saves and reloads; every change persisted (6.16.5);
//   2. emptying the tagline falls back to the generic auto-intro copy and zero
//      tags renders no pills (the read-mode fallbacks);
//   3. Settings: the old in-settings Overview split-editor is GONE; the
//      "Edit on the public page →" link opens the public Overview already in edit
//      mode via the `?edit=1` deep link (6.16.6);
//   4. access gating — neither an anonymous viewer nor a signed-in NON-admin
//      (a different-org account) sees the "Edit page" affordance; and
//   5. the server-side write gate holds for a non-admin / anonymous actor.
//
// Per the E2E discipline (CLAUDE.md): the Save commits through a Server Action,
// so each save awaits the action's POST response (status 200) BEFORE reloading,
// and every persistence check is a FRESH server read (`reload()` / a new
// context), never the optimistic island's own state.
//
// NOTE on the card's "a direct action POST by a non-admin → 403": the on-page
// editor saves via `savePublicOverviewAction` (a Server Action), which CATCHES
// the admin-gate error and returns a typed `{ ok:false, code:'NOT_ADMIN' }`
// result at HTTP 200 — there is no REST overview endpoint, so there is no literal
// 403 to wait on. The real enforcement lives in
// `publicProjectsService.setPublicOverview` (what the action calls): a non-admin
// (or null) actor is rejected and NOTHING is written. §5 asserts that
// authoritative gate directly and proves — via a fresh public read — that no
// write landed. (Verifying 6.16.5's server gate; the integration suite owns the
// per-field validation.)
//
// Setup mirrors public-project-flow.spec.ts: the admin signs up through the real
// UI (auto-workspace → /dashboard); the project, its public access level, and a
// seeded hero are created SERVER-SIDE through the shipped services (the one
// sanctioned cross-layer reach for tests) — the make-public UI flow itself is
// owned by 6.12.10 / 6.17.5. Every edit under test goes through the BROWSER.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { NotProjectAdminError } from '@/lib/projects/errors';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const ADMIN_EMAIL = 'e2e-overview-admin@example.com';
const VIEWER_EMAIL = 'e2e-overview-viewer@example.com';
const PUBLIC_KEY = 'POV';

const SEED_TAGLINE = 'Seed tagline before any edits';
const NEW_TAGLINE = 'Live build log — follow along';
const NEW_BODY = 'A public README authored in place.';
const editUrl = new RegExp(`/p/${PUBLIC_KEY}\\?edit=1$`);

/** A matcher for the Server-Action save POST (it posts to the page route). */
function isSavePost(r: { url(): string; request(): { method(): string } }): boolean {
  return new URL(r.url()).pathname === `/p/${PUBLIC_KEY}` && r.request().method() === 'POST';
}

interface AdminSeed {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** Sign the admin up through the real UI (auto-workspace), then SERVER-SIDE:
 *  create the project, flip it `public`, seed an initial hero (a tagline + two
 *  tags so the editor opens over real content the test edits/removes), and pin
 *  it active so the project-scoped settings route resolves it. */
async function seedAdmin(page: Page): Promise<AdminSeed> {
  await signUp(page, ADMIN_EMAIL);
  const local = ADMIN_EMAIL.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'admin exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const ctx = { userId: user!.id, workspaceId: ws!.id };

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Public Portal',
    identifier: PUBLIC_KEY,
  });
  // setPublicOverview requires the project to already be public.
  await projectMembersService.setAccessLevel({
    key: PUBLIC_KEY,
    actorUserId: user!.id,
    ctx,
    level: 'public',
  });
  await publicProjectsService.setPublicOverview(PUBLIC_KEY, user!.id, {
    publicTagline: SEED_TAGLINE,
    publicTags: ['Kanban', 'Sprints'],
    publicOverviewMd: '',
  });

  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });

  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

test('@smoke admin edits the public hero in place (text/tags/readme), fallbacks render, the settings editor is gone → on-page link, and access gating holds', async ({
  page,
  browser,
}) => {
  await seedAdmin(page);

  // ── 1. admin in-place edit: tagline + add/remove a tag + body → Save ─────────
  await page.goto(`/p/${PUBLIC_KEY}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Public Portal' })).toBeVisible({
    timeout: 30_000,
  });
  // The on-page Edit affordance mounts ONLY when the viewer can manage.
  await page.getByRole('button', { name: 'Edit page' }).click();

  const tagline = page.getByRole('textbox', { name: 'Tagline' });
  await expect(tagline, 'tagline opens with the seeded value').toHaveValue(SEED_TAGLINE);
  await tagline.fill(NEW_TAGLINE);

  // Tags: remove a seeded tag, add a new one (the "adds and removes a tag" leg).
  await page.getByRole('button', { name: 'Remove tag Kanban' }).click();
  await page.getByRole('button', { name: 'Add tag' }).click();
  const newTag = page.getByRole('textbox', { name: 'New tag' });
  await newTag.fill('Releases');
  await newTag.press('Enter');

  // Body: the shipped MarkdownEditor (TipTap → role=textbox), seeded empty.
  await page.getByRole('textbox', { name: 'Public project overview Markdown' }).click();
  await page.keyboard.type(NEW_BODY);

  // Save commits via a Server Action — arm the response wait BEFORE the click.
  const saved = page.waitForResponse(isSavePost);
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).status(), 'save action returns 200').toBe(200);
  // `exact` to disambiguate the visible toast from its aria-live announcer
  // (which prefixes "Notification …").
  await expect(page.getByText('Public page saved.', { exact: true })).toBeVisible();

  // Reload (a fresh server read) → every edit persisted.
  await page.reload();
  await expect(page.getByText(NEW_TAGLINE)).toBeVisible();
  await expect(page.getByText('Sprints', { exact: true })).toBeVisible();
  await expect(page.getByText('Releases', { exact: true })).toBeVisible();
  await expect(page.getByText('Kanban', { exact: true }), 'removed tag is gone').toHaveCount(0);
  await expect(page.getByText(NEW_BODY)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit page' }), 'still admin').toBeVisible();

  // ── 2. fallbacks: empty tagline → generic auto-intro; zero tags → no pills ───
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.getByRole('textbox', { name: 'Tagline' }).fill('');
  await page.getByRole('button', { name: 'Remove tag Releases' }).click();
  await page.getByRole('button', { name: 'Remove tag Sprints' }).click();
  await expect(page.getByText('No tags yet')).toBeVisible();

  const saved2 = page.waitForResponse(isSavePost);
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved2).status(), 'fallback save returns 200').toBe(200);

  await page.reload();
  await expect(page.getByText(/A public project on Motir/)).toBeVisible();
  await expect(page.getByText(NEW_TAGLINE)).toHaveCount(0);
  await expect(page.getByText('Sprints', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Releases', { exact: true })).toHaveCount(0);

  // ── 3. Settings: the in-settings editor is gone; the link opens edit mode ────
  await page.goto('/settings/project/members');
  await expect(page.getByRole('heading', { name: 'Hero & overview' })).toBeVisible({
    timeout: 30_000,
  });
  // The old in-settings split-editor entry is removed (6.16.6) — one surface.
  await expect(
    page.getByRole('button', { name: 'Edit overview' }),
    'in-settings Overview editor removed',
  ).toHaveCount(0);
  // Its replacement deep-links to the public page already in edit mode.
  const editLink = page.getByRole('link', { name: 'Edit on the public page' });
  await expect(editLink).toBeVisible();
  await editLink.click();
  await page.waitForURL(editUrl);
  // Landed in edit mode WITHOUT clicking "Edit page" — the Save bar + the
  // editable tagline are present (the `?edit=1` initialEditing path, 6.16.5).
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Tagline' })).toBeVisible();

  // ── 4. access gating: NO "Edit page" for anonymous or a signed-in non-admin ──
  // 4a. anonymous (no session) reads the page, sees no edit affordance.
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  const anonRes = await anon.goto(`/p/${PUBLIC_KEY}`);
  expect(anonRes?.status(), 'public overview is 200 with no session').toBe(200);
  await expect(anon.getByRole('heading', { level: 1, name: 'Public Portal' })).toBeVisible();
  await expect(anon.getByRole('button', { name: 'Edit page' })).toHaveCount(0);
  await anonCtx.close();

  // 4b. a signed-in NON-admin (a fresh, different-org account) likewise gets the
  //     read view with no edit affordance.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await signUp(viewer, VIEWER_EMAIL);
  await viewer.goto(`/p/${PUBLIC_KEY}`);
  await expect(viewer.getByRole('heading', { level: 1, name: 'Public Portal' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Edit page' })).toHaveCount(0);
  await viewerCtx.close();

  const viewerUser = await db.user.findFirst({ where: { email: VIEWER_EMAIL } });
  expect(viewerUser, 'non-admin account exists').not.toBeNull();

  // ── 5. the server-side write gate holds (the negative authorization path) ────
  // The Server Action returns NOT_ADMIN at HTTP 200; the enforcement is the
  // service rejecting the write — assert it directly (see the file header note).
  await expect(
    publicProjectsService.setPublicOverview(PUBLIC_KEY, viewerUser!.id, {
      publicTagline: 'tagline injected by a non-admin',
    }),
    'a non-admin write is rejected',
  ).rejects.toThrow(NotProjectAdminError);
  await expect(
    publicProjectsService.setPublicOverview(PUBLIC_KEY, null, {
      publicTagline: 'tagline injected anonymously',
    }),
    'an anonymous write is rejected',
  ).rejects.toThrow(NotProjectAdminError);

  // …and NOTHING landed: the public page is still the generic fallback, never
  // either injected tagline (a fresh, session-less read).
  const afterCtx = await browser.newContext();
  const after = await afterCtx.newPage();
  await after.goto(`/p/${PUBLIC_KEY}`);
  await expect(after.getByText(/A public project on Motir/)).toBeVisible();
  await expect(after.getByText('tagline injected by a non-admin')).toHaveCount(0);
  await expect(after.getByText('tagline injected anonymously')).toHaveCount(0);
  await afterCtx.close();
});
