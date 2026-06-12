// E2E: the combined collaboration journey (Story 5.6 · Subtask 5.6.2) — one
// issue through EVERY Epic-5 feature in ONE continuous flow, asserting the
// seams that only exist BETWEEN stories. Each sibling story's closer
// (5.1.7 / 5.2.8 / 5.3.8 / 5.4.11 / 5.5.5) proves its OWN link in isolation;
// this spec proves the CHAIN — a single comment that embeds an upload,
// @mentions a watcher, and lands in the activity feed touches five stories'
// code in one transaction chain, and the unwind unpicks it without leaving an
// orphan, a stale notification, or a renderer that crashes on a vanished
// referent.
//
// Seam map (assert → the seam it owns; nothing here re-tests a story's own
// surface — that is the cited closer's job):
//   * the embed shows EDITOR-SOURCED in the panel  → 5.2.3 link-on-write ran
//     inside 5.1.2's comment write tx (the cross-tx seam);
//   * Bo gets EXACTLY ONE email (the mention), never the watcher email;
//     Odie (watching, not mentioned) gets the watcher email; the author none
//                                                   → 5.4.5 one-email-per-person
//     dedupe across the mention + watcher jobs (the combined recipient split);
//   * the All feed interleaves the field/label/component history with the live
//     comment in one stream                         → 5.5.2 composite read over
//     5.1 + 5.3 + 5.4 writes;
//   * comment delete → the embed UNLINKS from the panel + History records the
//     deletion (no content) + no further mail        → 5.1.2 cascade × 5.2.3
//     unlink × 5.4.5 vanish-tolerance;
//   * a select option archived in use keeps rendering (archived mark); the
//     field then deleted leaves the rail card gone but the History stream still
//     renders past the dangling referent             → 5.5.1 fallback on the
//     COMBINED page (the state no per-story sweep renders);
//   * a transition mails BOTH watchers, actor excluded → 5.4.5 transition fan-out.
//
// The service-layer DB-state proofs the browser can't see (no orphan mention
// rows / attachment links / revision gaps; exact recipient SETS) live in the
// Vitest companion `tests/integration/collab-journey.test.ts`.
//
// Personas are seeded server-side (the 5.3.8 / 5.4.11 grammar: usersService +
// workspacesService + projectsService + the custom-field / component services
// + a direct watcher write — the sanctioned setup reach), then the journey is
// driven through the real stack (Next dev server + Inngest dev server + the
// file email outbox). Selectors target the stable role/label hooks the Epic-5
// components expose — never markup.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { watchersService } from '@/lib/services/watchersService';

const PWD = 'collab-journey-e2e-pass-123';
const PROJECT_NAME = 'Collab Journey Project';
// 3 chars — `projectsService` normalizes a shorter handle (it pads to the
// 3-char minimum, e.g. `CJ` → `CJX`), so the seeded key would no longer match
// what the field/component services resolve. `tenant.key` carries the ACTUAL
// stored identifier regardless, but a valid constant keeps the two equal.
const PROJECT_KEY = 'CJX';
const ISSUE_TITLE = 'Combined journey issue';

// Tenant + 3 personas + the rail's long picker flows + several real
// mention/watcher/transition email round-trips through the dev Inngest server:
// well past the 30s default (the 5.4.11 ceiling).
test.describe.configure({ timeout: 180_000 });

interface Persona {
  id: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  /** The project's ACTUAL stored identifier (post-normalization) — the key the
   *  field/component services resolve against. */
  key: string;
  owner: Persona;
}

/** A workspace-scoped blob URL the 5.2.3 extractor accepts (public Vercel-Blob
 *  host suffix + `/attachments/<workspaceId>/` prefix). The browser never
 *  uploads — a real editor row carrying this URL is seeded UNLINKED, and the
 *  comment body referencing it is what link-on-write attaches. */
function embedBlobUrl(workspaceId: string): string {
  return `https://teststore.public.blob.vercel-storage.com/attachments/${workspaceId}/embed-collab.png`;
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Serve the seeded embed's blob URL with tiny PNG bytes so the panel
 *  thumbnail read doesn't dangle (nothing leaves localhost). */
async function serveMockBlobHost(page: Page): Promise<void> {
  await page.route('https://teststore.public.blob.vercel-storage.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES });
  });
}

async function makeUser(email: string, name: string): Promise<Persona> {
  const u = await usersService.createUser({ email, password: PWD, name });
  return { id: u.id, email, name };
}

