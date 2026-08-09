import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedCustomRoles, type CustomRolesSeed } from './_helpers/custom-roles-seed';

// Story MOTIR-2257 — custom project roles, end to end (Subtask MOTIR-2487).
//
// The story's `verification_recipe`, automated, and the clip a reviewer watches
// to accept it. The sibling `acceptance-roles-permissions.spec.ts` covers the
// READ screens and is untouched.
//
// ⚠️ THE TWO CHAPTERS THAT CARRY THE STORY ARE 4 AND 6, and both assert in a
// direction that is easy to leave out:
//
//   * CHAPTER 4 asserts BOTH halves. Confirming a removed permission is refused
//     is only half the evidence — a bug that stripped the teammate of everything
//     would pass that check while being a far worse outcome than the one it was
//     written to catch. So the teammate also SUCCEEDS at something the role
//     kept. A custom role is a shape, not a subtraction.
//   * CHAPTER 6 asserts the teammate ends up on the DESTINATION role, read off
//     the members surface. The criterion is that nobody is left without a role;
//     a test that only checked the deletion would pass on the exact bug that
//     leaves somebody with nothing.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a role/text landmark,
// a settled navigation, or a `waitForResponse` armed BEFORE its action. There is
// no fixed-duration sleep in this file — `chapter()` / `beat()` are the video
// harness's PACING, taken only after the assertions they follow have already
// proven the state, and removing them would change no assertion.

test.describe.configure({ timeout: 240_000 });

/** The role the admin composes in chapter 1 — a `Member` minus two permissions. */
const ROLE_NAME = 'Contributor';

/**
 * The two permissions unticked, and the one deliberately kept.
 *
 * ⚠️ CHOSEN FOR THEIR VISIBLE GATES, not at random. `work_item:edit` drives the
 * shell's `canEdit`, which is what disables `New work item` — a refusal a
 * reviewer can SEE. `comment:add` drives the item detail's composer, so the
 * kept half is a real action landing on screen rather than a page merely
 * loading. Both are in the `member` base set, so unticking is what removes them.
 */
const REMOVED = ['Edit work items', 'Manage sprints'] as const;

const railEntry = (page: Page) => page.getByRole('link', { name: 'Roles & permissions' });
const membersRailEntry = (page: Page) => page.getByRole('link', { name: 'Members & access' });
const roleRow = (page: Page, key: string) => page.locator(`[data-role-row="${key}"]`);
/** The one custom row — matched by NOT being one of the three built-in keys. */
const customRow = (page: Page) =>
  page
    .locator('[data-role-row]:not([data-role-row="admin"]):not([data-role-row="member"])')
    .and(page.locator('[data-role-row]:not([data-role-row="viewer"])'));

/**
 * Sign in AND WAIT FOR THE SHELL TO LAND.
 *
 * ⚠️ `signIn` RESOLVES ON THE URL MATCH, WHICH IS NOT THE SAME AS SETTLED. It
 * waits for `**\/dashboard`, and the dashboard's own navigation can still be in
 * flight when it returns — so the very next `page.goto` races it and Playwright
 * fails the goto outright: *"Navigation to /settings/project is interrupted by
 * another navigation to /dashboard"*. Observed on the third consecutive run of
 * this spec; the first two happened to win the race.
 *
 * The account-menu trigger is the app shell's own landmark: it renders only for
 * a signed-in session, and only once the dashboard has actually rendered. Waiting
 * on it is an authoritative signal, not a delay — remove it and the assertions
 * are unchanged, but the goto that follows has nothing to lose to.
 */
async function signInAndSettle(page: Page, email: string, password: string): Promise<void> {
  await signIn(page, email, password);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 30_000,
  });
}

/** Open project settings → Roles & permissions BY CLICKING — a page nobody can
 *  reach passes every test that navigates to it directly. */
async function openRolesList(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(railEntry(page)).toBeVisible();
  await railEntry(page).click();
  await page.waitForURL('**/settings/project/roles');
  await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
}

