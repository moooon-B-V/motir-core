// Acceptance E2E — Story MOTIR-2572: the create-token modal grants the
// product's REAL permissions (Subtask MOTIR-2586).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), which discovers this
// file by its `acceptance*.spec.ts` name; the bulk shards `testIgnore` the same
// pattern, so it runs ONCE, in the lane that records.
//
// ── What makes this an ACCEPTANCE test rather than a UI test ─────────────────
// Everything else in this story can be true while the thing Yue asked for is
// still broken. The model can be total, both gates can agree, the presenter can
// render every label — and the token can still grant something other than what
// was ticked. Chapter 5 is the one that settles it: the SAME URL is called
// twice with the SAME minted secret, and it answers 200 to the read and 403 to
// the write, naming the permission that was withheld. That single pair is the
// claim the whole story is making, and it is the only assertion that fails if
// any layer quietly disagreed with another.
//
// GET  /api/v1/projects/{key}/work-items  → project:browse  → GRANTED  → 200
// POST /api/v1/projects/{key}/work-items  → work_item:edit  → WITHHELD → 403
//
// One path, two methods, two permissions. Nothing about the URL, the token or
// the project differs between the two calls — only what was ticked in the modal.
//
// DETERMINISM — no stubs and no clock control. A freshly signed-up user, real
// Postgres, real routes; every mutation waits on its own response before the
// assertion that reads it back (the E2E discipline in CLAUDE.md). The `beat()`
// holds are pacing for a human viewer, never synchronisation — remove them all
// and every assertion is unchanged.

import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';

test.describe.configure({ timeout: 240_000 });

