import { expect, test } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

// E2E: the page at its own address — Story MOTIR-5752 · MOTIR-7280.
//
// A ROUTE SMOKE. The editor's states are proven one altitude down
// (`tests/components/page-view.test.tsx` with the real editor and the real host;
// `packages/pages/test/editor/*` for the autosave loop), and the routes'
// refusals in `tests/api/pages*`. What only a browser over a running server can
// show is that the pieces meet: a page created through `POST /api/pages` opens
// at `/pages/<id>` with its editor, what a member writes there survives a
// reload, and an address that names no page answers a real 404.
//
// Seeded through the real door, not a fixture: the signed-up member's session
// creates the page, so the spec also proves the page lands in the project the
// page route then resolves against.
//
// DETERMINISM (CLAUDE.md § E2E): the rename and the body save are each awaited
// on their own response — armed before the action — before the reload reads
// them back. Nothing waits on a timer.

const USER = 'e2e-pages-smoke@example.com';

test.describe('@smoke the page at its own address', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('a member opens a page, writes in it, and reads it back after a reload', async ({
    page,
  }) => {
    await signUp(page, USER);

    const created = await page.request.post('/api/pages');
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const res = await page.goto(`/pages/${id}`);
    expect(res?.status()).toBe(200);

    // The editor landmark, and a fresh page's empty, focused title.
    const body = page.getByRole('textbox', { name: 'Page body' });
    await expect(body).toBeVisible();
    const title = page.getByRole('textbox', { name: 'Page title' });
    await expect(title).toHaveValue('');
    await expect(title).toBeFocused();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();

    const renamed = page.waitForResponse(
      (r) => r.url().endsWith(`/api/pages/${id}`) && r.request().method() === 'PATCH',
    );
    await title.fill('Release runbook');
    await title.press('Enter'); // moves focus to the body
    await title.blur();
    expect((await renamed).status()).toBe(200);

    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/pages/${id}/updates`) && r.request().method() === 'POST',
    );
    await body.click();
    await page.keyboard.type('Tag the commit, then push the tag.');
    expect((await saved).status()).toBe(200);
    // Scoped to the toolbar: the save indicator is its trailing end, and the
    // shell carries live regions of its own.
    await expect(page.getByRole('toolbar', { name: 'Formatting' }).getByRole('status')).toHaveText(
      /Saved/,
    );

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Release runbook');
    await expect(page.getByRole('textbox', { name: 'Page body' })).toHaveText(
      'Tag the commit, then push the tag.',
    );
    await expect(page).toHaveTitle('Release runbook');
  });

  test('the Pages section: the rail entry, the empty index, New page, then the row (MOTIR-7300)', async ({
    page,
  }) => {
    await signUp(page, USER);

    const res = await page.goto('/pages');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('link', { name: 'Pages', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No pages yet' })).toBeVisible();

    // A member is offered New page twice on an empty index — the header's and the
    // empty state's (design-notes § State 3); either creates the page.
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/pages') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'New page' }).first().click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    await page.waitForURL(`**/pages/${id}`);
    await expect(page.getByRole('textbox', { name: 'Page body' })).toBeVisible();

    await page.goto('/pages');
    const list = page.getByRole('list', { name: 'Pages in this project' });
    const row = list.getByRole('link');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('href', `/pages/${id}`);
    await expect(row).toContainText('Untitled');
    await expect(row).toContainText('by you');
  });

  test('an address that names no page answers 404', async ({ page }) => {
    await signUp(page, USER);
    const res = await page.goto('/pages/00000000-0000-4000-8000-000000000000');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });
});
