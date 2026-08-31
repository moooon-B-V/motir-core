// E2E: Story 8.9 — FOLLOW THE BUILD (Subtask 8.9.9). The PUSH half of the
// public project, in a real browser:
//
//   1. a LOGGED-OUT visitor opens `/p/<key>/changelog` and reads shipped items,
//      newest first, with no sign-in;
//   2. the ATOM FEED at `/p/<key>/changelog.xml` serves the same set to a
//      client with no cookies at all — fetched through the browser's request
//      context, which is the closest thing to a feed reader we can drive;
//   3. a PRIVATE EPIC's shipped descendant is ABSENT from both, and so is the
//      private epic's own shipped row — the thing that separates a stream from
//      the tree, where that row stays visible as a placeholder;
//   4. the visitor signs in, FOLLOWS the project, and the follow survives a
//      reload; then unfollows;
//   5. the subscribe popover offers the feed URL and a Copy control.
//
// The vitest suite pins the read model, the exclusion and the follow service;
// this file owns what only a browser proves — that the page renders the derived
// entries, that the feed is reachable and correctly typed over HTTP, and that
// the follow control's optimistic state agrees with the server after a full
// reload.
//
// Per the E2E discipline (CLAUDE.md): every mutation is awaited on its
// endpoint's RESPONSE before the assertion that depends on it, and the
// persisted claim is re-read by re-navigating rather than by trusting the
// optimistic island. There are no fixed sleeps.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { waitForDerivedStatus } from './_helpers/derivedStatus';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// ⚠️ MOVED TO THE CLOUD LANE (Story MOTIR-3908 · MOTIR-4038). This spec exercises
// the PUBLIC-PROJECTS capability, which is now cloud-only: with `MOTIR_CLOUD`
// unset `app/api/public/*` answers 404 and the publish affordance is not
// rendered. The MAIN lane sets no `MOTIR_CLOUD` (`playwright.config.ts` — and
// deliberately: turning it on there would activate the §4 entitlement caps and
// surface the billing row, breaking unrelated specs), so this spec would assert
// a product that is switched off. It runs in `playwright.cloud.config.ts`'s
// cloud-on lane instead, which is what the `cloud-` prefix selects.
//
// ⚠️ THE COST: that lane is the `billing-cloud` leg of `e2e-at-scale`, which runs
// on push-to-`main` and on a pull request carrying the `e2e-at-scale` LABEL — not
// on every pull request, as this spec did before. That is a real reduction in
// per-PR coverage and it is recorded rather than absorbed; the self-host arm the
// main lane keeps is `public-selfhost.spec.ts`. A per-PR cloud-on lane is the
// alternative and is its own card.

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const OWNER_EMAIL = 'e2e-follow-owner@example.com';
const FOLLOWER_EMAIL = 'e2e-follow-reader@example.com';
const PROJECT_KEY = 'FOL';

const SHIPPED_NEWER = 'Ship the changelog page';
const SHIPPED_OLDER = 'Ship the follow button';
const HIDDEN_CHILD = 'A secret capability nobody should read about';
const PRIVATE_EPIC = 'A programme nobody should read about';

/**
 * Move an item into `done` THROUGH the service, so the status revision the
 * changelog derives from is written the way production writes it — seeding the
 * row's status column directly would produce an item with no transition, which
 * is exactly the case the changelog correctly ignores.
 *
 * ⚠️ It WALKS THE LEGAL HOPS. The default workflow has no `todo → done` edge
 * (`lib/workflows/defaultWorkflow.ts`), so a direct jump throws
 * `IllegalTransitionError` — which is what the first version of this helper did.
 * Going the long way round is also the more honest fixture: a real item reaches
 * `done` through these states, and each hop writes its own revision, so the
 * changelog's "the LATEST into-done transition" is being exercised against a
 * trail with several status revisions rather than exactly one.
 */
async function shipItem(id: string, ctx: ServiceContext): Promise<void> {
  for (const status of ['in_progress', 'in_review', 'done']) {
    await workItemsService.updateStatus(id, status, ctx);
  }
}

/**
 * Owner signs up through the real UI, then the tree is built server-side (the
 * one sanctioned cross-layer reach for tests) and the project is flipped public
 * directly — the make-public TOGGLE is 6.12's surface and has its own spec; what
 * this file is about starts once the project is already public.
 */
async function seed(page: Page): Promise<{ ctx: ServiceContext; projectId: string }> {
  await signUp(page, OWNER_EMAIL);
  const local = OWNER_EMAIL.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email: OWNER_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'owner exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const ctx: ServiceContext = { userId: user!.id, workspaceId: ws!.id };

  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Follow The Build',
    identifier: PROJECT_KEY,
  });

  // Two ordinary shipped items — the older one first, so "newest first" is a
  // real ordering claim rather than creation order.
  const older = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: SHIPPED_OLDER, parentId: null },
    ctx,
  );
  await shipItem(older.id, ctx);
  const newer = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: SHIPPED_NEWER, parentId: null },
    ctx,
  );
  await shipItem(newer.id, ctx);

  // A PRIVATE epic with a shipped child, and the epic itself shipped too. Both
  // must be absent: 6.14 excludes the descendant, and the changelog additionally
  // excludes the epic's own row because a stream has no placeholder entry.
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: PRIVATE_EPIC, parentId: null },
    ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: HIDDEN_CHILD, parentId: epic.id },
    ctx,
  );
  await shipItem(child.id, ctx);
  // ⚠️ THE EPIC IS NOT SHIPPED BY HAND — IT IS ALREADY BEING SHIPPED (MOTIR-3915).
  // Completing its only child completes the epic by derivation, asynchronously.
  // The manual walk this replaced (`shipItem(epic.id, ctx)`) raced that job and
  // lost whenever the job won a hop: the walk read `done`, tried
  // `done -> in_review`, and threw `IllegalTransitionError` because that is not
  // an edge in the default workflow — the first recorded instance of this class
  // (MOTIR-3859, run 33223925559). Waiting for the derived value is both correct
  // and more honest: the epic reaches `done` the way production puts it there.
  await waitForDerivedStatus(epic.id, 'done');
  await workItemsService.setEpicPrivacy(epic.id, true, ctx);

  await db.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });

  return { ctx, projectId: project.id };
}

