// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ToastProvider } from '@/components/ui/Toast';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';

// ARCHIVING FROM THE `/pages` TREE (Story MOTIR-5755 · MOTIR-7423) — design
// MOTIR-7416 surfaces 1, 3, 4 and 9: the row menu's Archive…, the confirm when
// sub-pages go too, the toast with Undo, and the tree's archive refusals (an
// already-archived page, a create or move under an archived parent).
//
// Rendered with the real catalogs, rows, menus, dialog and Toast; `fetch` and
// the router are the only stubs (`tests/api/pages-archive-routes.test.ts`
// proves the routes).

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  unstable_isUnrecognizedActionError: () => false,
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';
import { usePageMove } from '@/components/pages/tree/usePageMove';

const page = (id: string, title: string, hasChildren = false): PageTreeRowDto => ({
  kind: 'page',
  id,
  title,
  hasChildren,
});
const level = (rows: PageTreeRowDto[]): PageTreeLevelDto => ({ rows, nextCursor: null });

const ROOT = level([page('p1', 'Auth flow', true), page('p2', 'Onboarding')]);

type Reply = { status: number; body: unknown } | 'network';
/** `<METHOD> <path>` → its queued replies; a tree level is `GET tree:<parent>`. */
let replies: Record<string, Reply[]> = {};
const sent: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  const method = init?.method ?? 'GET';
  const key =
    url.pathname === '/api/pages/tree'
      ? `GET tree:${url.searchParams.get('parent')}`
      : `${method} ${url.pathname}`;
  sent.push(key);
  const next = replies[key]?.shift();
  if (next === undefined) {
    if (key.startsWith('GET tree:')) return json(level([]));
    throw new Error(`unanswered fetch: ${key}`);
  }
  if (next === 'network') throw new TypeError('Failed to fetch');
  return json(next.body, next.status);
});
function reply(key: string, ...r: Reply[]) {
  (replies[key] ??= []).push(...r);
}

function mount(props: Partial<PageTreeProps> = {}) {
  return renderWithIntl(
    <ToastProvider>
      <PageTree initialRoot={ROOT} projectKey="VIEW" canEdit {...props} />
    </ToastProvider>,
  );
}

const labels = () =>
  within(screen.getByRole('tree'))
    .getAllByRole('treeitem')
    .map((el) => el.getAttribute('aria-label'));

async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

async function chooseArchive(title: string) {
  await press(screen.getByRole('button', { name: `Page actions for ${title}` }));
  const menu = await screen.findByRole('menu', { name: `Page actions for ${title}` });
  await press(within(menu).getByRole('menuitem', { name: 'Archive…' }));
}

beforeEach(() => {
  replies = {};
  sent.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});

clearToastTimersAfterEach();

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  push.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Archive… on a page with no sub-pages', () => {
  it('archives at once — no set read, no dialog — and the row leaves the tree', async () => {
    reply('POST /api/pages/p2/archive', {
      status: 200,
      body: { archivedIds: ['p2'], rootId: 'p2', subPageCount: 0 },
    });
    reply('GET tree:root', { status: 200, body: level([page('p1', 'Auth flow', true)]) });
    mount();
    await chooseArchive('Onboarding');

    expect(sent).not.toContain('GET /api/pages/p2/archive');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent).toContain('POST /api/pages/p2/archive');
    await waitFor(() => expect(labels()).toEqual(['Auth flow']));
    expect(await screen.findByText('Archived “Onboarding”')).toBeTruthy();
  });

  it('Undo restores it and re-reads the level it left', async () => {
    reply('POST /api/pages/p2/archive', {
      status: 200,
      body: { archivedIds: ['p2'], rootId: 'p2', subPageCount: 0 },
    });
    reply(
      'GET tree:root',
      { status: 200, body: level([page('p1', 'Auth flow', true)]) },
      {
        status: 200,
        body: ROOT,
      },
    );
    reply('DELETE /api/pages/p2/archive', {
      status: 200,
      body: {
        restoredIds: ['p2'],
        landing: { kind: 'original', parentPageId: null, folderId: null, title: null },
      },
    });
    mount();
    await chooseArchive('Onboarding');
    await waitFor(() => expect(labels()).toEqual(['Auth flow']));

    await press(await screen.findByRole('button', { name: 'Undo' }));
    expect(sent).toContain('DELETE /api/pages/p2/archive');
    await waitFor(() => expect(labels()).toEqual(['Auth flow', 'Onboarding']));
    expect(await screen.findByText('Restored “Onboarding”')).toBeTruthy();
  });

  it('Undo restored elsewhere names where it went and why', async () => {
    reply('POST /api/pages/p2/archive', {
      status: 200,
      body: { archivedIds: ['p2'], rootId: 'p2', subPageCount: 0 },
    });
    reply('DELETE /api/pages/p2/archive', {
      status: 200,
      body: {
        restoredIds: ['p2'],
        landing: { kind: 'root', parentPageId: null, folderId: null, title: null },
      },
    });
    mount();
    await chooseArchive('Onboarding');
    await press(await screen.findByRole('button', { name: 'Undo' }));
    expect(
      await screen.findByText(
        'Restored at the project root, because none of the pages or folders it was in is still in the tree.',
      ),
    ).toBeTruthy();
  });
});

