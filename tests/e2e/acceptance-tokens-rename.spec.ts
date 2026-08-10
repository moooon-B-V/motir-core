// Acceptance E2E — Story MOTIR-2532: one name for the thing (Subtask MOTIR-2541).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), which discovers this
// file by its `acceptance*.spec.ts` name; the bulk shards `testIgnore` the same
// pattern, so it runs ONCE, in the lane that records. The recorded happy path
// declares Story MOTIR-2532 via `acceptanceStory()`, so the clip publishes to
// 2532 whichever PR triggered the run.
//
// ── What a reviewer is accepting here, and why it needs a camera ─────────────
// This Story changes no behaviour. Every unit test in the repo would stay green
// if the rename had never happened, which is exactly why the receipt matters:
// what is being accepted is a WORDING decision, and nobody can judge "Create
// token" from a JSON diff. In five seconds of footage you can see the heading
// sit over a subtitle that still says "personal access tokens" — the one
// deliberate asymmetry in the change (the heading NAMES the object, the
// subtitle DEFINES it) — and decide whether it reads right.
//
// It also walks the DOOR rather than the room. The thing MOTIR-2532 renamed is
// a row in the account rail plus the address it points at, so a recording that
// jumped straight to the URL would show the one surface the Story did not
// change. The old address gets its own chapter for the same reason: the
// permanent redirect is a promise to everyone holding a bookmark, a docs link,
// or a `@motir/cli` hint printed before this shipped.
//
// DETERMINISM — no stubs and no clock control. A freshly signed-up user, real
// Postgres, real routes; the one mutation waits on its own response before the
// assertion that reads it back (the E2E discipline in CLAUDE.md). The `beat()`
// holds are pacing for a human viewer, never synchronisation — remove them all
// and every assertion is unchanged.

import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

test.describe.configure({ timeout: 180_000 });

// The shown-once Copy affordance writes to the clipboard — grant it so the
// success toast fires deterministically rather than the copy-failed fallback.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('the pane a person opens is called Tokens — from the avatar menu to a token they made', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2532');

  await signUp(page, 'tokens-acceptance@example.com');

  // ── 1 — the door ──────────────────────────────────────────────────────────
  await chapter('Find it the way a person does', async () => {
    // The avatar button is a Popover trigger, not a menu — so a `button`
    // labelled "Account menu" holding a plain `link`
    // (`app/(authed)/_components/UserMenu.tsx`).
    await page.getByRole('button', { name: 'Account menu' }).click();
    await beat();
    await page.getByRole('link', { name: 'Account settings' }).click();

    // THE RENAMED THING, in the rail's Security group. Scoped to the
    // `<nav aria-label="Account settings">` landmark so it cannot match the
    // page content, which repeats the word.
    const rail = page.getByRole('navigation', { name: 'Account settings' });
    await expect(rail.getByRole('link', { name: 'Tokens', exact: true })).toBeVisible();
    await beat();

    await rail.getByRole('link', { name: 'Tokens', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/account\/tokens$/);
    await beat();
  });

  // ── 2 — the pane, and the asymmetry that is on purpose ────────────────────
  await chapter('The pane, and what it says about itself', async () => {
    // `exact` — "Tokens" is a substring of the empty state's own <h2>.
    await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

    // The subtitle still says "Personal access tokens …", and that is the
    // decision this clip exists to show: the heading NAMES the object, the
    // sentence under it DEFINES one. Collapsing both into "Tokens" would leave
    // a reader who has never seen one with nothing to go on.
    await expect(page.getByText(/Personal access tokens let your coding agents/)).toBeVisible();
    await beat();

    await expect(page.getByRole('heading', { name: 'No tokens yet' })).toBeVisible();
    await beat();
  });

  // ── 3 — the old address keeps its promise ─────────────────────────────────
  await chapter('An old link still lands here', async () => {
    const response = await page.goto('/settings/account/api-tokens');

    await expect(page).toHaveURL(/\/settings\/account\/tokens$/);
    await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

    // PERMANENT, not temporary: a 307 would tell every crawler and bookmark to
    // keep asking the old address forever.
    const chain = response?.request().redirectedFrom();
    expect(chain).not.toBeNull();
    expect((await chain!.response())?.status()).toBe(308);
    await beat();
  });

  // ── 4 — the flow still works, under its new name ──────────────────────────
  await chapter('Create one', async () => {
    await page.getByRole('button', { name: 'Create token' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
    await beat();

    await dialog.getByLabel('Label').fill('claude-code');

    // The authoritative signal — armed BEFORE the click so it cannot be missed.
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
    expect((await created).status()).toBe(201);

    await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
    await expect(dialog.getByTestId('api-token-secret')).toBeVisible();
    await beat();

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row', { name: /claude-code/ })).toBeVisible();
    await beat();
  });
});
