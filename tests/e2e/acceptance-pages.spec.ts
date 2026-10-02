import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// WRITE A PAGE — THE ACCEPTANCE RECEIPT (Story MOTIR-5752 · Subtask MOTIR-7282).
// The story's verification recipe, in a real browser against a production build
// and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Three chapters, each the story's promise from one seat: a Member writes a page
// with the editor's real toolbar and reads back exactly what they typed; two
// sessions editing the same page from stale copies both keep their edits; and a
// Viewer reads the page with nothing to type into. The typing is paced
// (`pressSequentially` with a delay) so the clip shows the words landing.
//
// The three tests after the recorded one are the story's refusals and failure
// states — not-found for a non-member, the offline indicator, the too-large
// callout — asserted at machine speed with no chapters.
//
// ── THE WAITS (CLAUDE.md § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every body save is waited on by its own `POST /api/pages/<id>/updates`
// response, ARMED BEFORE the input that triggers it, and its status asserted;
// the save indicator is asserted after that response, never used as the wait.
// The autosave loop sends one batch after 1 s of quiet, capped at 5 s of
// continuous typing (`packages/pages/src/editor/autosave.ts`), so each typed
// burst below is kept well under 5 s: it then produces exactly ONE request, and
// the response the wait resolves on is that burst's. New page is waited on by
// its `POST /api/pages`, and the title by its `PATCH /api/pages/<id>`.

const PASSWORD = 'acceptance-pages-e2e-pass-123';
const MEMBER_EMAIL = 'acceptance-pages-member@example.com';
const VIEWER_EMAIL = 'acceptance-pages-viewer@example.com';
const OUTSIDER_EMAIL = 'acceptance-pages-outsider@example.com';

/** Visible typing — slow enough to watch, fast enough to keep a burst one save. */
const TYPING = { delay: 55 };

const TITLE = 'Release runbook';
const HEADING = 'Release checklist';
const PARAGRAPH_ONE = 'Run this before every release.';
const PARAGRAPH_TWO = 'Ask in the release channel if stuck.';
const LIST_ITEMS = ['Tag the commit', 'Push the tag'];
const CODE = 'git tag v1.4.0 && git push --tags';
const LANGUAGE = 'bash';

const EDIT_A = ' Owner: Ana.';
const EDIT_B = ' Ben is on call.';

interface Seed {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
}

async function seedProject(): Promise<Seed> {
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Pages Workspace',
    ownerUserId: member.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: member.id,
    name: 'Release train',
    identifier: 'RLS',
  });
  // Pinned active through the product's own write, so `/pages` resolves it.
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: member.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
  };
}