test('@smoke follow the build: a logged-out visitor reads the changelog and the feed, a private epic never appears, and a signed-in viewer follows and unfollows', async ({
  page,
  browser,
}) => {
  await seed(page);

  // ── 1. the LOGGED-OUT read ────────────────────────────────────────────────
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/p/${PROJECT_KEY}/changelog`);

  await expect(anonPage.getByRole('heading', { name: 'What shipped', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  // No sign-in anywhere on the read path.
  await expect(anonPage.getByText(SHIPPED_NEWER)).toBeVisible();
  await expect(anonPage.getByText(SHIPPED_OLDER)).toBeVisible();

  // Newest first — asserted on the RENDERED order, which is the claim the page
  // makes, not on the query behind it.
  const titles = await anonPage.locator('main a, li a').allInnerTexts();
  const newerAt = titles.findIndex((t) => t.includes(SHIPPED_NEWER));
  const olderAt = titles.findIndex((t) => t.includes(SHIPPED_OLDER));
  expect(newerAt).toBeGreaterThanOrEqual(0);
  expect(olderAt).toBeGreaterThan(newerAt);

  // ── 2 + 3. the private epic is absent from the PAGE ───────────────────────
  await expect(anonPage.getByText(HIDDEN_CHILD)).toHaveCount(0);
  await expect(anonPage.getByText(PRIVATE_EPIC)).toHaveCount(0);

  // ── the FEED, fetched with no cookies ─────────────────────────────────────
  const feed = await anon.request.get(`/p/${PROJECT_KEY}/changelog.xml`);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toContain('application/atom+xml');
  const xml = await feed.text();
  expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  expect(xml).toContain(SHIPPED_NEWER);
  // The same exclusion, on the surface that leaves the site and is cached by
  // third parties — the one where a leak is permanent.
  expect(xml).not.toContain(HIDDEN_CHILD);
  expect(xml).not.toContain(PRIVATE_EPIC);

  // The page advertises the feed, so a reader's "subscribe to this page" finds
  // it without anybody knowing the URL.
  await expect(anonPage.locator('link[rel="alternate"][type="application/atom+xml"]')).toHaveCount(
    1,
  );

  await anon.close();

  // ── 4. sign in, FOLLOW, and prove it persisted ────────────────────────────
  const readerCtx = await browser.newContext();
  const reader = await readerCtx.newPage();
  await signUp(reader, FOLLOWER_EMAIL);
  await reader.goto(`/p/${PROJECT_KEY}/changelog`);

  const followButton = reader.getByRole('button', { name: 'Follow' });
  await expect(followButton).toBeVisible({ timeout: 30_000 });

  // Arm the response wait BEFORE the click, or it can be missed entirely.
  const followWrite = reader.waitForResponse(
    (r) =>
      r.url().includes(`/api/public/p/${PROJECT_KEY}/follow`) && r.request().method() === 'POST',
  );
  await followButton.click();
  expect((await followWrite).status()).toBe(200);

  // The AUTHORITATIVE check: a full re-navigation re-reads the server, so this
  // asserts what was persisted rather than the optimistic value the click set.
  await reader.reload();
  // ⚠️ PARK THE POINTER FIRST. The followed button swaps its label to "Unfollow"
  // on hover/focus — the designed affordance (D1), so the action is legible
  // without relying on colour — and after a click the pointer is still sitting
  // on it, so the reloaded page renders the hover label immediately. Asserting
  // "Following" without moving away tests where Playwright left the mouse, not
  // what the server persisted.
  await reader.mouse.move(0, 0);
  await expect(reader.getByRole('button', { name: 'Following' })).toBeVisible({ timeout: 30_000 });

  // ── 5. the subscribe popover offers the anonymous tier ────────────────────
  await reader.getByRole('button', { name: 'Subscribe' }).click();
  await expect(reader.getByText(`/p/${PROJECT_KEY}/changelog.xml`)).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Copy' })).toBeVisible();
  await reader.keyboard.press('Escape');

  // ── UNFOLLOW, awaited the same way ────────────────────────────────────────
  const unfollowWrite = reader.waitForResponse(
    (r) =>
      r.url().includes(`/api/public/p/${PROJECT_KEY}/follow`) && r.request().method() === 'DELETE',
  );
  // Hovering swaps the label, so target the control by either name it can carry
  // at the moment of the click rather than racing the swap.
  await reader.getByRole('button', { name: /^(Following|Unfollow)$/ }).click();
  expect((await unfollowWrite).status()).toBe(200);

  await reader.reload();
  await reader.mouse.move(0, 0);
  await expect(reader.getByRole('button', { name: 'Follow', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await readerCtx.close();
});