describe('Archive… on a page with sub-pages — the confirm', () => {
  const SET = { subPageCount: 2, subPageTitles: ['Token refresh', 'SSO'] };

  it('reads the set, names the count and the first sub-pages, and Cancel sends nothing', async () => {
    reply('GET /api/pages/p1/archive', { status: 200, body: SET });
    mount();
    await chooseArchive('Auth flow');

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Archive “Auth flow” and its 2 sub-pages?');
    expect(dialog.textContent).toContain('3 pages will be archived: “Auth flow” and');
    expect(dialog.textContent).toContain('Token refresh');
    expect(dialog.textContent).toContain('SSO');
    expect(within(dialog).getByRole('button', { name: 'Archive 3 pages' })).toBeTruthy();

    await press(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).not.toContain('POST /api/pages/p1/archive');
    expect(labels()).toEqual(['Auth flow', 'Onboarding']);
  });

  it('names five sub-pages, then how many more', async () => {
    reply('GET /api/pages/p1/archive', {
      status: 200,
      body: { subPageCount: 7, subPageTitles: ['A', 'B', 'C', 'D', ''] },
    });
    mount();
    await chooseArchive('Auth flow');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('8 pages will be archived');
    expect(dialog.textContent).toContain('Untitled');
    expect(dialog.textContent).toContain('and 2 more');
    expect(within(dialog).getByRole('button', { name: 'Archive 8 pages' })).toBeTruthy();
  });

  it('confirming archives the set and the toast counts the sub-pages', async () => {
    reply('GET /api/pages/p1/archive', { status: 200, body: SET });
    reply('POST /api/pages/p1/archive', {
      status: 200,
      body: { archivedIds: ['p1', 'p3', 'p4'], rootId: 'p1', subPageCount: 2 },
    });
    reply('GET tree:root', { status: 200, body: level([page('p2', 'Onboarding')]) });
    mount();
    await chooseArchive('Auth flow');
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Archive 3 pages' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(labels()).toEqual(['Onboarding']));
    expect(await screen.findByText('Archived “Auth flow” and 2 sub-pages')).toBeTruthy();
  });

  it('a set that turns out empty archives at once', async () => {
    reply('GET /api/pages/p1/archive', {
      status: 200,
      body: { subPageCount: 0, subPageTitles: [] },
    });
    reply('POST /api/pages/p1/archive', {
      status: 200,
      body: { archivedIds: ['p1'], rootId: 'p1', subPageCount: 0 },
    });
    mount();
    await chooseArchive('Auth flow');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Archived “Auth flow”')).toBeTruthy();
  });

  it('a set that cannot be read is the failure toast, and nothing is archived', async () => {
    reply('GET /api/pages/p1/archive', 'network');
    mount();
    await chooseArchive('Auth flow');
    expect(await screen.findByText('Couldn’t archive “Auth flow”. Try again.')).toBeTruthy();
    expect(sent).not.toContain('POST /api/pages/p1/archive');
  });
});

describe('the archive refusals', () => {
  it('an already-archived page says so and re-reads the level', async () => {
    reply('POST /api/pages/p2/archive', { status: 409, body: { code: 'PAGE_ARCHIVED' } });
    reply('GET tree:root', { status: 200, body: level([page('p1', 'Auth flow', true)]) });
    mount();
    await chooseArchive('Onboarding');
    expect(await screen.findByText('“Onboarding” is already archived')).toBeTruthy();
    expect(
      screen.getByText('Someone archived it a moment ago. The tree has been refreshed.'),
    ).toBeTruthy();
    await waitFor(() => expect(labels()).toEqual(['Auth flow']));
  });

  it('any other failure is the failure toast, and the row stays', async () => {
    reply('POST /api/pages/p2/archive', { status: 500, body: { code: 'X' } });
    mount();
    await chooseArchive('Onboarding');
    expect(await screen.findByText('Couldn’t archive “Onboarding”. Try again.')).toBeTruthy();
    expect(labels()).toEqual(['Auth flow', 'Onboarding']);
    expect(sent.filter((k) => k === 'GET tree:root')).toHaveLength(0);
  });

  it('New sub-page under a page archived meanwhile names it', async () => {
    reply('POST /api/pages', { status: 422, body: { code: 'PAGE_PARENT_ARCHIVED' } });
    mount();
    await press(screen.getByRole('button', { name: 'Page actions for Auth flow' }));
    const menu = await screen.findByRole('menu', { name: 'Page actions for Auth flow' });
    await press(within(menu).getByRole('menuitem', { name: 'New sub-page' }));
    expect(
      await screen.findByText(
        '“Auth flow” is archived, so nothing can be added under it. Nothing was changed.',
      ),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('a viewer’s tree has no row menu, so no Archive…', () => {
    mount({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Page actions for Auth flow' })).toBeNull();
  });
});

describe('a move under a page archived meanwhile', () => {
  it('is `parentArchived`, names the target, and re-reads the source level', async () => {
    reply('PATCH /api/pages/p2/placement', {
      status: 422,
      body: { code: 'PAGE_PARENT_ARCHIVED' },
    });
    const refresh = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {children}
      </NextIntlClientProvider>
    );
    const { result } = renderHook(() => usePageMove({ refresh }), { wrapper });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.move({
        pageId: 'p2',
        from: 'root',
        parent: { kind: 'page', id: 'p1' },
        parentTitle: 'Auth flow',
      });
    });
    expect(outcome).toEqual({
      ok: false,
      refusal: 'parentArchived',
      message: '“Auth flow” is archived, so nothing can be added under it. Nothing was changed.',
    });
    expect(refresh).toHaveBeenCalledWith(['root']);
  });
});
