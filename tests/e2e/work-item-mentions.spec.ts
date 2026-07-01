// E2E: the Story-5.8 work-item @-mention → live internal-link chip lifecycle
// (Subtask 5.8.8 · MOTIR-1407) — the Story CLOSER, driving the real shell. It
// automates Story 5.8's verification recipe end to end over the SAME stack the
// feature ships on: the unified `@` picker (people + work items, 5.8.5) wired
// into the rich-text editors, the durable `[KEY](motir:<id>)` token (5.8.2),
// auto-relate-on-mention (5.8.3), the live chip + title-linkify render (5.8.6),
// and the shared quick-view peek.
//
// The journey, with an AUTHORITATIVE wait at every async seam (CLAUDE.md — never
// race the optimistic/streamed UI; arm waitForResponse BEFORE the action):
//   1. In a source item's edit-form Description editor, type `@` + a query that
//      matches the target. The sub-threshold query first shows the "keep typing"
//      hint (no network); reaching the 2-char minimum fires
//      GET /api/work-items/mention-search — AWAITED (200) before the picker is
//      touched. Pick the target's "Work items" row → a live chip is inserted.
//   2. Save (the edit-form Server Action) — AWAITED (POST 200) — then on a fresh
//      detail render assert the body renders the live CHIP (key · title) and the
//      Relationships panel shows the auto-created "Relates to" row (also asserted
//      at the data layer — the committed link, stamped source=mention).
//   3. Click the chip → the shared quick-view PEEK opens on the target — AWAITED
//      (the peek's GET /api/work-items/peek 200) — then close it.
//   4. LIVE, not stale: rename the target via the service, reload the source,
//      assert the chip shows the NEW title.
//   5. Title-linkify: a source whose plain-text TITLE carries a bare `KEY-N`
//      renders that key as a peek link on the detail H1.
//   6. Archived → the chip renders the muted/dashed archived treatment (still a
//      navigable link); deleted (the target row gone) → a NON-interactive
//      struck-through bare key, and the page does not crash.
//
// Setup uses ONLY auth (shell-session signUp) + the `_test` harness
// (work-items create/patch/archive) + the sanctioned test DB reach for the hard
// delete + link assertions, so this spec is self-contained (its own seeded
// project + items) and has no ordering dependency on sibling specs. Selectors
// target the stable role/text/class hooks the 5.8.x components expose (the
// "Mention a person or work item" listbox, the `.wi-chip` chip + its `is-archived`
// / `is-deleted` state classes, the `Quick view: <key>` dialog, the "Relates to"
// relationship group), never brittle markup.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

// Browser sign-up + a multi-item @-mention journey through the real stack
// (editor picker, Server Action save, peek fetch): comfortably more than 30s.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 * active. Returns the project id. Mirrors the 2.3.8 / 2.4.6 specs. */
async function seedActiveProject(email: string, identifier: string): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Mentions Flow',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

interface Created {
  id: string;
  identifier: string;
}

/** Create a work item through the `_test` route. Returns id + identifier. */
async function mk(
  page: Page,
  projectId: string,
  opts: { kind?: string; title: string; descriptionMd?: string },
): Promise<Created> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: opts.kind ?? 'task', ...opts },
  });
  expect(res.status(), `create "${opts.title}"`).toBe(201);
  const json = (await res.json()) as Created;
  return { id: json.id, identifier: json.identifier };
}

