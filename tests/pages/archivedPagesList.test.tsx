// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PageArchivedListDto, PageArchivedListItemDto } from '@/lib/dto/pages';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';

// THE ARCHIVED PAGES LIST (Story MOTIR-5755 · MOTIR-7424) — design MOTIR-7416,
// surfaces 6–9 on `/pages/archived`: the rows (title, sub-pages, where each came
// from, who and when), the actions by role, Restore and its toasts, Delete…,
// Load more, and the empty, loading and error states. Real catalogs, Toast,
// dialog and menu; `fetch` and the router are the stubs.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { ArchivedPagesList } from '@/app/(authed)/pages/archived/_components/ArchivedPagesList';
import { ArchivedPagesFrame } from '@/app/(authed)/pages/archived/_components/ArchivedPagesFrame';

const NOW = new Date('2026-10-03T12:00:00.000Z');

function item(id: string, over: Partial<PageArchivedListItemDto> = {}): PageArchivedListItemDto {
  return {
    id,
    title: `Page ${id}`,
    archivedAt: '2026-10-03T11:00:00.000Z',
    archivedBy: { id: 'u1', name: 'Grace Hopper' },
    subPageCount: 0,
    parent: { kind: 'root' },
    ancestorPageIds: [],
    cameFrom: { folders: [], pages: [] },
    archivedAncestorIds: [],
    ...over,
  };
}

const OLD = item('p1', {
  title: 'Old billing model',
  subPageCount: 2,
  parent: { kind: 'page', id: 'a2' },
  ancestorPageIds: ['a1', 'a2'],
  cameFrom: {
    folders: [{ id: 'f1', name: 'Specs' }],
    pages: [
      { id: 'a1', title: 'Finance' },
      { id: 'a2', title: 'Billing' },
    ],
  },
  archivedAncestorIds: ['a2'],
});
const LOOSE = item('p2', {
  title: '',
  archivedBy: null,
  archivedAt: '2026-09-01T09:30:00.000Z',
});

type Reply = Response | Error | Promise<Response>;
const queue: Record<string, Reply[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  const key =
    url.pathname === '/api/pages/archived'
      ? `GET archived:${url.searchParams.get('cursor') ?? ''}`
      : `${init?.method ?? 'GET'} ${url.pathname}`;
  const next = queue[key]?.shift();
  if (!next) throw new Error(`unanswered fetch: ${key}`);
  if (next instanceof Error) throw next;
  return next;
});
function reply(key: string, ...r: Reply[]) {
  (queue[key] ??= []).push(...r);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}
const restored = (landing: object, ids = ['p1', 's1', 's2']) =>
  json({
    restoredIds: ids,
    landing: { parentPageId: null, folderId: null, title: null, ...landing },
  });

function mount(
  initial: PageArchivedListDto | null = { items: [OLD, LOOSE], nextCursor: null },
  role: 'manager' | 'member' | 'viewer' = 'manager',
) {
  renderWithIntl(
    <ToastProvider>
      <ArchivedPagesList
        initial={initial}
        projectKey="VIEW"
        canRestore={role !== 'viewer'}
        canDelete={role === 'manager'}
      />
    </ToastProvider>,
    { now: NOW },
  );
}

const table = () => screen.getByRole('table', { name: 'Archived pages' });
const rowOf = (id: string) => screen.getByTestId(`archived-page-${id}`);
const rowIds = () =>
  within(table())
    .queryAllByRole('row')
    .map((r) => r.getAttribute('data-testid'))
    .filter((id): id is string => id?.startsWith('archived-page-') ?? false)
    .map((id) => id.slice('archived-page-'.length));
async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  for (const key of Object.keys(queue)) delete queue[key];
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

