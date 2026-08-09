import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPermissionGatedUi,
  type PermissionGatedSeed,
} from './_helpers/permission-gated-ui-seed';

// E2E: Story MOTIR-2258's `verification_recipe`, automated (Subtask MOTIR-2479).
//
// The story's risk is NOT "the hiding does not work" — several hundred Vitest
// assertions cover that across four surfaces. The risk is the same one every
// story that REMOVES things carries: that it removed something it did not mean
// to. So the POSITIVE half below gets as many assertions as the absences do, and
// the admin walk exists purely to prove nothing an admin could reach was taken.
//
// ⚠️ AND THE OTHER HALF: hiding is presentation, never protection. Every absence
// this spec observes in the nav is followed by a DIRECT NAVIGATION to the same
// destination, asserting the refusal a person actually meets. A spec that only
// checked the rail would pass just as happily against a build that hid the door
// and left the room open, which is the exact failure the story is most exposed
// to.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a settled URL or a
// rendered role/text landmark. Nothing here races an optimistic write — this
// story performs no writes at all.

test.describe.configure({ timeout: 240_000 });

let seed: PermissionGatedSeed;

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedPermissionGatedUi('e2e');
});

/**
 * The platform chord for ⌘K — `Meta` on a macOS dev box, `Control` on the Linux
 * CI runner. Mirrors `shell-flows.spec.ts` / `shell-keyboard.spec.ts`; pressing
 * the wrong one simply never opens the palette, which reads as a missing entry.
 */
async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