test('@smoke @-mention a work item → live chip + relates_to → peek, live rename, title link, archived/deleted', async ({
  page,
}) => {
  const email = 'e2e-work-item-mentions@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'WIM');

  // The cast. `targetA` is the @-mentioned target (a distinctive title so the
  // trgm search is unambiguous); the others back the title-link + archived /
  // deleted states. (Creation order only fixes the keys; we use the returned
  // identifiers, so the assertions never hard-code WIM-N.)
  const targetA = await mk(page, projectId, { title: 'Payment gateway timeout' });
  const targetArchive = await mk(page, projectId, { title: 'Archive me candidate' });
  const targetDelete = await mk(page, projectId, { title: 'Delete me candidate' });
  // The source we EDIT — no bare key in its title, so the relates_to link is
  // provably created by the description mention (step 2), not at birth.
  const source = await mk(page, projectId, { title: 'Source item under edit' });
  // A source whose TITLE carries a bare key (step 5 — title-linkify).
  const titleSource = await mk(page, projectId, {
    title: `Tracking ${targetA.identifier} rollout`,
  });
  // A source pre-seeded with motir: tokens to the archive / delete targets
  // (step 6). Authored via the service (the _test create), so the labels are the
  // exact keys the deleted state falls back to.
  const refSource = await mk(page, projectId, {
    title: 'References to mutate',
    descriptionMd: `Relates to [${targetArchive.identifier}](motir:${targetArchive.id}) and [${targetDelete.identifier}](motir:${targetDelete.id}).`,
  });

  // ── 1. @-mention the target in the edit-form Description editor ────────────
  await page.goto(`/items/${source.identifier}/edit`);
  const description = page.getByLabel('Description');
  await expect(description).toBeVisible();
  await description.click();
  await page.keyboard.type('See ');

  // Open the picker with a SUB-threshold query (1 char < the 2-char minimum):
  // the "Work items" section shows the keep-typing hint and NEVER hits the
  // network (the picker gates below QUICK_SEARCH_MIN_QUERY_LENGTH).
  await page.keyboard.type('@P');
  const picker = page.getByRole('listbox', { name: 'Mention a person or work item' });
  await expect(picker).toBeVisible();
  await expect(picker.getByText('Keep typing to search work items…')).toBeVisible();

  // Cross the threshold → the debounced mention-search fires. ARM the
  // authoritative wait BEFORE the keystrokes that complete the query.
  const mentionSearch = page.waitForResponse(
    (r) =>
      r.url().includes('/api/work-items/mention-search') &&
      new URL(r.url()).searchParams.get('q') === 'Payment' &&
      r.request().method() === 'GET',
  );
  await page.keyboard.type('ayment');
  expect((await mentionSearch).status()).toBe(200);

  // The "Work items" section now lists the target; pick it (a mousedown-driven
  // option, so the editor keeps its selection for the insert).
  const option = picker.getByRole('option', { name: /Payment gateway timeout/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(picker).toHaveCount(0);

  // The editor inserted a live chip (mono key), not a raw token.
  await expect(description.locator('.wi-chip')).toContainText(targetA.identifier);

  // ── 2. Save → the body chip + the auto "Relates to" row ───────────────────
  // The edit form submits via a Server Action (POST to the edit route). Arm the
  // write wait BEFORE clicking Save, then assert its 200 before reading state.
  const save = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/items/${source.identifier}/edit`),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await save).status()).toBe(200);
  // The success toast is the action's committed-state confirmation.
  await expect(page.getByText(`${source.identifier} saved`, { exact: true })).toBeVisible();

  // The relates_to link is committed at the data layer, stamped source=mention.
  const link = await db.workItemLink.findFirst({
    where: { fromId: source.id, toId: targetA.id, kind: 'relates_to' },
  });
  expect(link, 'the description mention auto-created a relates_to link').not.toBeNull();
  expect(link!.source).toBe('mention');

  // A fresh detail render (the authoritative server read) shows the live chip…
  await page.goto(`/items/${source.identifier}`);
  const bodyChip = page.locator(`a.wi-chip`, { hasText: targetA.identifier });
  await expect(bodyChip).toBeVisible();
  await expect(bodyChip).toContainText('Payment gateway timeout');
  await expect(bodyChip).toHaveAttribute('href', `/items/${targetA.identifier}`);
  // …rendered as a chip, never the raw `motir:` token text.
  await expect(page.getByText('motir:')).toHaveCount(0);

  // …and the Relationships panel shows the "Relates to" row for the target. The
  // row is the only <li> linking to the target's detail page (the body chip is
  // not a list item).
  const relatesRow = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(targetA.identifier) }) })
    .filter({ hasText: 'Payment gateway timeout' });
  await expect(relatesRow.first()).toBeVisible();

  // ── 3. Click the chip → the quick-view peek opens on the target ───────────
  const peek = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/work-items/peek?key=${targetA.identifier}`) &&
      r.request().method() === 'GET',
  );
  await bodyChip.click();
  expect((await peek).status()).toBe(200);
  const dialog = page.getByRole('dialog', {
    name: new RegExp(`Quick view: ${targetA.identifier}`),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Payment gateway timeout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // ── 4. LIVE, not stale: rename the target → the chip reflects it ──────────
  const renamed = await page.request.patch(`/api/_test/work-items?id=${targetA.id}`, {
    data: { title: 'Latency fully resolved' },
  });
  expect(renamed.status(), 'rename the target').toBe(200);
  await page.goto(`/items/${source.identifier}`);
  const renamedChip = page.locator('a.wi-chip', { hasText: targetA.identifier });
  await expect(renamedChip).toContainText('Latency fully resolved');
  await expect(renamedChip).not.toContainText('Payment gateway timeout');

  // ── 5. Title-linkify: a bare KEY-N in a title renders as a peek link ──────
  await page.goto(`/items/${titleSource.identifier}`);
  const titleLink = page
    .getByRole('heading', { level: 1 })
    .getByRole('link', { name: targetA.identifier, exact: true });
  await expect(titleLink).toBeVisible();
  await expect(titleLink).toHaveAttribute('href', `/items/${targetA.identifier}`);

  // ── 6. Archived → muted/dashed chip (still navigable) ─────────────────────
  const archived = await page.request.delete(`/api/_test/work-items?id=${targetArchive.id}`);
  expect(archived.status(), 'archive the target').toBe(204);
  await page.goto(`/items/${refSource.identifier}`);
  const archivedChip = page.locator('a.wi-chip.is-archived', {
    hasText: targetArchive.identifier,
  });
  await expect(archivedChip).toBeVisible();
  await expect(archivedChip).toContainText('Archive me candidate');
  await expect(archivedChip).toHaveAttribute('href', `/items/${targetArchive.identifier}`);

  // ── 6b. Deleted → struck-through bare key, non-interactive, no crash ──────
  // No product hard-delete path exists (archive-only); remove the row directly
  // via the sanctioned test DB reach. The leaf cascades its links/revisions.
  await db.workItem.delete({ where: { id: targetDelete.id } });
  await page.goto(`/items/${refSource.identifier}`);
  // The page still renders (the dangling reference degrades, never breaks it).
  await expect(page.getByRole('heading', { level: 1, name: 'References to mutate' })).toBeVisible();
  const deletedChip = page.locator('.wi-chip.is-deleted', { hasText: targetDelete.identifier });
  await expect(deletedChip).toBeVisible();
  // The deleted state is a non-interactive span — never a link.
  await expect(page.locator('a.wi-chip.is-deleted')).toHaveCount(0);
});