describe('the rows', () => {
  it('names each root, its sub-pages, where it came from, who and when', () => {
    mount();
    expect(rowIds()).toEqual(['p1', 'p2']);
    const headers = within(table())
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Page', 'Came from', 'Archived by', 'Archived', 'Actions']);

    const old = rowOf('p1');
    const link = within(old).getByRole('link', { name: 'Old billing model' });
    expect(link.getAttribute('href')).toBe('/pages/p1');
    expect(old.textContent).toContain('2 sub-pages');
    expect(old.textContent).toContain('SpecsFinanceBilling(archived)');
    expect(old.textContent).toContain('Grace Hopper');
    expect(old.textContent).toContain('1 hour ago');

    const loose = rowOf('p2');
    expect(within(loose).getByRole('link', { name: 'Untitled' })).toBeTruthy();
    expect(loose.textContent).toContain('No sub-pages');
    expect(loose.textContent).toContain('Project root');
    expect(loose.textContent).toContain('a former member');
    expect(loose.textContent).toContain('Sep 1, 2026');
  });

  it('actions by role: a Manager Restore and ⋯ → Delete…, a Member Restore, a Viewer no column', async () => {
    mount();
    expect(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    await press(
      within(rowOf('p1')).getByRole('button', { name: 'More actions for “Old billing model”' }),
    );
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Delete…']);
    cleanup();

    mount(undefined, 'member');
    expect(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(
      within(rowOf('p1')).queryByRole('button', { name: 'More actions for “Old billing model”' }),
    ).toBeNull();
    cleanup();

    mount(undefined, 'viewer');
    expect(within(rowOf('p1')).queryAllByRole('button')).toHaveLength(0);
    expect(within(table()).getAllByRole('columnheader')).toHaveLength(4);
  });

  it('the pending frame paints the header row', () => {
    renderWithIntl(<ArchivedPagesFrame showActions={false} />);
    const frame = screen.getByTestId('archived-pages-frame');
    expect(frame.textContent).toContain('Came from');
    expect(frame.textContent).not.toContain('Actions');
  });
});

describe('Restore', () => {
  it('to where it was: the row leaves and the toast counts, with Open', async () => {
    reply('DELETE /api/pages/p1/archive', restored({ kind: 'original' }));
    mount();
    await press(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(rowIds()).toEqual(['p2']);
    expect(screen.getByText('Restored “Old billing model” and 2 sub-pages')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith('/pages/p1');
  });

  it('elsewhere: the toast names where it landed and why', async () => {
    reply('DELETE /api/pages/p1/archive', restored({ kind: 'folder', title: 'Specs' }));
    mount();
    await press(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(rowIds()).toEqual(['p2']);
    expect(
      screen.getByText(
        'Restored into the folder “Specs”, because “Billing” and the pages above it are archived.',
      ),
    ).toBeTruthy();
  });

  it('while it runs the row is busy and reads Restoring…', async () => {
    const later = deferred();
    reply('DELETE /api/pages/p1/archive', later.promise);
    mount();
    await press(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(rowOf('p1').getAttribute('aria-busy')).toBe('true');
    expect(within(rowOf('p1')).getByRole('button', { name: /Restoring…/ })).toBeTruthy();
    expect(rowOf('p2').getAttribute('aria-busy')).toBeNull();
    await act(async () => {
      later.resolve(restored({ kind: 'original' }));
    });
    expect(rowIds()).toEqual(['p2']);
  });

  it('a stale row says so and leaves: restored already, or archived again with its parent', async () => {
    reply('DELETE /api/pages/p1/archive', json({ code: 'PAGE_NOT_ARCHIVED' }, 409));
    reply(
      'DELETE /api/pages/p2/archive',
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED', rootId: 'r1' }, 409),
    );
    mount();
    await press(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(screen.getByText('“Old billing model” isn’t archived any more')).toBeTruthy();
    expect(rowIds()).toEqual(['p2']);
    await press(within(rowOf('p2')).getByRole('button', { name: 'Restore “Untitled”' }));
    expect(screen.getByText('Couldn’t restore “Untitled”')).toBeTruthy();
    // The last row went with the cursor spent: the empty state.
    expect(screen.getByText('No archived pages')).toBeTruthy();
  });

  it('a failure toasts and keeps the row', async () => {
    reply('DELETE /api/pages/p1/archive', json({ code: 'X' }, 500));
    mount();
    await press(within(rowOf('p1')).getByRole('button', { name: 'Restore “Old billing model”' }));
    expect(screen.getByText('Couldn’t restore “Old billing model”. Try again.')).toBeTruthy();
    expect(rowIds()).toEqual(['p1', 'p2']);
  });
});

describe('Delete…', () => {
  async function openDelete() {
    await press(
      within(rowOf('p1')).getByRole('button', { name: 'More actions for “Old billing model”' }),
    );
    await press(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete…' }));
    return screen.getByRole('alertdialog');
  }

  it('confirming removes the row and toasts; the row is busy behind the confirm', async () => {
    reply(
      'DELETE /api/pages/p1',
      json({ deletedIds: ['p1', 's1', 's2'], rootId: 'p1', subPageCount: 2 }),
    );
    mount();
    const dialog = await openDelete();
    expect(dialog.textContent).toContain('Delete “Old billing model” permanently?');
    expect(rowOf('p1').getAttribute('aria-busy')).toBe('true');
    await press(within(dialog).getByRole('button', { name: 'Delete 3 pages' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rowIds()).toEqual(['p2']);
    expect(screen.getByText('Deleted “Old billing model” and 2 sub-pages')).toBeTruthy();
  });

  it('restored meanwhile: the dialog closes, a toast says so and the row leaves', async () => {
    reply('DELETE /api/pages/p1', json({ code: 'PAGE_NOT_ARCHIVED' }, 409));
    mount();
    const dialog = await openDelete();
    await press(within(dialog).getByRole('button', { name: 'Delete 3 pages' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('“Old billing model” isn’t archived any more')).toBeTruthy();
    expect(rowIds()).toEqual(['p2']);
  });

  it('Cancel keeps the row', async () => {
    mount();
    const dialog = await openDelete();
    await press(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rowIds()).toEqual(['p1', 'p2']);
    expect(rowOf('p1').getAttribute('aria-busy')).toBeNull();
  });
});

describe('paging and states', () => {
  it('Load more appends the next page without duplicates, then stops', async () => {
    const later = deferred();
    reply('GET archived:c1', later.promise);
    mount({ items: [OLD, LOOSE], nextCursor: 'c1' });
    expect(screen.getByText('2 shown')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('button', { name: /Loading…/ })).toBeTruthy();
    await act(async () => {
      later.resolve(json({ items: [LOOSE, item('p3')], nextCursor: null }));
    });
    expect(rowIds()).toEqual(['p1', 'p2', 'p3']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('projectKey')).toBe('VIEW');
  });

  it('a failed Load more is the error row; Try again repeats the same cursor; rows stay', async () => {
    reply(
      'GET archived:c1',
      new TypeError('offline'),
      json({ items: [item('p3')], nextCursor: null }),
    );
    mount({ items: [OLD], nextCursor: 'c1' });
    await press(screen.getByRole('button', { name: 'Load more' }));
    const error = screen.getByTestId('archived-pages-error');
    expect(error.textContent).toContain('Couldn’t load the archived pages.');
    expect(rowIds()).toEqual(['p1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    await press(within(error).getByRole('button', { name: 'Try again' }));
    expect(rowIds()).toEqual(['p1', 'p3']);
    expect(screen.queryByTestId('archived-pages-error')).toBeNull();
  });

  it('a first page the server could not read: the error row, and Try again reads it', async () => {
    reply('GET archived:', json({ code: 'X' }, 500), json({ items: [OLD], nextCursor: null }));
    mount(null);
    const error = screen.getByTestId('archived-pages-error');
    await press(within(error).getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('archived-pages-error')).toBeTruthy();
    await press(
      within(screen.getByTestId('archived-pages-error')).getByRole('button', {
        name: 'Try again',
      }),
    );
    expect(rowIds()).toEqual(['p1']);
  });

  it('none: the empty state, whose action goes back to Pages', async () => {
    mount({ items: [], nextCursor: null });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No archived pages')).toBeTruthy();
    expect(
      screen.getByText(
        'When a page is archived from the tree, it shows up here with its sub-pages until someone restores or deletes it.',
      ),
    ).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Back to Pages' }));
    expect(push).toHaveBeenCalledWith('/pages');
  });
});
