import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

// E2E: dragging in the `/pages` tree — Story MOTIR-5753 · MOTIR-7376
// (`design/pages/pages--tree.mock.html` panel 11).
//
// The bands, the placement each drop asks for, the pre-check and the snap-back
// are proven one altitude down with real dnd-kit gestures on the real tree
// (`tests/pages/pageTreeDnd.test.tsx`); the viewer's missing handle there too.
// What only a browser over a running server shows is that a REAL pointer drag
// lands where it was aimed and that the server keeps it: a reorder that survives
// a reload, a re-parent into a folder, a drop the tree refuses before asking,
// and one the server refuses (depth) that leaves the tree unchanged.
//
// DETERMINISM (CLAUDE.md § E2E, the dnd rule): a drop is judged by the COMMITTED
// placement — the PATCH response's body, then an authoritative read of the
// level — never by where the row appears to have landed. A gesture that resolved
// to the wrong target or to nothing (`closestCorners`-style staleness, a missed
// activation) is simply made again: a drop that writes nothing changes nothing.
// Every response wait is armed BEFORE the gesture's release.

const USER = 'e2e-pages-tree-drag@example.com';

type Parent = { kind: 'root' } | { kind: 'folder' | 'page'; id: string };
type TreeRow = { kind: 'folder' | 'page'; id: string; name?: string; title?: string };

async function readLevel(page: Page, parent: string): Promise<TreeRow[]> {
  const r = await page.request.get(`/api/pages/tree?parent=${encodeURIComponent(parent)}`);
  expect(r.status(), await r.text()).toBe(200);
  return ((await r.json()) as { rows: TreeRow[] }).rows;
}

async function createPage(page: Page, title: string, parent?: Parent): Promise<string> {
  const r = await page.request.post('/api/pages', { data: parent ? { title, parent } : { title } });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

const isPlacement = (id: string) => (r: Response) =>
  new URL(r.url()).pathname === `/api/pages/${id}/placement` && r.request().method() === 'PATCH';

/**
 * A real pointer drag from `from` to a point `frac` of the way down `to`, past
 * dnd-kit's 8px activation, settling on the target before the release.
 */
async function drag(page: Page, from: Locator, to: Locator, frac: number) {
  const f = (await from.boundingBox())!;
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * frac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 });
}

/**
 * Drag until the placement PATCH answers and its body is what `accept` wants;
 * up to four gestures. Returns the committed response.
 */
async function dragUntilCommitted(
  page: Page,
  pageId: string,
  from: () => Locator,
  to: () => Locator,
  frac: number,
  accept: (status: number, body: Record<string, unknown>) => boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let last: { status: number; body: Record<string, unknown> } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await drag(page, from(), to(), frac);
    const answer = page.waitForResponse(isPlacement(pageId), { timeout: 5_000 }).catch(() => null);
    await page.mouse.up();
    const res = await answer;
    if (!res) continue; // the gesture wrote nothing — make it again
    last = { status: res.status(), body: (await res.json()) as Record<string, unknown> };
    if (accept(last.status, last.body)) return last;
  }
  throw new Error(`the drag never committed as intended; last answer ${JSON.stringify(last)}`);
}

