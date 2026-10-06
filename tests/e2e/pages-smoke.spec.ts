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

  test('the Pages section: the rail entry, the tree, New page, then the row (MOTIR-7300 · MOTIR-7373)', async ({
    page,
  }) => {
    await signUp(page, USER);

    const res = await page.goto('/pages');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('link', { name: 'Pages', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeVisible();
    // Every project is born with its Bugs folder, and `/pages` shows every
    // project folder (design-notes § The page tree) — so a new project's tree
    // is that folder, not the empty state.
    const tree = page.getByRole('tree', { name: 'Folders and pages in this project' });
    await expect(tree.getByRole('treeitem', { name: 'Bugs' })).toBeVisible();

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/pages') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'New page' }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    await page.waitForURL(`**/pages/${id}`);
    await expect(page.getByRole('textbox', { name: 'Page body' })).toBeVisible();

    await page.goto('/pages');
    const row = tree.getByRole('treeitem', { name: 'Untitled' });
    await expect(row).toHaveAttribute('aria-level', '1');
    await expect(row.getByRole('link')).toHaveAttribute('href', `/pages/${id}`);
  });

  test('the tree opens level by level: folder › page › sub-page (MOTIR-7373)', async ({ page }) => {
    await signUp(page, USER);

    // Seeded through the real doors: the root level names the project's folder,
    // and each create names its parent.
    const rootRead = await page.request.get('/api/pages/tree?parent=root');
    expect(rootRead.status(), await rootRead.text()).toBe(200);
    const root = (await rootRead.json()) as { rows: { kind: string; id: string; name?: string }[] };
    const folder = root.rows.find((r) => r.kind === 'folder' && r.name === 'Bugs');
    expect(folder, JSON.stringify(root)).toBeDefined();

    const create = async (title: string, parent: { kind: string; id: string }) => {
      const r = await page.request.post('/api/pages', { data: { title, parent } });
      expect(r.status(), await r.text()).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };
    const runbookId = await create('Release runbook', { kind: 'folder', id: folder!.id });
    const subId = await create('Rollback steps', { kind: 'page', id: runbookId });

    await page.goto('/pages');
    const tree = page.getByRole('tree', { name: 'Folders and pages in this project' });

    // Each level is read when its row is expanded; wait on THAT read's answer.
    const folderLevel = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/pages/tree' &&
        new URL(r.url()).searchParams.get('parent') === `folder:${folder!.id}`,
    );
    await tree.getByRole('treeitem', { name: 'Bugs' }).click();
    expect((await folderLevel).status()).toBe(200);
    const runbook = tree.getByRole('treeitem', { name: 'Release runbook' });
    await expect(runbook).toHaveAttribute('aria-level', '2');
    await expect(runbook).toHaveAttribute('aria-expanded', 'false');

    const pageLevel = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/pages/tree' &&
        new URL(r.url()).searchParams.get('parent') === `page:${runbookId}`,
    );
    await runbook.getByRole('button', { name: 'Expand Release runbook' }).click();
    expect((await pageLevel).status()).toBe(200);
    const sub = tree.getByRole('treeitem', { name: 'Rollback steps' });
    await expect(sub).toHaveAttribute('aria-level', '3');
    await expect(sub.getByRole('link')).toHaveAttribute('href', `/pages/${subId}`);
  });

  test('the toolbar offers Work item, which opens the work-item picker (MOTIR-7574)', async ({
    page,
  }) => {
    await signUp(page, USER);
    const created = await page.request.post('/api/pages');
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const res = await page.goto(`/pages/${id}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('textbox', { name: 'Page body' })).toBeVisible();

    // The page adds group's third control, after Insert image and Insert table.
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    const workItem = toolbar.getByRole('button', { name: 'Mention a work item' });
    await expect(workItem).toBeVisible();
    await expect(workItem).toHaveText('Work item');
    await expect(workItem).toHaveAttribute('aria-haspopup', 'listbox');

    // It writes an `@` at the caret and the picker opens there. A bare `@` is
    // under the search minimum, so the picker asks for more and fetches nothing
    // — its own rendered state is the signal, no request to wait on.
    await page.getByRole('textbox', { name: 'Page body' }).click();
    await workItem.click();
    const picker = page.getByRole('listbox', { name: 'Mention a work item' });
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Keep typing to search work items…');
    await expect(workItem).toHaveAttribute('aria-expanded', 'true');
  });

  test('an address that names no page answers 404', async ({ page }) => {
    await signUp(page, USER);
    const res = await page.goto('/pages/00000000-0000-4000-8000-000000000000');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });
});
