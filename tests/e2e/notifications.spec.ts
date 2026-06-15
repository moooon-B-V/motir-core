// E2E: the Story-5.7 in-app notification loop (Subtask 5.7.8) — the Story
// CLOSER, driving the real stack (Next dev server + the Inngest dev server that
// fans the SHIPPED 5.1.6 `work-item/comment.created` event into BOTH the email
// job (5.1.6) and the in-app fan-in job (5.7.3) + the file email outbox). Two
// passes:
//
//   1. @smoke journey — the bell + drawer loop a recipient actually lives:
//      the mentioner (B) @-mentions the recipient (A) in a comment through the
//      5.1 picker; A's bell badge increments; A opens the drawer → the mention
//      sits atop Direct with the unread blue-dot AND the *seen* badge clears
//      (the Jira seen-vs-read split); A clicks the row → it deep-links to the
//      issue AND marks read with the unread count decrementing FROM THE MUTATION
//      RESPONSE (no full reload — the inline-edit-no-tree-refresh contract);
//      two more mentions → "Mark all as read" in the overflow clears every dot
//      in ONE request and survives reload (the JRACLOUD-85017 regression is
//      absent). Self-exclusion is folded into mention #1, which mentions BOTH A
//      and B in one comment: A's row + A's email PROVE the event fully fanned
//      out, so B's absent row AND absent email are deterministic, not a race.
//   2. Preference cut — the single channel gate (5.7.6) driving both channels
//      independently, both off the /settings/account matrix: in-app OFF for
//      "Mentioned" stops the bell while the email still sends; email OFF (in-app
//      back on) stops the mail while the bell still increments.
//
// The async surfaces (the bell count, the email outbox) are waited on with
// AUTHORITATIVE signals per the CLAUDE.md E2E rule — the unread-count API
// (expect.poll), the mark-read / mark-all-read POST responses, the comment POST
// 201, and the outbox file — never an optimistic-UI race. Selectors target the
// stable role/label hooks the 5.7.5 / 5.7.6 components expose (the bell's
// pluralised accessible name, the "Notifications" drawer dialog, the
// "Notification options" overflow, the exact-named "Mark all as read", the
// "{channel} for {event}" preference switches) — never markup.

import { expect, test, type Browser, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import {
  COMMENTS_PASSWORD,
  seedCommentsFixture,
  type CommentsFixture,
} from './_helpers/comments-seed';

// Browser sign-up + the mention→fan-out round-trip through the real Inngest dev
// server (two consumers per event): comfortably more than the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The shell-header bell — its accessible name carries the live unread count. */
function bell(page: Page) {
  return page.getByRole('button', { name: /^Notifications,/ });
}

/** Sign a server-seeded member (created via usersService, not signed up) into a
 * fresh browser context, landing on /dashboard with the per-workspace shell —
 * and so the bell — mounted. */
async function signInMember(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, COMMENTS_PASSWORD);
  return page;
}

/** The recipient's server-side unread aggregate (the 5.7.4 partial-index count
 * the bell badge polls) — read through the page's own session cookies. The
 * authoritative signal the async fan-in commits to; -1 on a transient failure
 * so expect.poll keeps retrying. */
async function unreadCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications/unread-count');
  if (!res.ok()) return -1;
  return ((await res.json()) as { unreadCount: number }).unreadCount;
}

/** Wait until the recipient's unread aggregate reaches `expected` (the fan-in
 * job has written the row) — the deterministic gate before reloading the bell. */
async function waitUnread(page: Page, expected: number): Promise<void> {
  await expect
    .poll(() => unreadCount(page), { timeout: 30_000, message: `unread count → ${expected}` })
    .toBe(expected);
}

/** Mention emails the outbox holds for `email` (the 5.1.6 channel's footprint).
 * The outbox is cleared on every resetDatabase, so a test starts from zero. */
async function mentionEmailCount(email: string): Promise<number> {
  return (await emailsTo(email)).filter((e) => e.subject.includes('mentioned you')).length;
}