test.describe('dragging in the /pages tree', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('reorder survives a reload; a drop onto a folder files the page inside it', async ({
    page,
  }) => {
    await signUp(page, USER);
    const bugs = (await readLevel(page, 'root')).find(
      (r) => r.kind === 'folder' && r.name === 'Bugs',
    );
    expect(bugs).toBeDefined();
    const alphaId = await createPage(page, 'Alpha');
    await createPage(page, 'Bravo');
    const charlieId = await createPage(page, 'Charlie');

    await page.goto('/pages');
    const tree = page.getByRole('tree', { name: 'Folders and pages in this project' });
    const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
    await expect(row('Charlie')).toBeVisible();

    // REORDER: Charlie into the top quarter of Alpha → before Alpha.
    const reordered = await dragUntilCommitted(
      page,
      charlieId,
      () => row('Charlie'),
      () => row('Alpha'),
      0.12,
      (status, body) =>
        status === 200 && (body.parent as Parent).kind === 'root' && body.moved === true,
    );
    expect(reordered.body.id).toBe(charlieId);
    const titles = async () =>
      (await readLevel(page, 'root')).filter((r) => r.kind === 'page').map((r) => r.title);
    expect(await titles()).toEqual(['Charlie', 'Alpha', 'Bravo']);

    await page.reload();
    const pageRows = tree.getByRole('treeitem').filter({ hasNot: page.locator('[aria-expanded]') });
    await expect(row('Charlie')).toBeVisible();
    await expect(pageRows).toHaveText(['Charlie', 'Alpha', 'Bravo']);

    // RE-PARENT: Alpha onto the Bugs folder (a folder row is INSIDE whatever the band).
    const filed = await dragUntilCommitted(
      page,
      alphaId,
      () => row('Alpha'),
      () => row('Bugs'),
      0.5,
      (status, body) =>
        status === 200 &&
        (body.parent as Parent).kind === 'folder' &&
        (body.parent as { id: string }).id === bugs!.id,
    );
    expect(filed.body.moved).toBe(true);
    expect((await readLevel(page, `folder:${bugs!.id}`)).map((r) => r.title)).toContain('Alpha');
    expect(await titles()).toEqual(['Charlie', 'Bravo']);
    // The folder opened, so the moved page is in view under it.
    await expect(row('Alpha')).toHaveAttribute('aria-level', '2');
  });

  test('a drop onto its own sub-page is refused before it is sent', async ({ page }) => {
    await signUp(page, USER);
    const parentId = await createPage(page, 'Auth flow');
    await createPage(page, 'Token refresh', { kind: 'page', id: parentId });

    await page.goto('/pages');
    const tree = page.getByRole('tree', { name: 'Folders and pages in this project' });
    const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
    const level = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/pages/tree' &&
        new URL(r.url()).searchParams.get('parent') === `page:${parentId}`,
    );
    await row('Auth flow').getByRole('button', { name: 'Expand Auth flow' }).click();
    expect((await level).status()).toBe(200);
    await expect(row('Token refresh')).toBeVisible();

    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes('/placement')) patches.push(r.url());
    });
    await drag(page, row('Auth flow'), row('Token refresh'), 0.5);
    await expect(page.getByRole('tooltip')).toHaveText('Can’t drop a page into its own sub-page.');
    await page.mouse.up();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // Nothing was asked of the server, and the stored tree is as it was.
    expect(patches).toEqual([]);
    expect((await readLevel(page, `page:${parentId}`)).map((r) => r.title)).toEqual([
      'Token refresh',
    ]);
  });

  test('a drop the server refuses (depth) snaps back with its sentence', async ({ page }) => {
    await signUp(page, USER);
    // A chain ten pages deep — the limit — and a loose page to drop under its foot.
    const chain: string[] = [];
    for (let i = 1; i <= 10; i++) {
      chain.push(
        await createPage(
          page,
          `Level ${i}`,
          i === 1 ? undefined : { kind: 'page', id: chain[i - 2]! },
        ),
      );
    }
    const looseId = await createPage(page, 'Loose page');

    await page.goto('/pages');
    const tree = page.getByRole('tree', { name: 'Folders and pages in this project' });
    const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
    for (let i = 1; i <= 9; i++) {
      const level = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/pages/tree' &&
          new URL(r.url()).searchParams.get('parent') === `page:${chain[i - 1]}`,
      );
      await row(`Level ${i}`)
        .getByRole('button', { name: `Expand Level ${i}` })
        .click();
      expect((await level).status()).toBe(200);
    }
    await expect(row('Level 10')).toHaveAttribute('aria-level', '10');

    const refused = await dragUntilCommitted(
      page,
      looseId,
      () => row('Loose page'),
      () => row('Level 10'),
      0.5,
      (status, body) => status === 422 && body.code === 'PAGE_DEPTH_EXCEEDED',
    );
    expect(refused.status).toBe(422);
    // The refusal is a toast; scope to the toast region (app chrome named
    // "Notifications (F8)") so a streamed copy of the page cannot match.
    await expect(
      page
        .getByRole('region', { name: /Notifications/ })
        .getByText(
          'Pages nest at most 10 levels deep, and this move would go past that. It stayed where it was.',
        ),
    ).toBeVisible();
    // The tree is unchanged: the loose page is still at the root and still focused.
    await expect(row('Loose page')).toHaveAttribute('aria-level', '1');
    await expect(row('Loose page')).toBeFocused();
    expect((await readLevel(page, 'root')).map((r) => r.title)).toContain('Loose page');
  });
});