// The shown-once Copy affordance writes to the clipboard — grant it so the
// success toast fires deterministically rather than the copy-failed fallback.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a token grants what was ticked — and a real write is refused by name', async ({
  page,
  request,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2572');

  await signUp(page, 'token-permissions-acceptance@example.com');
  // A token BINDS to a project (MOTIR-2606), so the account needs one. This is
  // setup, not a chapter: what is being accepted starts at the Tokens pane.
  await createFirstProject(page, 'Acceptance');
  const project = await db.project.findFirstOrThrow({ where: { name: 'Acceptance' } });

  // ── 1 — the door ──────────────────────────────────────────────────────────
  await chapter('Walk in the way a person does', async () => {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await beat();
    await page.getByRole('link', { name: 'Account settings' }).click();

    const rail = page.getByRole('navigation', { name: 'Account settings' });
    await rail.getByRole('link', { name: 'Tokens', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/account\/tokens$/);
    await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();
    await beat();
  });

  const dialog = page.getByRole('dialog');

  // ── 2 — the picker says what the PRODUCT says ─────────────────────────────
  await chapter('The permissions are the product’s own', async () => {
    await page.getByRole('button', { name: 'Create token' }).first().click();
    await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
    await beat();

    // The catalog's domains, with the SHIPPED `permissions.*` copy — the same
    // words the Roles & permissions screen renders. Not a table written for
    // this screen, which is the thing MOTIR-2579 exists to prevent.
    const permissions = dialog.getByRole('group', { name: 'Permissions' });
    for (const name of [
      'View project',
      'Edit work items',
      'Delete work items',
      'Add comments',
      'Manage sprints',
      'Run AI planning',
    ]) {
      await expect(permissions.getByRole('switch', { name, exact: true })).toBeVisible();
    }
    // …and the retired vocabulary is gone from the surface entirely.
    await expect(dialog.getByText('Read everything')).toHaveCount(0);
    await expect(dialog.getByText('Connect integrations')).toHaveCount(0);
    await beat();

    // The DEFAULT grant: everything except the irreversible one.
    await expect(
      dialog.getByRole('switch', { name: 'Edit work items', exact: true }),
    ).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Manage sprints', exact: true })).toBeChecked();
    await expect(
      dialog.getByRole('switch', { name: 'Delete work items', exact: true }),
    ).not.toBeChecked();
    await beat();
  });

  // ── 3 — the empty grant is refused, with a reason ─────────────────────────
  await chapter('A token that grants nothing is not a token', async () => {
    await dialog.getByLabel('Label').fill('read-only-agent');
    const submit = dialog.getByRole('button', { name: 'Create token', exact: true });

    // Turn EVERYTHING off. The CTA goes dead and says why, rather than minting
    // a credential that can do nothing.
    //
    // Driven off what is CHECKED rather than a written list of names
    // (MOTIR-2988): the default grant is DERIVED from `TOOL_PERMISSIONS`, so a
    // story that gives an existing catalog key its first tool adds a switch here.
    // A list would leave that one on and quietly stop testing the refusal.
    const switches = dialog.getByRole('group', { name: 'Permissions' }).getByRole('switch');
    const count = await switches.count();
    expect(count, 'the permission grid rendered no switches').toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const toggle = switches.nth(i);
      if (await toggle.isChecked()) await toggle.click();
    }
    await expect(dialog.getByRole('alert')).toContainText(
      'Grant at least one permission to create a token.',
    );
    await expect(submit).toBeDisabled();
    await beat();
  });

  // ── 4 — narrow it to READ, and mint it ────────────────────────────────────
  await chapter('Grant it read, and nothing else', async () => {
    await dialog.getByRole('switch', { name: 'View project', exact: true }).click();
    await expect(dialog.getByRole('switch', { name: 'View project', exact: true })).toBeChecked();
    await expect(
      dialog.getByRole('switch', { name: 'Edit work items', exact: true }),
    ).not.toBeChecked();
    await beat();

    // The authoritative signal — armed BEFORE the click so it cannot be missed.
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
    expect((await created).status()).toBe(201);

    await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
    await expect(dialog.getByTestId('api-token-secret')).toBeVisible();
    await beat();
  });

  // The secret, read off the shown-once panel — the same string a person would
  // copy. Captured before "Done", because it is never shown again.
  const secret = ((await dialog.getByTestId('api-token-secret').textContent()) ?? '').trim();
  expect(secret.startsWith('motir_pat_')).toBe(true);

  // ── 5 — THE CHAPTER THIS STORY IS ABOUT ───────────────────────────────────
  await chapter('The same URL: read allowed, write refused by name', async () => {
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Token copied', { exact: true })).toBeVisible();
    await beat();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    const url = `/api/v1/projects/${project.identifier}/work-items`;
    const auth = { authorization: `Bearer ${secret}` };

    // GRANTED — project:browse was ticked.
    const read = await request.get(url, { headers: auth });
    expect(read.status()).toBe(200);

    // WITHHELD — work_item:edit was not. Same URL, same token, same project.
    const write = await request.post(url, {
      headers: { ...auth, 'content-type': 'application/json' },
      data: { kind: 'task', title: 'Should never exist' },
    });
    expect(write.status()).toBe(403);
    // The v1 error envelope is `{ code, error }` (lib/api/v1/errors.ts) — the
    // prose lives under `error`, not `message`.
    const body = (await write.json()) as { code?: string; error?: string };
    expect(body.code).toBe('INSUFFICIENT_PERMISSION');
    // The refusal NAMES the missing permission — a 403 that only says "no"
    // leaves the caller guessing which switch to go back and turn on.
    expect(body.error).toContain('work_item:edit');

    // …and the refusal is real: nothing was written.
    expect(await db.workItem.count({ where: { title: 'Should never exist' } })).toBe(0);
    await beat();
  });

  // ── 6 — the list says the same thing the picker did ───────────────────────
  await chapter('The list agrees with what was granted', async () => {
    const row = page.getByRole('row', { name: /read-only-agent/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('Read only', { exact: true })).toBeVisible();
    await expect(row.getByText('Can delete')).toHaveCount(0);
    await beat();

    await row.getByRole('button', { name: 'Show scopes for read-only-agent' }).click();
    await expect(page.getByText('View project', { exact: true })).toBeVisible();
    await expect(page.getByText('Edit work items', { exact: true })).toHaveCount(0);
    await beat();
  });

  // ── 7 — and it can be taken away ──────────────────────────────────────────
  await chapter('Revoke it', async () => {
    const row = page.getByRole('row', { name: /read-only-agent/ });
    await row.getByRole('button', { name: 'Revoke token read-only-agent' }).click();
    const confirmDialog = page.getByRole('dialog');
    await expect(
      confirmDialog.getByRole('heading', { name: 'Revoke "read-only-agent"?' }),
    ).toBeVisible();
    await beat();

    const revoked = page.waitForResponse(
      (r) => /\/api\/me\/api-tokens\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
    );
    await confirmDialog.getByRole('button', { name: 'Revoke token', exact: true }).click();
    expect((await revoked).status()).toBe(200);

    await expect(
      page.getByRole('row', { name: /read-only-agent/ }).getByText('Revoked'),
    ).toBeVisible();
    await beat();

    // The credential is dead at the seam too, not merely greyed out in a table.
    const after = await request.get(`/api/v1/projects/${project.identifier}/work-items`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(after.status()).toBe(401);
    await beat();
  });
});