/** A Viewer of the seeded project, granted through the product's own member write. */
async function seedViewer(seed: Seed): Promise<void> {
  const viewer = await usersService.createUser({
    email: VIEWER_EMAIL,
    password: PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: seed.workspaceId });
  await addToProjectAs({
    key: seed.projectIdentifier,
    actorUserId: seed.ctx.userId,
    ctx: seed.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectsService.setActiveProject({
    userId: viewer.id,
    workspaceId: seed.workspaceId,
    projectId: seed.projectId,
  });
}

/** One body save of `pageId`, armed by the caller BEFORE the input that triggers it. */
function bodySave(page: Page, pageId: string): Promise<Response> {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/api/pages/${pageId}/updates`) && r.request().method() === 'POST',
  );
}

const bodyOf = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Formatting', exact: true });
/** Scoped to the toolbar: the indicator is its trailing end; the shell has live regions too. */
const indicatorOf = (page: Page) => toolbarOf(page).getByRole('status');

/**
 * Run `input` — one burst of typing — and wait on the ONE save it produces: the
 * wait is armed first, its status asserted, and only then the indicator read.
 */
async function savedAfter(page: Page, pageId: string, input: () => Promise<void>): Promise<void> {
  const saved = bodySave(page, pageId);
  await input();
  expect((await saved).status()).toBe(200);
  await expect(indicatorOf(page)).toHaveText('Saved');
}

/** Put the caret at the end of the paragraph that starts with `text`, and type. */
async function appendToParagraph(body: Locator, page: Page, text: string, typed: string) {
  await body.getByText(text).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed, TYPING);
}

test('a member writes a page and reads it back; two sessions both keep their edits; a viewer only reads', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5752');
  test.setTimeout(240_000);

  await resetDatabase();
  const seed = await seedProject();
  await seedViewer(seed);
  // An older page, so "listed first" means the new page went to the top.
  await pagesService.createPage(seed.ctx, { projectId: seed.projectId, title: 'Onboarding notes' });

  await signIn(page, MEMBER_EMAIL, PASSWORD);

  let pageId = '';

  await chapter(
    'A Member writes a page — title, heading, list and code — and reads it back',
    async () => {
      // From the project sidebar's Pages entry.
      await page.getByRole('link', { name: 'Pages', exact: true }).click();
      await page.waitForURL('**/pages');
      await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeVisible();

      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/pages') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'New page', exact: true }).click();
      const createdResponse = await created;
      expect(createdResponse.status()).toBe(201);
      pageId = ((await createdResponse.json()) as { id: string }).id;
      await page.waitForURL(`**/pages/${pageId}`);

      const title = page.getByRole('textbox', { name: 'Page title', exact: true });
      const body = bodyOf(page);
      await expect(body).toBeVisible();
      await expect(title).toBeFocused();

      // The title is its own write: Enter hands the caret to the body, and the
      // blur sends the rename.
      const renamed = page.waitForResponse(
        (r) => r.url().endsWith(`/api/pages/${pageId}`) && r.request().method() === 'PATCH',
      );
      await title.pressSequentially(TITLE, TYPING);
      await title.press('Enter');
      expect((await renamed).status()).toBe(200);

      // A heading, from the toolbar.
      await savedAfter(page, pageId, async () => {
        await page.getByRole('button', { name: 'Heading', exact: true }).click();
        await page.keyboard.type(HEADING, TYPING);
        await page.keyboard.press('Enter');
      });
      // Two paragraphs — the second chapter edits one in each session.
      await savedAfter(page, pageId, async () => {
        await page.keyboard.type(PARAGRAPH_ONE, TYPING);
        await page.keyboard.press('Enter');
      });
      await savedAfter(page, pageId, async () => {
        await page.keyboard.type(PARAGRAPH_TWO, TYPING);
        await page.keyboard.press('Enter');
      });
      // A bulleted list, from the toolbar; a second Enter on an empty item leaves it.
      await savedAfter(page, pageId, async () => {
        await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
        await page.keyboard.type(LIST_ITEMS[0]!, TYPING);
        await page.keyboard.press('Enter');
        await page.keyboard.type(LIST_ITEMS[1]!, TYPING);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
      });
      // A code block, from the toolbar, then its language in the block's own field.
      await savedAfter(page, pageId, async () => {
        await page.getByRole('button', { name: 'Code block', exact: true }).click();
        await page.keyboard.type(CODE, TYPING);
      });
      await savedAfter(page, pageId, async () => {
        await page.getByRole('textbox', { name: 'Language', exact: true }).click();
        await page.keyboard.type(LANGUAGE, TYPING);
      });
      await beat();

      // After a reload, every one is exactly as typed.
      await page.reload();
      await expect(title).toHaveValue(TITLE);
      await expect(body.getByRole('heading', { level: 2 })).toHaveText(HEADING);
      await expect(body.getByText(PARAGRAPH_ONE, { exact: true })).toBeVisible();
      await expect(body.getByText(PARAGRAPH_TWO, { exact: true })).toBeVisible();
      await expect(body.getByRole('listitem')).toHaveText(LIST_ITEMS);
      const code = body.locator('pre code');
      await expect(code).toHaveText(CODE);
      await expect(code).toHaveClass(`language-${LANGUAGE}`);
      // The Language field shows on the block holding the caret.
      await code.click();
      await expect(page.getByRole('textbox', { name: 'Language', exact: true })).toHaveValue(
        LANGUAGE,
      );
      await expect(page).toHaveTitle(TITLE);
      await beat();

      // Back on /pages, the page is listed first under its title.
      await page.getByRole('link', { name: 'Back to Pages', exact: true }).click();
      await page.waitForURL('**/pages');
      const rows = page.getByRole('list', { name: 'Pages in this project' }).getByRole('link');
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toHaveAttribute('href', `/pages/${pageId}`);
      await expect(rows.first()).toContainText(TITLE);
      await expect(rows.nth(1)).toContainText('Onboarding notes');
    },
  );

  // Session B: the same Member, signed in again in a second browser context.
  // Off camera — the clip follows session A, whose reload shows B's edit arrive.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await signIn(pageB, MEMBER_EMAIL, PASSWORD);

    await chapter(
      'Two sessions edit different paragraphs — after a reload both edits are there',
      async () => {
        // Both sessions open the page before either edits.
        await page.goto(`/pages/${pageId}`);
        await pageB.goto(`/pages/${pageId}`);
        const bodyA = bodyOf(page);
        const bodyB = bodyOf(pageB);
        await expect(bodyA.getByText(PARAGRAPH_ONE, { exact: true })).toBeVisible();
        await expect(bodyB.getByText(PARAGRAPH_TWO, { exact: true })).toBeVisible();

        // Session A edits the first paragraph…
        await savedAfter(page, pageId, () => appendToParagraph(bodyA, page, PARAGRAPH_ONE, EDIT_A));
        // …and session B, from its stale copy, a different one.
        await savedAfter(pageB, pageId, () =>
          appendToParagraph(bodyB, pageB, PARAGRAPH_TWO, EDIT_B),
        );
        // B never saw A's edit before saving — its copy was stale.
        await expect(bodyB.getByText(PARAGRAPH_ONE + EDIT_A, { exact: true })).toHaveCount(0);
        await beat();

        // After a reload in both, both edits are present.
        await page.reload();
        await pageB.reload();
        for (const body of [bodyOf(page), bodyOf(pageB)]) {
          await expect(body.getByText(PARAGRAPH_ONE + EDIT_A, { exact: true })).toBeVisible();
          await expect(body.getByText(PARAGRAPH_TWO + EDIT_B, { exact: true })).toBeVisible();
        }
      },
    );
  } finally {
    await contextB.close();
  }

  await chapter(
    'A Viewer reads the page — no New page, no toolbar, nothing to type into',
    async () => {
      await signIn(page, VIEWER_EMAIL, PASSWORD);
      await page.getByRole('link', { name: 'Pages', exact: true }).click();
      await page.waitForURL('**/pages');
      const row = page
        .getByRole('list', { name: 'Pages in this project' })
        .getByRole('link')
        .filter({ hasText: TITLE });
      await expect(row).toBeVisible();
      await expect(page.getByRole('button', { name: 'New page', exact: true })).toHaveCount(0);

      await row.click();
      await page.waitForURL(`**/pages/${pageId}`);
      await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
      const body = bodyOf(page);
      await expect(body.getByRole('heading', { name: HEADING, level: 2 })).toBeVisible();
      await expect(body.getByText(PARAGRAPH_ONE + EDIT_A, { exact: true })).toBeVisible();
      await expect(body.getByRole('listitem')).toHaveText(LIST_ITEMS);
      await expect(body.locator('pre code')).toHaveText(CODE);

      // Read-only: no toolbar, no save indicator, no editable region, no title field.
      await expect(body).toHaveAttribute('contenteditable', 'false');
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(toolbarOf(page)).toHaveCount(0);
      await expect(page.locator('.motir-page-editor [role="status"]')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveCount(0);
    },
  );
});

/** A seeded project, one page in it, and the Member signed in on that page. */
async function memberOnSeededPage(page: Page): Promise<string> {
  await resetDatabase();
  const seed = await seedProject();
  const created = await pagesService.createPage(seed.ctx, {
    projectId: seed.projectId,
    title: TITLE,
  });
  await signIn(page, MEMBER_EMAIL, PASSWORD);
  const res = await page.goto(`/pages/${created.id}`);
  expect(res?.status()).toBe(200);
  await expect(bodyOf(page)).toBeVisible();
  await expect(indicatorOf(page)).toHaveText('Saved');
  return created.id;
}

test('a signed-in user with no access to the project gets the not-found page', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject();
  const created = await pagesService.createPage(seed.ctx, {
    projectId: seed.projectId,
    title: TITLE,
  });

  // A user of another workspace, with a project of their own and none of this one.
  const outsider = await usersService.createUser({
    email: OUTSIDER_EMAIL,
    password: PASSWORD,
    name: 'Otto Outsider',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Elsewhere',
    ownerUserId: outsider.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: outsider.id,
    name: 'Elsewhere project',
    identifier: 'ELS',
  });
  await projectsService.setActiveProject({
    userId: outsider.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });

  await signIn(page, OUTSIDER_EMAIL, PASSWORD);
  const res = await page.goto(`/pages/${created.id}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await expect(page.getByText(TITLE)).toHaveCount(0);
});

test('offline, then saved: a blocked save reads offline, and the edit lands once it is unblocked', async ({
  page,
}) => {
  const pageId = await memberOnSeededPage(page);
  const updates = `**/api/pages/${pageId}/updates`;
  await page.route(updates, (route) => route.abort('internetdisconnected'));

  const failed = page.waitForEvent(
    'requestfailed',
    (r) => r.url().endsWith(`/api/pages/${pageId}/updates`) && r.method() === 'POST',
  );
  await bodyOf(page).click();
  await page.keyboard.type('Written while offline.', TYPING);
  await failed;
  await expect(indicatorOf(page)).toHaveText('Offline — edits kept');

  // Unblocked: the loop's retry carries the kept edit.
  const saved = bodySave(page, pageId);
  await page.unroute(updates);
  expect((await saved).status()).toBe(200);
  await expect(indicatorOf(page)).toHaveText('Saved');

  await page.reload();
  await expect(bodyOf(page)).toHaveText('Written while offline.');
});

test('too large: a 413 from the save door shows the too-large state', async ({ page }) => {
  const pageId = await memberOnSeededPage(page);
  // Only the RESPONSE is stubbed: the request is the editor's own save.
  await page.route(`**/api/pages/${pageId}/updates`, (route) =>
    route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PAGE_BODY_TOO_LARGE', limit: 2_097_152 }),
    }),
  );

  const refused = bodySave(page, pageId);
  await bodyOf(page).click();
  await page.keyboard.type('One paragraph too many.', TYPING);
  expect((await refused).status()).toBe(413);

  await expect(indicatorOf(page)).toHaveText('Not saved');
  const callout = page.getByRole('alert').filter({ hasText: 'This page is too large to save' });
  await expect(callout).toBeVisible();
  await expect(callout).toContainText('past its 2 MB limit');
  await expect(callout.getByRole('button', { name: 'Reload saved version' })).toBeVisible();
  await expect(callout.getByRole('button', { name: 'New page in a new tab' })).toBeVisible();
  // The content stays in the editor, to be copied out.
  await expect(bodyOf(page)).toHaveText('One paragraph too many.');
});