async function pinActiveProject(userId: string, tenant: Tenant): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: tenant.workspaceId } },
    data: { activeProjectId: tenant.projectId },
  });
}

function ownerCtx(tenant: Tenant) {
  return { userId: tenant.owner.id, workspaceId: tenant.workspaceId };
}

/** Owner + workspace + one open project; the owner is pinned active. */
async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await makeUser(ownerEmail, 'Petra PM');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Collab Journey Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: PROJECT_NAME,
    identifier: PROJECT_KEY,
  });
  const tenant: Tenant = {
    workspaceId: workspace.id,
    projectId: project.id,
    key: project.identifier,
    owner,
  };
  await pinActiveProject(owner.id, tenant);
  return tenant;
}

// ── UI helpers (the 5.3.8 / 5.4.11 hooks) ───────────────────────────────────

/** The FieldCard chevron that opens a rail card's picker. */
function editToggle(page: Page, label: string) {
  return page.getByRole('button', { name: `Edit ${label}`, exact: true });
}

/** A custom FieldCard — the toggle's Card ancestor (scopes value asserts). */
function fieldCard(page: Page, label: string) {
  return editToggle(page, label).locator('..').locator('..');
}

/** The watch control — matched on its live aria-label (count included). */
function watchButton(page: Page) {
  return page.getByRole('button', { name: /(Watch|Stop watching) — \d+ watching/ });
}