/**
 * Post a comment from the mentioner's page that @-mentions every `target` (each
 * a unique-match picker query + its option label), through the 5.1 picker's
 * keyboard path.
 *
 * The submit is a **Server Action** (`commentActions.ts`), not a REST POST, so
 * there is no comments-endpoint response to wait on. The authoritative commit
 * signal — the one `comments.spec` itself relies on — is the `new` composer
 * collapsing back to its rest invitation: it only reappears once the action
 * RESOLVES, i.e. the comment row is committed and its post-commit
 * `work-item/comment.created` event is emitted. The async fan-in that event
 * drives is then awaited separately via the unread-count API (`waitUnread`).
 */
async function postMention(
  page: Page,
  targets: { query: string; option: RegExp }[],
): Promise<void> {
  await page.getByRole('button', { name: 'Add a comment…' }).click();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await page.locator('.ProseMirror').click();
  for (const target of targets) {
    await page.keyboard.type(`@${target.query}`);
    const picker = page.getByRole('listbox', { name: 'Mention a member' });
    await expect(picker).toBeVisible();
    // A unique-match query → the only option is the active row (index 0), so a
    // bare Enter selects it (the picker clamps active to the filtered set).
    await expect(picker.getByRole('option', { name: target.option })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await page.keyboard.type(' ');
  }
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  // Composer collapsed → the Server Action resolved → comment committed + event
  // emitted (the deterministic commit signal; fan-in is gated by waitUnread).
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();
}

/** Bo Philips — the recipient (A) the fixture mints. */
const BO = { query: 'Bo', option: /Bo Philips/ } as const;

/** The PM/mentioner (B) as a mention TARGET — name = the email local part. */
function selfTarget(fx: CommentsFixture): { query: string; option: RegExp } {
  const local = fx.pm.email.split('@')[0]!;
  return { query: local, option: new RegExp(local) };
}

test('@smoke mention → bell increment → drawer (seen) → click → read → decrement → mark-all → reload; self-excluded', async ({
  page,
  browser,
}) => {
  // B (the mentioner) signs up in this page + gets Bo (A, the recipient) and the
  // issue server-side; A signs into a second context.
  const fx = await seedCommentsFixture(
    page,
    'e2e-notif-pm@example.com',
    'e2e-notif-bo@example.com',
  );
  const pageA = await signInMember(browser, fx.bo.email);

  // A starts caught-up: zero badge.
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, no unread');

  // ── 1. B mentions A AND B in one comment (self-exclusion, deterministically) ─
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task' })).toBeVisible();
  await postMention(page, [BO, selfTarget(fx)]);

  // The ONE event fans to both channels for A only. Waiting on A's row (in-app)
  // AND A's email (email) proves the fan-out completed — so B's absence below is
  // self-exclusion, not a race.
  await waitUnread(pageA, 1);
  const aMention = await waitForEmail(fx.bo.email, { timeoutMs: 30_000 });
  expect(aMention.subject).toContain('mentioned you');

  // B — the actor — is excluded on BOTH channels though mentioned in the same
  // comment: no in-app row, no email, bell stays caught-up.
  expect(await unreadCount(page)).toBe(0);
  expect(await mentionEmailCount(fx.pm.email)).toBe(0);
  await expect(bell(page)).toHaveAccessibleName('Notifications, no unread');

  // ── 2. A's bell increments; opening the drawer marks the badge SEEN ─────────
  await pageA.reload();
  // The seen badge pill (the only text in the bell button) shows the new count…
  await expect(bell(pageA)).toContainText('1');
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, 1 unread');

  await bell(pageA).click();
  const drawer = pageA.getByRole('dialog', { name: 'Notifications' });
  await expect(drawer).toBeVisible();
  // Opening clears the SEEN badge (Jira seen-count) — while the row stays UNREAD
  // (the accessible name still reports 1), proving the seen-vs-read split.
  await expect(bell(pageA)).not.toContainText('1');
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, 1 unread');
  const row = drawer.getByRole('link', { name: /mentioned you on/ });
  await expect(row).toBeVisible();

  // ── 3. Click the row → deep-link to the issue AND mark read; count decrements
  //        from the response with NO whole-page reload (the inline-edit contract)
  const read = pageA.waitForResponse(
    (r) => /\/api\/notifications\/[^/]+\/read$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await row.click();
  expect((await read).status()).toBe(200);
  await pageA.waitForURL(`**/issues/${fx.issue.identifier}`);
  // The badge cleared live — no pageA.reload() between the click and this assert.
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, no unread');

  // ── 4. Two more mentions → "Mark all as read" clears every dot in ONE request
  //        and survives reload ───────────────────────────────────────────────
  await postMention(page, [BO]);
  await waitUnread(pageA, 1);
  await postMention(page, [BO]);
  await waitUnread(pageA, 2);

  await pageA.reload();
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, 2 unread');
  await bell(pageA).click();
  await expect(pageA.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await pageA.getByRole('button', { name: 'Notification options' }).click();
  const markAll = pageA.waitForResponse(
    (r) => r.url().includes('/api/notifications/mark-all-read') && r.request().method() === 'POST',
  );
  await pageA.getByRole('button', { name: 'Mark all as read' }).click();
  expect((await markAll).status()).toBe(200);
  // Cleared from the response — no reload.
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, no unread');
  // …and it persists: a fresh load reads zero unread from the server.
  await pageA.reload();
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, no unread');
});

test('preference cut — one gate, both channels: in-app off stops the bell (email sends); email off stops the mail (bell increments)', async ({
  page,
  browser,
}) => {
  const fx = await seedCommentsFixture(
    page,
    'e2e-notif-pref-pm@example.com',
    'e2e-notif-pref-bo@example.com',
  );
  const pageA = await signInMember(browser, fx.bo.email);
  await page.goto(`/issues/${fx.issue.identifier}`);
  await expect(page.getByRole('heading', { name: 'Commented task' })).toBeVisible();

  // ── A turns IN-APP off for "Mentioned" on the notifications matrix ───────────
  // The account settings are an AREA now (7.8.12): the matrix lives in its own
  // pane; `/settings/account` redirects to the Language pane, so go straight to
  // the notifications route.
  await pageA.goto('/settings/account/notifications');
  await expect(pageA.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  const inApp = pageA.getByRole('switch', { name: 'In-app for Mentioned' });
  const email = pageA.getByRole('switch', { name: 'Email for Mentioned' });
  await expect(inApp).toBeChecked(); // the documented default — on until turned off
  let saved = pageA.waitForResponse(
    (r) => r.url().includes('/api/notification-preferences') && r.request().method() === 'PUT',
  );
  await inApp.click();
  expect((await saved).status()).toBe(200);
  await expect(inApp).not.toBeChecked();

  // B mentions A → the EMAIL channel fires (gate untouched) but the IN-APP row
  // is suppressed. Wait on the email (the positive signal the event processed),
  // then assert the bell never moved off zero.
  await postMention(page, [BO]);
  const firstEmail = await waitForEmail(fx.bo.email, { timeoutMs: 30_000 });
  expect(firstEmail.subject).toContain('mentioned you');
  expect(await mentionEmailCount(fx.bo.email)).toBe(1);
  expect(await unreadCount(pageA)).toBe(0); // in-app gated off → no row
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, no unread');

  // ── A flips it: IN-APP back on, EMAIL off — for the SAME "Mentioned" event ──
  saved = pageA.waitForResponse(
    (r) => r.url().includes('/api/notification-preferences') && r.request().method() === 'PUT',
  );
  await inApp.click();
  expect((await saved).status()).toBe(200);
  await expect(inApp).toBeChecked();
  saved = pageA.waitForResponse(
    (r) => r.url().includes('/api/notification-preferences') && r.request().method() === 'PUT',
  );
  await email.click();
  expect((await saved).status()).toBe(200);
  await expect(email).not.toBeChecked();

  // B mentions A again → now the IN-APP row lands (bell increments) but NO new
  // email is sent. Wait on the in-app row (positive signal), then assert the
  // email count is unchanged from the first case (still 1).
  await postMention(page, [BO]);
  await waitUnread(pageA, 1);
  await pageA.reload();
  await expect(bell(pageA)).toHaveAccessibleName('Notifications, 1 unread');
  expect(await mentionEmailCount(fx.bo.email)).toBe(1); // email gated off → no new mail
});
