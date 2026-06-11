// E2E: the Story-5.1 comments + @mentions lifecycle (Subtask 5.1.7) — the
// Story CLOSER, driving the real stack (Next dev server + Inngest dev server +
// the file email outbox). Three passes:
//
//   1. @smoke journey — add a comment in the detail page's Activity slot;
//      @-mention Bo through the picker's KEYBOARD path (type → ↓ → Enter);
//      assert the posted mention chip AND the `[EMAIL]` outbox delivery to Bo
//      (subject naming the author + the issue identifier, deep link unredacted
//      in the plain text) with NO self-notification; reply (the replied-to
//      author auto-mentioned) and reply-to-the-reply staying SINGLE-level;
//      edit → "· Edited" tag; delete the thread root → the confirm popover
//      names the reply count → hard-delete cascade + the comment_deleted
//      revision trail.
//   2. At-scale (finding #57) — a 105-comment fixture: first paint shows the
//      newest 20 behind "Show more comments (85 older)", extending appends a
//      cursor page, the sort toggle flips presentation WITHOUT refetching, and
//      no comments read ever exceeds the page size (never load-all).
//   3. Role pass — a project `viewer` sees the thread but no composer and no
//      per-row affordances (the 6.4 read-only grammar).
//
// Epic-wide collaboration journeys stay Story 5.6; the strict axe sweep over
// this surface extends shell-a11y.spec.ts (the 2.4.6 sweep file). Selectors
// target the stable role/label hooks the 5.1.5 components expose (the
// "Comments" list / "Replies" lists, the "Add a comment…" rest invitation,
// the "Mention a member" listbox, the exact-named "Comment" / "Reply" /
// "Save" / "Delete" actions, the sort toggle's aria-label) — never markup.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import {
  COMMENTS_PASSWORD,
  seedCommentsFixture,
  seedScaleComments,
  seedViewer,
} from './_helpers/comments-seed';

// Browser sign-up + project + the mention→email round-trip through the real
// Inngest dev server: comfortably more than the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The comments thread list (ul[aria-label="Comments"]). */
function threadList(page: Page) {
  return page.getByRole('list', { name: 'Comments' });
}

/** Expand the rest-state invitation into the live composer. */
async function openComposer(page: Page) {
  await page.getByRole('button', { name: 'Add a comment…' }).click();
  await expect(page.locator('.ProseMirror')).toBeVisible();
}

/** Post a plain root comment through the composer. */
async function postComment(page: Page, text: string) {
  await openComposer(page);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  // The `new` composer collapses back to rest on success.
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();
}