/** The activity tabs — the section's Segmented filter. */
async function switchTab(page: Page, tab: 'All' | 'Comments' | 'History') {
  await page
    .getByRole('group', { name: 'Activity filter' })
    .getByRole('button', { name: tab, exact: true })
    .click();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke the combined collaboration journey: build-up across every Epic-5 feature, then the unwind', async ({
  page,
}) => {
  // ── Server-side scaffold: the tenant, two watching members, the issue, a
  // select custom field, a component, and the waiting editor upload ──────────
  const tenant = await seedTenant('cj-pm@example.com');
  const bo = await makeUser('cj-bo@example.com', 'Bo Philips'); // watches + @mentioned
  const odie = await makeUser('cj-odie@example.com', 'Odie Walker'); // watches only
  for (const p of [bo, odie]) {
    await workspacesService.addMember({ userId: p.id, workspaceId: tenant.workspaceId });
    await pinActiveProject(p.id, tenant);
  }

  const issue = await workItemsService.createWorkItem(
    { projectId: tenant.projectId, kind: 'task', title: ISSUE_TITLE },
    ownerCtx(tenant), // the PM creates → auto-watches
  );
  // Bo + Odie watch (server-side — the watch UI is 5.4.11's; this spec needs
  // the watcher ROSTER as a precondition for the dedupe seam).
  await watchersService.watch(issue.id, { userId: bo.id, workspaceId: tenant.workspaceId });
  await watchersService.watch(issue.id, { userId: odie.id, workspaceId: tenant.workspaceId });

  await customFieldsService.createField({
    key: tenant.key,
    actorUserId: tenant.owner.id,
    ctx: ownerCtx(tenant),
    label: 'Severity',
    fieldType: 'select',
    options: ['Low', 'Medium', 'High'],
  });
  await componentsService.createComponent({ key: tenant.key, name: 'API' }, ownerCtx(tenant));

  // The waiting editor upload — UNLINKED (workItemId null), referenced by no
  // body yet. The comment below is what links it (5.2.3).
  await db.attachment.create({
    data: {
      workspaceId: tenant.workspaceId,
      uploaderUserId: tenant.owner.id,
      workItemId: null,
      source: 'editor',
      blobUrl: embedBlobUrl(tenant.workspaceId),
      mimeType: 'image/png',
      sizeBytes: 128,
      originalFilename: 'embed-collab.png',
    },
  });

  await serveMockBlobHost(page);
  await signIn(page, tenant.owner.email, PWD);
  await page.goto(`/issues/${issue.identifier}`);
  await expect(page.getByRole('heading', { name: ISSUE_TITLE, level: 1 })).toBeVisible();

  // ── Build-up 1: auto-watch on create surfaces on first paint (PM + Bo +
  // Odie = 3 watching, the eye PRESSED) ──────────────────────────────────────
  const watch = watchButton(page);
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await expect(watch).toHaveAccessibleName('Stop watching — 3 watching');

  // ── Build-up 2: set the rail — Severity (select), a label, a component ─────
  // Severity is empty → behind the disclosure.
  await page.getByRole('button', { name: 'Show more fields (1)' }).click();
  await editToggle(page, 'Severity').click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await expect(fieldCard(page, 'Severity')).toContainText('High');

  await editToggle(page, 'Labels').click();
  await page.getByRole('combobox', { name: 'Labels' }).fill('perf-q3');
  await page.getByRole('option', { name: 'Create ‘perf-q3’' }).click();
  await expect(page.getByRole('button', { name: 'Remove perf-q3' })).toBeVisible();

  await editToggle(page, 'Components').click();
  await page.getByRole('combobox', { name: 'Components' }).click();
  await page.getByRole('option', { name: 'API', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove API' })).toBeVisible();

  // ── Build-up 3: the comment that EMBEDS the upload AND @mentions Bo ─────────
  await page.getByRole('button', { name: 'Add a comment…' }).click();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Please review the shot @Bo');
  const picker = page.getByRole('listbox', { name: 'Mention a member' });
  await expect(picker.getByRole('option', { name: /Bo Philips/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  // Reference the upload's URL in the body — the construct-agnostic 5.2.3
  // extractor links the matching editor row (embed / link / bare paste all
  // count). insertText drops the literal URL without retriggering the picker.
  await page.keyboard.type(' ');
  await page.keyboard.insertText(embedBlobUrl(tenant.workspaceId));
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();

  // ── Seam A: the embed shows EDITOR-SOURCED in the panel (5.2.3 ran inside
  // the comment write tx). Reload so the server-rendered panel reflects the
  // freshly-linked row. ──────────────────────────────────────────────────────
  await page.reload();
  const attachmentList = page.getByRole('list', { name: 'Attachments' });
  const embedCard = attachmentList.getByRole('listitem').filter({ hasText: 'embed-collab.png' });
  await expect(embedCard).toBeVisible();
  await expect(embedCard.getByText('Embedded')).toBeVisible();

  // ── Seam B: the notification split — exactly one email per person ──────────
  // Bo was @mentioned AND is watching → ONE email, the mention (the watcher
  // job deduped her out).
  const boMention = await waitForEmail(bo.email, { timeoutMs: 30_000 });
  expect(boMention.subject).toBe(
    `${tenant.owner.name} mentioned you on ${issue.identifier}: ${ISSUE_TITLE}`,
  );
  expect(boMention.text).toContain(`/issues/${issue.identifier}`);
  // …and NEVER the watcher "commented on" email — the dedupe's whole point.
  expect((await emailsTo(bo.email)).filter((e) => e.subject.includes('commented on'))).toEqual([]);

  // Odie is watching, NOT mentioned → the watcher email.
  const odieWatch = await waitForEmail(odie.email, { timeoutMs: 30_000 });
  expect(odieWatch.subject).toBe(
    `${tenant.owner.name} commented on ${issue.identifier}: ${ISSUE_TITLE}`,
  );

  // The author (PM) is mailed by NEITHER job for their own comment.
  const pmMail = await emailsTo(tenant.owner.email);
  expect(pmMail.filter((e) => e.subject.includes('mentioned you'))).toEqual([]);
  expect(pmMail.filter((e) => e.subject.includes('commented on'))).toEqual([]);

  // ── Seam C: the All feed interleaves the field/label/component history with
  // the live comment in one ordered stream ──────────────────────────────────
  await switchTab(page, 'All');
  const allFeed = page.getByRole('list', { name: 'All activity' });
  await expect(allFeed).toBeVisible();
  // The live comment in its NATIVE grammar (body + Reply action)…
  const commentRow = allFeed.getByRole('listitem').filter({ hasText: 'Please review the shot' });
  await expect(
    commentRow.getByRole('button', { name: 'Reply', exact: true }).first(),
  ).toBeVisible();
  // …interleaved with the quiet history rows the rail edits wrote.
  await expect(allFeed.getByText('perf-q3', { exact: true })).toBeVisible();

  // ════════════════════════ THE UNWIND ════════════════════════
  // ── Unwind 1: archive the in-use select option — the rail value + its
  // History keep rendering with the archived mark (5.3 × 5.5.1) ──────────────
  await page.goto('/settings/project/fields');
  await expect(page.getByRole('heading', { name: 'Fields', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Severity', exact: true }).click();
  const editModal = page.getByRole('dialog');
  const highRow = editModal.locator('[data-testid^="option-row-"]').filter({ hasText: 'High' });
  await highRow.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(highRow.getByText('Archived', { exact: true })).toBeVisible();
  await editModal.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/issues/${issue.identifier}`);
  await expect(fieldCard(page, 'Severity')).toContainText('High (archived)');

  // ── Unwind 2: delete the comment — the embed UNLINKS from the panel, the
  // History records the deletion (no content), and no further mail fires ─────
  await switchTab(page, 'Comments');
  const liveComment = page
    .getByRole('list', { name: 'Comments' })
    .getByRole('listitem')
    .filter({ hasText: 'Please review the shot' });
  await liveComment.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Please review the shot')).toHaveCount(0);

  await page.reload();
  // The embed unlinked — the panel no longer carries the row (workItemId null).
  await expect(
    page.getByRole('list', { name: 'Attachments' }).getByText('embed-collab.png'),
  ).toHaveCount(0);
  // History records WHO deleted a comment + the no-content gloss, never the body.
  await switchTab(page, 'History');
  const historyFeed = page.getByRole('list', { name: 'History' });
  await expect(historyFeed.getByText(/deleted a comment/)).toBeVisible();
  await expect(historyFeed.getByText(/content not retained/)).toBeVisible();
  await expect(historyFeed.getByText('Please review the shot')).toHaveCount(0);

  // ── Unwind 3: delete the custom field — the rail card vanishes, and the
  // History stream still renders PAST the now-dangling referent (5.5.1 fallback
  // on the combined page; the precise fallback copy is 5.5.5's data-layer
  // assert — here we prove the stacked stream doesn't crash) ─────────────────
  await page.goto('/settings/project/fields');
  await expect(page.getByRole('heading', { name: 'Fields', exact: true })).toBeVisible();
  // Let the page (and its OWN initial fields GET) settle BEFORE arming the
  // freshen wait — otherwise `waitForResponse` resolves on the page-load GET,
  // and confirming inside the real confirm-open freshen round-trip clobbers
  // the optimistic delete (finding #81 — the 5.3.8 freshen-GET race).
  await expect(page.locator('[data-testid^="field-row-"]')).toHaveCount(1);
  const freshened = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().includes('/fields'),
  );
  await page.getByRole('button', { name: 'Delete Severity', exact: true }).click();
  await freshened;
  const deleteConfirm = page.getByRole('dialog');
  await expect(deleteConfirm.getByRole('heading', { name: 'Delete Severity?' })).toBeVisible();
  // The editor drops the row OPTIMISTICALLY before the DELETE resolves — wait
  // for the actual response, or the navigation below races the commit and the
  // issue renders pre-delete (the 5.4.10 component-delete lesson; finding #81's
  // sibling). The `field-row` count alone is the optimistic UI, not the server.
  const fieldDeleted = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && /\/api\/fields\/[^/]+$/.test(r.url()),
  );
  await deleteConfirm.getByRole('button', { name: 'Delete field' }).click();
  expect((await fieldDeleted).status()).toBe(200);
  await expect(page.locator('[data-testid^="field-row-"]')).toHaveCount(0);

  // The rail card is gone (the 5.3.8 plain-goto pattern — never the cached
  // `?activity=` route)…
  await page.goto(`/issues/${issue.identifier}`);
  await expect(editToggle(page, 'Severity')).toHaveCount(0);
  await expect(page.getByText('High (archived)')).toHaveCount(0);
  // …but the History stream still renders PAST the vanished custom-field
  // referent — the created anchor and the comment-deletion entry survive.
  await switchTab(page, 'History');
  const historyAfter = page.getByRole('list', { name: 'History' });
  await expect(historyAfter).toBeVisible();
  await expect(historyAfter.getByText(/created the issue/)).toBeVisible();
  await expect(historyAfter.getByText(/deleted a comment/)).toBeVisible();

  // ── Unwind 4: a transition mails BOTH watchers; the actor (PM) is excluded ─
  await page.goto(`/issues/${issue.identifier}`);
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'In Progress' }).click();

  // waitForEmail returns the LATEST match — poll until the transition email is it.
  for (const who of [bo, odie]) {
    await expect(async () => {
      const latest = await waitForEmail(who.email);
      expect(latest.subject).toBe(`${tenant.owner.name} moved ${issue.identifier} to In Progress`);
    }).toPass({ timeout: 30_000 });
  }
  expect((await emailsTo(tenant.owner.email)).filter((e) => e.subject.includes('moved'))).toEqual(
    [],
  );
});
