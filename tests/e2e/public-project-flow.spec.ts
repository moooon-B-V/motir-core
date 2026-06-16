// E2E: Story 6.12 — the cross-org PUBLIC PROJECT loop (Subtask 6.12.10). The
// full public-portal journey in a real browser, across THREE sessions, proving
// the public-read exception + the portal write set end to end:
//
//   1. the project admin flips the project PUBLIC in project settings (6.12.8)
//      — the make-public toggle PATCHes the access endpoint;
//   2. a LOGGED-OUT visitor (no session) reads the public surface — overview /
//      work items / board / roadmap render with no sign-in, the SEO surface (a
//      single <h1> + a JSON-LD application/ld+json script) is present, internal
//      fields (assignees / estimates / internal comments) are absent by the
//      public projection, and a write control shows the sign-in-to-act prompt;
//   3. a SECOND account in a DIFFERENT org (no membership in the public
//      project's org/workspace) signs in and acts cross-org: submitting a
//      request whose title matches an existing public request surfaces the
//      dedupe → "upvote this instead" (the vote increments, NO duplicate is
//      created) → then comments on that public request (it appears);
//   4. the same account submits a genuinely-NEW request → it lands in the
//      admin's triage queue (attributed to the cross-org account, the peach
//      "Public" submitter) and is ABSENT from the normal tree until promoted;
//   5. the cross-org account CANNOT view a NON-public project of that org
//      (404-not-403) — public is the only cross-org read exception.
//
// The integration suite pins the access matrix + projection at the service
// layer; this file owns the thing only a browser proves — the make-public,
// anonymous read, cross-org write, triage attribution, and exclusion across the
// rendered surfaces, with a second browser context for the second account.
//
// Setup mirrors triage-flow.spec.ts: the admin signs up through the real UI
// (auto-workspace → /dashboard), then the project + its seed work items are
// created SERVER-SIDE through the shipped services (the one sanctioned
// cross-layer reach for tests); the make-public toggle, the anonymous read, and
// every cross-org write go through the BROWSER — the surface under test.
//
// Per the E2E discipline (CLAUDE.md): every mutation (set-access / upvote /
// comment / submit) is awaited on its endpoint's response BEFORE asserting the
// persisted effect, and each surface is re-navigated fresh (a full server read)
// rather than leaning on an optimistic island's state.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const ADMIN_EMAIL = 'e2e-public-admin@example.com';
const CROSS_EMAIL = 'e2e-public-crossorg@example.com';
const CROSS_NAME = 'Casey Cross';
const PUBLIC_KEY = 'PUB';
const PRIVATE_KEY = 'PRIV';

// The existing public request the dedupe must surface, and the matching draft
// title (every token of the draft is a substring of the existing title, the
// AND-tokenised match `findPublicRequestMatches` runs).
const EXISTING_REQUEST = 'Dark mode for the dashboard';
const DEDUPE_DRAFT = 'Dark mode';
// A genuinely-new request — no token overlap with the existing one, so the
// dedupe stays empty and the submit creates a triage item.
const NEW_REQUEST = 'Keyboard shortcuts for navigation';

interface AdminSeed {
  ctx: ServiceContext;
  publicProjectId: string;
  existing: { id: string; identifier: string };
}

/** Sign the admin up through the real UI (auto-workspace), then create — server
 *  side — a project (left at the default `open` access; flipped public via the
 *  UI in the test), a couple of public-projection work items including the
 *  existing request the dedupe surfaces, and a SECOND non-public project in the
 *  same org for the cross-org exclusion leg. Pins the public project active so
 *  the project-scoped routes (/settings/project, /issues, /triage) resolve it. */
async function seedAdmin(page: Page): Promise<AdminSeed> {
  await signUp(page, ADMIN_EMAIL);
  const local = ADMIN_EMAIL.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'admin exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const ctx: ServiceContext = { userId: user!.id, workspaceId: ws!.id };

  const publicProject = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Public Portal',
    identifier: PUBLIC_KEY,
  });
  // A non-public sibling project in the SAME org — the cross-org exclusion target.
  await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Internal Only',
    identifier: PRIVATE_KEY,
  });

  // The existing public request the dedupe upvotes, plus a second item so the
  // board / list render real public-projection content (not the empty state).
  const existing = await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'task', title: EXISTING_REQUEST, parentId: null },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'task', title: 'Export the board to CSV', parentId: null },
    ctx,
  );

  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: publicProject.id },
  });

  return {
    ctx,
    publicProjectId: publicProject.id,
    existing: { id: existing.id, identifier: existing.identifier },
  };
}