async function openMembers(page: Page): Promise<void> {
  await page.goto('/settings/project');
  await expect(membersRailEntry(page)).toBeVisible();
  await membersRailEntry(page).click();
  await page.waitForURL('**/settings/project/members');
  // ⚠️ THE RAIL SAYS "Members & access"; THE PAGE'S OWN H1 SAYS "Access & members".
  // Asserting the rail's wording here would fail on a page that had loaded
  // perfectly — the landmark has to be the heading the page actually draws.
  await expect(page.getByRole('heading', { name: 'Access & members', level: 1 })).toBeVisible();
}

/** `"10 of 28 permissions"` → `[10, 28]`, failing loudly when the row has none. */
function parseCount(text: string): [number, number] {
  const match = text.match(/(\d+) of (\d+) permissions/);
  expect(match, `no "N of M permissions" in ${JSON.stringify(text)}`).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

let seed: CustomRolesSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedCustomRoles(`custom-roles-${Date.now()}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('an admin authors a role, assigns it, watches it bite, and deletes it with a reassign', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2257');

  await signInAndSettle(page, seed.adminEmail, seed.password);

  // ── 1 · AUTHOR ────────────────────────────────────────────────────────────
  let total = 0;
  await chapter('The project has no roles of its own — and a door to make one', async () => {
    await openRolesList(page);

    // THE ZERO-CUSTOM-ROLES STATE. Three built-in rows and nothing else, which
    // is the shape the list has to hold before it can be said to GROW.
    await expect(page.locator('[data-role-row]')).toHaveCount(3);
    for (const key of ['admin', 'member', 'viewer']) {
      await expect(roleRow(page, key)).toContainText('Built-in');
    }
    [, total] = parseCount(
      await roleRow(page, 'member').locator('text=/\\d+ of \\d+ permissions/').innerText(),
    );
    await beat();

    await page.getByTestId('create-role').click();
    await page.waitForURL('**/settings/project/roles/new');
    await expect(page.getByRole('heading', { name: 'Create a role' })).toBeVisible();
    await beat();
  });

  await chapter(`Start from Member, name it ${ROLE_NAME}, untick two permissions`, async () => {
    await page.getByLabel('Name').fill(ROLE_NAME);
    await beat();

    // `Start from` SEEDS the grid and is stored nowhere — an authoring
    // convenience so the author does not face 28 blank boxes.
    await page.getByLabel('Start from').selectOption('member');
    const count = page.getByTestId('role-editor-count');
    const [seeded] = parseCount(await count.innerText());
    expect(seeded, 'Start from Member pre-ticked nothing').toBeGreaterThan(0);
    await beat();

    // The count is the running total the pinned bar draws; it has to FALL by
    // exactly one per untick, or it is decoration rather than feedback.
    for (const [i, label] of REMOVED.entries()) {
      const box = page.getByRole('checkbox', { name: label });
      await expect(box).toHaveAttribute('aria-checked', 'true');
      await box.click();
      await expect(box).toHaveAttribute('aria-checked', 'false');
      await expect(count).toContainText(`${seeded - i - 1} of ${total} permissions`);
      await beat();
    }

    // ⚠️ ARMED BEFORE THE CLICK, so the response cannot be missed — and the
    // navigation that follows is the SERVER's confirmation, not an optimism.
    const created = page.waitForResponse(
      (res) => /\/roles$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create role' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByText('Role created')).toBeVisible();
    await beat();
  });

  // ── 2 · READ IT BACK ──────────────────────────────────────────────────────
  //
  // ⚠️ THE CARD ASKS FOR A `Based on Member · −2` CHIP HERE. Nothing records
  // what a role was seeded from any more (Yue, 2026-08-09) — `Start from` is not
  // sent, not stored and not drawn — so what is asserted is what the screens DO
  // carry: the name, the `Custom` chip, `N of M`, and the holder count.
  await chapter(
    'The role reads back as its own name, its count and nobody holding it',
    async () => {
      // Saving lands on the new role's DETAIL screen.
      await expect(page.getByRole('heading', { name: ROLE_NAME, level: 1 })).toBeVisible();
      await expect(page.getByText('Custom', { exact: true })).toBeVisible();
      await expect(page.getByTestId('edit-role')).toBeVisible();

      // The marks are driven by the role's own set: the two unticked keys read
      // `Not held` while a kept one reads `Held`.
      for (const key of ['work_item:edit', 'sprint:manage']) {
        await expect(page.locator(`[data-permission="${key}"]`).getByRole('img')).toHaveAttribute(
          'aria-label',
          'Not held',
        );
      }
      await expect(
        page.locator('[data-permission="comment:add"]').getByRole('img'),
      ).toHaveAttribute('aria-label', 'Held');
      await beat();

      await page.getByRole('link', { name: 'All roles' }).click();
      await page.waitForURL('**/settings/project/roles');
      await expect(page.locator('[data-role-row]')).toHaveCount(4);

      const row = customRow(page);
      await expect(row).toContainText(ROLE_NAME);
      await expect(row).toContainText('Custom');
      await expect(row).toContainText('0 members');
      const [held, rowTotal] = parseCount(
        await row.locator('text=/\\d+ of \\d+ permissions/').innerText(),
      );
      expect(rowTotal).toBe(total);
      expect(held).toBeLessThan(total);
      await beat();
    },
  );

  // ── 3 · ASSIGN ────────────────────────────────────────────────────────────
  await chapter(`Members → put ${seed.teammateName} on ${ROLE_NAME}`, async () => {
    await openMembers(page);
    const picker = page.getByRole('combobox', { name: `Role for ${seed.teammateName}` });
    await expect(picker).toContainText('Member');
    await picker.click();

    // The picker GREW rather than changed shape: the built-ins are still first,
    // and the project's own role is listed under a heading that says so.
    await expect(page.getByText('Built-in', { exact: true })).toBeVisible();
    await expect(page.getByText('Custom roles', { exact: true })).toBeVisible();
    await beat();

    const assigned = page.waitForResponse(
      (res) =>
        /\/members\/[^/]+$/.test(new URL(res.url()).pathname) && res.request().method() === 'PATCH',
    );
    await page.getByRole('option', { name: ROLE_NAME }).click();
    expect((await assigned).status()).toBe(200);
    await expect(picker).toContainText(ROLE_NAME);
    await beat();

    // …and the role list now counts them. Read off the SERVER-rendered list, so
    // this is the persisted membership and not the optimistic row.
    await openRolesList(page);
    await expect(customRow(page)).toContainText('1 member');
    await beat();
  });

  // ── 4 · IT BITES, IN BOTH DIRECTIONS ──────────────────────────────────────
  await chapter(`${seed.teammateName} loses what the role dropped…`, async () => {
    await page.context().clearCookies();
    await signInAndSettle(page, seed.teammateEmail, seed.password);

    await page.goto('/boards');
    const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
    await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
    // THE REFUSAL, on a control a reviewer can see. `work_item:edit` is what
    // drives the shell's `canEdit`, and the admin unticked it.
    await expect(newWorkItem, 'the role withheld work_item:edit').toBeDisabled();
    await beat();
  });

  await chapter('…and keeps what it kept', async () => {
    await page.goto(`/items/${seed.workItemKey}`);
    await expect(page.getByRole('heading', { name: 'Wire the settings rail' })).toBeVisible({
      timeout: 30_000,
    });

    // THE OTHER HALF. A role that took everything away would satisfy the chapter
    // above and be a worse bug than the one it was written to catch — so the
    // teammate does something the role KEPT, and it lands.
    //
    // ⚠️ THE COMPOSER'S PRESENCE IS ITSELF HALF THE ASSERTION: it renders behind
    // `canComment`, so an actor without `comment:add` gets no control here at
    // all. Driven exactly as `activity.spec.ts` drives it — a ProseMirror
    // surface behind an "Add a comment…" trigger, typed rather than filled.
    await page.getByRole('button', { name: 'Add a comment…' }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('Picking this up.');
    await beat();

    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    // The AUTHORITATIVE signal: the comment rendered in the thread. The submit
    // is a Server Action, so there is no response to wait on — the persisted row
    // on screen is the confirmation.
    await expect(page.getByText('Picking this up.')).toBeVisible({ timeout: 30_000 });
    await beat();
  });

  // ── 5 · BUILT-INS ARE SAFE ────────────────────────────────────────────────
  await chapter('A built-in role cannot be edited or deleted by anyone', async () => {
    await page.context().clearCookies();
    await signInAndSettle(page, seed.adminEmail, seed.password);
    await openRolesList(page);

    await roleRow(page, 'admin').click();
    await page.waitForURL('**/settings/project/roles/admin');
    await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible();
    // Not disabled — ABSENT. A built-in reproduces the shipped behaviour by
    // definition, so editing one is not a thing that exists.
    await expect(page.getByTestId('edit-role')).toHaveCount(0);
    await expect(page.getByTestId('delete-role')).toHaveCount(0);
    await expect(page.getByText('Built-in · can’t be changed')).toBeVisible();
    await beat();
  });

  // ── 6 · DELETE WITH A REASSIGN ────────────────────────────────────────────
  await chapter(`Deleting ${ROLE_NAME} asks where its one member goes`, async () => {
    await page.getByRole('link', { name: 'All roles' }).click();
    await page.waitForURL('**/settings/project/roles');
    await customRow(page).click();
    await expect(page.getByRole('heading', { name: ROLE_NAME, level: 1 })).toBeVisible();
    await beat();

    await page.getByTestId('delete-role').click();
    // The dialog names the number of people affected BEFORE it asks anything —
    // that count is the reason the question is being asked at all.
    await expect(page.getByTestId('delete-affected-count')).toContainText('1 member');
    const confirm = page.getByTestId('delete-confirm');
    // A destination is REQUIRED while somebody holds it: the role cannot vanish
    // out from under them.
    await expect(confirm).toBeDisabled();
    await beat();

    await page.getByTestId('delete-destination').selectOption('viewer');
    await expect(confirm).toBeEnabled();

    const deleted = page.waitForResponse(
      (res) =>
        /\/roles\/[^/]+$/.test(new URL(res.url()).pathname) && res.request().method() === 'DELETE',
    );
    await confirm.click();
    expect((await deleted).status()).toBe(204);
    await page.waitForURL('**/settings/project/roles');
    await expect(page.locator('[data-role-row]')).toHaveCount(3);
    await expect(page.locator('body')).not.toContainText(ROLE_NAME);
    await beat();
  });

  await chapter(`${seed.teammateName} holds Viewer — never nothing`, async () => {
    await openMembers(page);
    // THE CRITERION. Not "the role is gone" — "the person the admin chose a
    // destination for is on it".
    await expect(
      page.getByRole('combobox', { name: `Role for ${seed.teammateName}` }),
    ).toContainText('Viewer');
    await beat();
  });
});

// ── The states the happy path skips ─────────────────────────────────────────
//
// Not chaptered: they are refusals, and a reviewer accepts the story on the flow
// above. They run in the same lane because they are the same surface, and a
// refusal that only exists in a component test is a refusal nobody has watched
// the real form give.

test('the editor refuses an empty name and a duplicate one', async ({ page }) => {
  await signInAndSettle(page, seed.adminEmail, seed.password);
  await openRolesList(page);
  await page.getByTestId('create-role').click();
  await page.waitForURL('**/settings/project/roles/new');

  // EMPTY: the submit is disabled rather than the form failing after a round
  // trip — the refusal is visible before it is earned.
  const submit = page.getByRole('button', { name: 'Create role' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Name').fill('   ');
  await expect(submit, 'whitespace is not a name').toBeDisabled();

  // Author one for real…
  await page.getByLabel('Name').fill(ROLE_NAME);
  const created = page.waitForResponse(
    (res) => /\/roles$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
  );
  await submit.click();
  expect((await created).status()).toBe(201);

  // …then try the SAME name again. The refusal lands ON the form with the
  // author's input intact, not as a toast that takes the work with it.
  await openRolesList(page);
  await page.getByTestId('create-role').click();
  await page.waitForURL('**/settings/project/roles/new');
  await page.getByLabel('Name').fill(ROLE_NAME);
  const refused = page.waitForResponse(
    (res) => /\/roles$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create role' }).click();
  expect((await refused).status()).toBe(409);
  await expect(page.getByTestId('role-editor-error')).toContainText(ROLE_NAME);
  await expect(page.getByLabel('Name')).toHaveValue(ROLE_NAME);
});