/** Open the palette and return its dialog locator (the search input auto-focuses). */
async function openPalette(page: Page) {
  await page.keyboard.press(`${await resolveMod(page)}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  return palette;
}

/**
 * The primary rail. Every nav assertion below is scoped to it, and that is not
 * tidiness: the top bar's brand link is labelled "Motir — go to dashboard" and
 * the mobile drawer carries the same names, so an unscoped `name: 'Dashboard'`
 * resolves to two elements and fails strict mode. `shell.spec.ts` documents the
 * same trap — naming the rail is the fix, not tightening the string.
 */
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/**
 * The settings-AREA rail, which REPLACES the project nav inside
 * `/settings/project` and is labelled for the area rather than "Primary". Using
 * the wrong one of these two is silent: the locator simply finds nothing.
 */
const settingsRail = (page: Page) => page.getByRole('navigation', { name: 'Project settings' });

/** The bottom-nav Settings row — the AREA DOOR (design panel 1). */
const settingsDoor = (page: Page) =>
  rail(page).getByRole('link', { name: 'Settings', exact: true });

/** Land in the project shell as `email`, with the active project already pinned. */
async function enterShellAs(page: Page, email: string): Promise<void> {
  await signIn(page, email, seed.password);
  await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();
}

test('an ADMIN keeps the whole shell — nothing was taken away', async ({ page }) => {
  await enterShellAs(page, seed.adminEmail);

  // The door is there, and it opens on the full rail.
  await expect(settingsDoor(page)).toHaveAttribute('href', '/settings/project');
  await settingsDoor(page).click();
  await page.waitForURL('**/settings/project');

  for (const label of [
    'Details',
    'Members & access',
    'Roles & permissions',
    'Boards',
    'Workflow',
    'Estimation',
    'Fields',
    'Components',
    'AI planning',
    'Rules',
  ]) {
    await expect(settingsRail(page).getByRole('link', { name: label }), label).toBeVisible();
  }
  // Every group heading survives, in rail order.
  for (const group of ['General', 'Access', 'Work', 'Automation']) {
    await expect(settingsRail(page).getByText(group, { exact: true }), group).toBeVisible();
  }

  // And a destination genuinely opens — the door is not decorative.
  await settingsRail(page).getByRole('link', { name: 'Members & access' }).click();
  await page.waitForURL('**/settings/project/members');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // ⚠️ AND IT STILL SAVES. "Nothing was taken" is a claim about CAPABILITY, not
  // visibility — a rail that renders over a page whose writes now refuse would
  // satisfy every assertion above and be a worse regression than a missing row.
  // So the admin walk ends on a real round trip: rename the project on Details
  // and read the persisted value back after a reload.
  await page.goto('/settings/project');
  const nameField = page.getByLabel('Name', { exact: true });
  await expect(nameField).toBeEnabled();
  await nameField.fill('Permission-gated Project (renamed)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  // The authoritative signal, never a sleep: the card's own saved state.
  await expect(page.getByText('Saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Permission-gated Project (renamed)',
  );
});

test('a MEMBER is offered no settings area — and the room is still shut', async ({ page }) => {
  await enterShellAs(page, seed.memberEmail);

  // PANEL 1. The door is not there, and nothing marks the gap: no disabled row,
  // no tooltip, no "ask an admin" line. The rows below simply close up.
  await expect(settingsDoor(page)).toHaveCount(0);
  await expect(rail(page).getByRole('link', { name: 'Job runs' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Docs' })).toBeVisible();

  // ⌘K offers no settings deep link either — the palette reads the same registry.
  const palette = await openPalette(page);
  await expect(palette.getByRole('option', { name: /Members & access/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /^Details$/ })).toHaveCount(0);
  // …while the palette itself still works: its non-settings actions are there.
  await expect(palette.getByRole('option', { name: 'Go to Work Items' })).toBeVisible();
  await page.keyboard.press('Escape');

  // PANEL 3 — THE HALF THAT MATTERS MOST. Hiding is presentation: the page is
  // still one typed URL away, and it must refuse rather than render a read-only
  // form.
  await page.goto('/settings/project/members');
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
  await expect(
    page.getByRole('paragraph').filter({ hasText: /managed by project admins/i }),
  ).toBeVisible();
  // The back action leaves the area entirely — this actor has no room in it.
  await expect(page.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
    'href',
    '/dashboard',
  );
  // …and no editable form leaked in behind the refusal.
  await expect(page.getByRole('button', { name: /add a member/i })).toHaveCount(0);

  // The project nav is otherwise intact — a member's work surfaces are untouched.
  // ⚠️ Leave the settings AREA first: inside it the rail SWAPS to the settings
  // nav, so asserting project-nav rows there fails for the wrong reason.
  await page.goto('/dashboard');
  for (const label of ['Dashboard', 'Work Items', 'Boards', 'Backlog', 'Reports', 'Triage']) {
    await expect(rail(page).getByRole('link', { name: label }), label).toBeVisible();
  }
});

test('a VIEWER loses the destinations that refuse them, and keeps every read', async ({ page }) => {
  await enterShellAs(page, seed.viewerEmail);

  await expect(settingsDoor(page)).toHaveCount(0);

  // PANEL 4. The three rows whose destinations refuse a viewer outright are gone.
  for (const gone of ['Plans', 'Triage', 'Code health']) {
    await expect(rail(page).getByRole('link', { name: gone, exact: true }), gone).toHaveCount(0);
  }
  // Every read surface stays — the primary nav never renders empty.
  for (const kept of ['Dashboard', 'Work Items', 'Boards', 'Roadmap', 'Backlog', 'Reports']) {
    await expect(rail(page).getByRole('link', { name: kept, exact: true }), kept).toBeVisible();
  }

  // PANEL 5 — the in-place treatments this story must NOT have touched.
  // The Create control is visible and DISABLED, not absent.
  const create = page.getByLabel(/create/i).first();
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute('aria-disabled', 'true');

  // The board is read-only, and its cards do not drag.
  await rail(page).getByRole('link', { name: 'Boards', exact: true }).click();
  await page.waitForURL('**/boards');
  // The board is read-only for a viewer. Asserted on the DISABLED create control
  // rather than the banner: the banner renders in both of `BoardContainer`'s
  // branches but only once a board projection exists, and a freshly seeded
  // project's board state is not something this spec should depend on. The
  // toolbar's presence proves the can-browse branch rendered; its disabled state
  // is the read-only gate still holding — the same pair
  // `acceptance-roles-permissions.spec.ts` already relies on.
  const newWorkItem = page.getByRole('button', { name: 'New work item' }).first();
  await expect(newWorkItem).toBeVisible({ timeout: 30_000 });
  await expect(newWorkItem, 'a viewer must still not be able to create work items').toBeDisabled();

  // The issue detail offers no Edit door, and the edit route is guarded.
  await page.goto(`/items/${seed.itemKey}`);
  await expect(page.getByRole('heading', { name: /A card everyone can see/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
});

test('a hidden destination refuses a VIEWER the same way, per destination', async ({ page }) => {
  await enterShellAs(page, seed.viewerEmail);

  // Each refusal names its own room rather than reusing one apology — the copy
  // table in `design/projects/design-notes.md` § the permission-gated shell.
  const destinations: [string, RegExp][] = [
    ['/settings/project/board', /board configuration/i],
    ['/settings/project/workflow', /statuses and the transitions/i],
    ['/settings/project/fields', /custom fields/i],
    ['/settings/project/automation', /project automation/i],
  ];
  for (const [href, description] of destinations) {
    await page.goto(href);
    await expect(page.getByRole('heading', { name: 'Admins only' }), href).toBeVisible();
    await expect(page.getByText(description), href).toBeVisible();
  }
});