test('@smoke comment → mention → email → reply → edit → delete, end to end', async ({ page }) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-comments-pm@example.com',
    'e2e-comments-bo@example.com',
  );
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task' })).toBeVisible();

  // The Activity slot renders the comments surface, starting inviting-empty.
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.getByText(/No comments yet/)).toBeVisible();

  // ── 1. Add a root comment ────────────────────────────────────────────────
  await postComment(page, 'First comment from the PM');
  const list = threadList(page);
  await expect(list.getByText('First comment from the PM')).toBeVisible();
  // The section header's count gloss ("— 1 comment").
  await expect(page.getByText(/—\s*1 comment$/)).toBeVisible();

  // ── 2. Mention Bo via the picker's KEYBOARD path (type → ↓ → Enter) ─────
  await openComposer(page);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Ping @Bo');
  const picker = page.getByRole('listbox', { name: 'Mention a member' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option', { name: /Bo Philips/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await page.keyboard.type('please review');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  // The posted body renders the designed user chip, not a raw token.
  await expect(list.locator('.mention-chip', { hasText: '@Bo Philips' })).toBeVisible();
  await expect(list.getByText(/mention:/)).toHaveCount(0);

  // ── 3. The mention email reaches Bo (and never the author) ──────────────
  const email = await waitForEmail(fx.bo.email, { timeoutMs: 30_000 });
  expect(email.subject).toBe(
    `${fx.pm.name} mentioned you on ${fx.issue.identifier}: Commented task`,
  );
  // Deep link unredacted in the plain text — the dev-console grep contract.
  expect(email.text).toContain(`/issues/${fx.issue.identifier}`);
  const selfEmails = await emailsTo(fx.pm.email);
  expect(selfEmails.filter((e) => e.subject.includes('mentioned you'))).toEqual([]);

  // ── 4. Reply — the replied-to author arrives pre-mentioned ──────────────
  const rootRow = list.getByRole('listitem').filter({ hasText: 'First comment from the PM' });
  await rootRow.getByRole('button', { name: 'Reply', exact: true }).first().click();
  // The Jira auto-tag: the reply composer opens seeded with the author chip.
  await expect(page.locator('.ProseMirror .mention-chip')).toContainText(`@${fx.pm.name}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type('a reply from myself');
  // Within the thread's own li, DOM order puts the composer's submit after
  // the row actions — .last(). (Page-wide .last() would hit the NEXT root's
  // Reply action instead.)
  await rootRow.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const replies = rootRow.getByRole('list', { name: 'Replies' });
  await expect(replies.getByText(/a reply from myself/)).toBeVisible();

  // ── 5. Reply to the REPLY — attaches to the same thread, single level ───
  await replies.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await expect(page.locator('.ProseMirror .mention-chip')).toContainText(`@${fx.pm.name}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type('second reply, same thread');
  await rootRow.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(replies.getByText(/second reply, same thread/)).toBeVisible();
  // Single-level threading: both replies sit in the ONE thread rail; a reply
  // never grows its own Replies list.
  await expect(rootRow.getByRole('list', { name: 'Replies' })).toHaveCount(1);

  // ── 6. Edit the root → the "Edited" tag shows ────────────────────────────
  await rootRow.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (updated)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rootRow.getByText(/First comment from the PM \(updated\)/)).toBeVisible();
  await expect(rootRow.getByText('· Edited').first()).toBeVisible();

  // ── 7. Delete the root — the confirm names the cascade's reply count ────
  await rootRow.getByRole('button', { name: 'Delete', exact: true }).first().click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText(/Also deletes 2 replies/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

  // Hard delete: the whole thread is gone; the mention comment remains.
  await expect(list.getByText(/First comment from the PM/)).toHaveCount(0);
  await expect(list.getByText(/a reply from myself/)).toHaveCount(0);
  await expect(page.getByText(/—\s*1 comment$/)).toBeVisible();
  // …and the History trail recorded THAT a comment was deleted, and by whom.
  const revisions = await db.workItemRevision.findMany({
    where: { workItemId: fx.issue.id, changeKind: 'comment_deleted' },
  });
  expect(revisions).toHaveLength(1);
  expect(revisions[0]?.changedById).toBe(fx.pm.id);
});

test('at scale the read stays cursor-paged: 20 + "Show more", sort flips without refetch (finding #57)', async ({
  page,
}) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-comments-scale@example.com',
    'e2e-comments-scale-bo@example.com',
  );
  await seedScaleComments(fx, 105);

  // Track every comments-API response the page makes; none may carry more
  // than the page size (the unbounded-read guard).
  const pageSizes: number[] = [];
  page.on('response', (res) => {
    if (!/\/api\/work-items\/[^/]+\/comments/.test(res.url())) return;
    void res
      .json()
      .then((body: { threads?: unknown[] }) => {
        if (Array.isArray(body.threads)) pageSizes.push(body.threads.length);
      })
      .catch(() => {});
  });

  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task' })).toBeVisible();
  await expect(page.getByText(/—\s*105 comments$/)).toBeVisible();

  // First paint: the NEWEST 20 (86…105) in the oldest-first default display;
  // older rows stay behind the show-more edge — never in the DOM.
  const list = threadList(page);
  await expect(list.getByText('comment 86', { exact: true })).toBeVisible();
  await expect(list.getByText('comment 105', { exact: true })).toBeVisible();
  await expect(list.getByText('comment 85', { exact: true })).toHaveCount(0);

  // Extend backward one cursor page.
  await page.getByRole('button', { name: 'Show more comments (85 older)' }).click();
  await expect(list.getByText('comment 66', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more comments (65 older)' })).toBeVisible();

  // Oldest-first display: the oldest LOADED row leads (after the top edge).
  const items = list.locator('> li');
  await expect(items.nth(1)).toContainText('comment 66');

  // The sort toggle re-orders the loaded window without a refetch. (5.5.4
  // activated the Activity seam: the ONE toggle now governs every tab, so its
  // accessible name is the section-wide form the 5.5.3 design pins — "Sort
  // activity, …"; the flip behaviour under test is unchanged.)
  const fetchesBeforeFlip = pageSizes.length;
  await page.getByRole('button', { name: 'Sort activity, oldest first' }).click();
  await expect(items.first()).toContainText('comment 105');
  await expect(page.getByRole('button', { name: 'Sort activity, newest first' })).toBeVisible();
  expect(pageSizes.length).toBe(fetchesBeforeFlip);

  // Every network read stayed within the page size — the load-all read the
  // finding-#57 rule forbids never fired.
  expect(pageSizes.length).toBeGreaterThan(0);
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(20);
});

test('a project viewer gets the read-only surface: thread visible, no composer, no actions', async ({
  page,
}) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-comments-pm2@example.com',
    'e2e-comments-bo2@example.com',
  );
  // One comment to view — seeded directly (the write path is the journey's).
  await db.comment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: fx.issue.id,
      authorId: fx.pm.id,
      bodyMd: 'visible to the viewer',
    },
  });
  await seedViewer(fx, 'e2e-comments-viewer@example.com');

  // Fresh session as the viewer.
  await page.context().clearCookies();
  await signIn(page, 'e2e-comments-viewer@example.com', COMMENTS_PASSWORD);
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task' })).toBeVisible();

  const list = threadList(page);
  await expect(list.getByText('visible to the viewer')).toBeVisible();
  // The read-only notice replaces the composer (panel 9); no rest invitation,
  // and no per-row affordances anywhere in the thread.
  await expect(page.getByText(/Read-only access/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});