test('@smoke a public project: admin makes it public, anyone reads it logged-out, a cross-org account submits/dedupes/upvotes/comments, a new request hits triage, and a non-public project is not viewable', async ({
  page,
  browser,
}) => {
  const seed = await seedAdmin(page);

  // ── 1. admin flips the project PUBLIC in project settings (6.12.8) ──────────
  await page.goto('/settings/project/members');
  const accessGroup = page.getByRole('radiogroup', { name: 'Project access level' });
  await expect(accessGroup).toBeVisible({ timeout: 30_000 });
  // Story 6.17.2 reframed the `public` level as "Building in public" and gates
  // it behind an explainer/confirm dialog — the access write fires on the
  // dialog's confirm, NOT the bare radio click.
  await accessGroup.getByRole('radio', { name: /^Building in public/ }).click();
  const confirmDialog = page.getByRole('dialog');
  await expect(confirmDialog).toBeVisible();
  const accessSaved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/projects/${PUBLIC_KEY}/access` &&
      r.request().method() === 'PATCH',
  );
  await confirmDialog.getByRole('button', { name: 'Start building in public' }).click();
  expect((await accessSaved).status(), 'set-access → public returns 200').toBe(200);

  // ── 2. a LOGGED-OUT visitor reads the public surface (a fresh, session-less
  //       browser context) ─────────────────────────────────────────────────
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();

  // Overview — the public link's landing. SEO surface: exactly one <h1> (the
  // project name) + a JSON-LD application/ld+json script.
  const overviewRes = await anon.goto(`/p/${PUBLIC_KEY}`);
  expect(overviewRes?.status(), 'public overview is 200 with no session').toBe(200);
  await expect(anon.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(anon.getByRole('heading', { level: 1 })).toContainText('Public Portal');
  const ld = await anon.locator('script[type="application/ld+json"]').first().textContent();
  expect(ld, 'JSON-LD SoftwareApplication present').toContain('SoftwareApplication');
  // The public banner renders without a session …
  await expect(anon.getByText(/viewing a public project/)).toBeVisible();
  // … and the write control is a sign-in-to-act prompt (reading is open, posting
  // needs an account). Several "Submit a request" controls exist (nav/hero/
  // sidebar); the first opens the logged-out prompt dialog.
  await anon.getByRole('button', { name: 'Submit a request' }).first().click();
  await expect(anon.getByRole('dialog', { name: 'Sign in to submit a request' })).toBeVisible();

  // Work items — read-only public projection list renders the seeded item.
  const itemsRes = await anon.goto(`/p/${PUBLIC_KEY}/items`);
  expect(itemsRes?.status(), 'public work-items is 200').toBe(200);
  await expect(anon.getByRole('heading', { level: 1, name: 'Work items' })).toBeVisible();
  await expect(anon.getByText(EXISTING_REQUEST).first()).toBeVisible();

  // A list row LINKS to the public read-only work-item DETAIL page (6.14.11) —
  // header (identifier + title + status), a public-safe sidebar. No edit
  // affordances; a public viewer is never bounced into the authed surface.
  await anon.getByRole('link', { name: /Export the board to CSV/ }).click();
  await anon.waitForURL(/\/items\/[^/]+$/);
  await expect(
    anon.getByRole('heading', { level: 1, name: 'Export the board to CSV' }),
  ).toBeVisible();
  await expect(
    anon.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', {
      name: 'Work items',
    }),
  ).toBeVisible();

  // Board — renders the projection note proving internal fields are ABSENT (not
  // fetched), and carries no edit affordances.
  const boardRes = await anon.goto(`/p/${PUBLIC_KEY}/board`);
  expect(boardRes?.status(), 'public board is 200').toBe(200);
  await expect(anon.getByText(/hidden by the public projection — they aren’t fetched/)).toBeVisible(
    { timeout: 30_000 },
  );

  // Roadmap — renders logged-out (the tab nav resolves it).
  const roadmapRes = await anon.goto(`/p/${PUBLIC_KEY}/roadmap`);
  expect(roadmapRes?.status(), 'public roadmap is 200').toBe(200);
  await expect(anon.getByRole('link', { name: 'Roadmap' })).toBeVisible();

  await anonCtx.close();

  // ── 3. a SECOND account in a DIFFERENT org signs in and acts cross-org ──────
  const crossCtx = await browser.newContext();
  const cross = await crossCtx.newPage();
  await signUp(cross, CROSS_EMAIL); // fresh user → its OWN org/workspace, no moooon membership
  // A deterministic display name for the triage attribution assertion (the
  // sign-up flow sets none); the server reads the name from the DB at read time.
  await db.user.update({ where: { email: CROSS_EMAIL }, data: { name: CROSS_NAME } });

  // 3a. submit a matching-title request → dedupe → "upvote this instead".
  await cross.goto(`/p/${PUBLIC_KEY}`);
  await cross.getByRole('button', { name: 'Submit a request' }).first().click();
  const submitModal = cross.getByRole('dialog', { name: 'Submit a request' });
  await expect(submitModal).toBeVisible();
  const dedupeFetched = cross.waitForResponse(
    (r) => r.url().includes('/requests/duplicates') && r.request().method() === 'GET',
  );
  await submitModal.getByLabel('Title').fill(DEDUPE_DRAFT);
  await dedupeFetched;
  // The dedupe surfaces the existing request with an "Upvote this" action.
  await expect(submitModal.getByText(EXISTING_REQUEST)).toBeVisible();
  const upvoted = cross.waitForResponse(
    (r) =>
      /\/api\/public-requests\/[^/]+\/upvote$/.test(r.url()) && r.request().method() === 'POST',
  );
  await submitModal.getByRole('button', { name: 'Upvote this' }).click();
  expect((await upvoted).status(), 'upvote-this-instead returns 200').toBe(200);
  // The composer confirms the vote (no duplicate was created).
  await expect(submitModal.getByText('Thanks — your vote is in')).toBeVisible();

  // 3b. the upvote landed on the EXISTING request (count incremented to 1) and a
  //     comment on it appears — driven on the request detail page, a fresh read.
  await cross.goto(`/p/${PUBLIC_KEY}/requests/${seed.existing.identifier}`);
  await expect(cross.getByRole('heading', { level: 1, name: EXISTING_REQUEST })).toBeVisible();
  await expect(cross.getByRole('button', { name: /Upvoted — 1 vote/ })).toBeVisible();
  const comment = 'Big +1 from a different org — would use this daily.';
  const commentPosted = cross.waitForResponse(
    (r) =>
      /\/api\/public-requests\/[^/]+\/comments$/.test(r.url()) && r.request().method() === 'POST',
  );
  await cross.getByRole('textbox', { name: 'Add a comment…' }).fill(comment);
  await cross.getByRole('button', { name: 'Comment' }).click();
  expect((await commentPosted).status(), 'public comment returns 201').toBe(201);
  await expect(cross.getByText(comment)).toBeVisible();
  await expect(cross.getByRole('heading', { name: 'Comments (1)' })).toBeVisible();

  // 3c./4. a genuinely-NEW request → triage queue (no duplicate path).
  await cross.goto(`/p/${PUBLIC_KEY}`);
  await cross.getByRole('button', { name: 'Submit a request' }).first().click();
  const newModal = cross.getByRole('dialog', { name: 'Submit a request' });
  await expect(newModal).toBeVisible();
  await newModal.getByLabel('Title').fill(NEW_REQUEST);
  const created = cross.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/public/projects/${seed.publicProjectId}/requests` &&
      r.request().method() === 'POST',
  );
  await newModal.getByRole('button', { name: 'Submit request' }).click();
  const createdRes = await created;
  expect(createdRes.status(), 'submit new request returns 201').toBe(201);
  const newReq = (await createdRes.json()) as { id: string; identifier: string };
  expect(newReq.identifier, 'new request has an identifier').toBeTruthy();
  await expect(newModal.getByText('Thanks — we got it')).toBeVisible();

  // ── 5. the cross-org account CANNOT view a NON-public project (404-not-403) ─
  const privateRes = await cross.goto(`/p/${PRIVATE_KEY}`);
  expect(privateRes?.status(), 'a non-public project is 404 cross-org (not 403)').toBe(404);

  await crossCtx.close();

  // ── 4 (admin side). the new request is in triage, attributed to the cross-org
  //      account, and ABSENT from the normal tree until promoted ─────────────
  await page.goto('/triage');
  await expect(page.getByText(NEW_REQUEST)).toBeVisible({ timeout: 30_000 });
  // Open the queue row → its detail attributes it to the public (cross-org)
  // submitter by name.
  await page.getByRole('button', { name: new RegExp(NEW_REQUEST) }).click();
  await expect(page.getByRole('heading', { name: NEW_REQUEST, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`Public submitter · ${CROSS_NAME}`)).toBeVisible();

  // It is excluded from the normal tree (the seeded request is the loaded-tree
  // control; the triage item is absent until promoted).
  await page.goto('/issues');
  await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible();
  await expect(page.getByTestId(`issue-row-${seed.existing.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${newReq.identifier}`)).toHaveCount(0);
});
