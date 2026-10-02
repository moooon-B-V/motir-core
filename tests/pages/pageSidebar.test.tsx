// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import Link from 'next/link';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE PAGE'S PLACE (Story MOTIR-5753 · MOTIR-7375) —
// `design/pages/page--tree-sidebar.mock.html` panels 1, 3, 4 and 5:
//
// - `PageTree` with `selectedPageId` / `expandedPath` / `initialLevels`: the
//   path paints open from the server's levels, the page is the selected row,
//   an unseeded path level is read on mount, and the sidebar is navigation only;
// - `revealKey` + `focusRevealed` (`/pages?folder=<id>`): the folder's row takes
//   focus once shown;
// - `PageSidebarLayout`: docked at ≥ 1280px unless the reader hid it (kept in
//   localStorage), a drawer below 1280px closed by Esc, the scrim, or choosing a
//   page.
//
// `fetch` (the level read) and `matchMedia` are the only stubs.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';
import {
  PAGE_SIDEBAR_HIDDEN_STORAGE_KEY,
  PageSidebarLayout,
  resetPageSidebarPreferenceForTests,
} from '@/components/pages/tree/PageSidebarLayout';

const folder = (id: string, name: string): PageTreeRowDto => ({
  kind: 'folder',
  id,
  name,
  hasChildren: true,
});
const page = (id: string, title: string, hasChildren = false): PageTreeRowDto => ({
  kind: 'page',
  id,
  title,
  hasChildren,
});
const level = (rows: PageTreeRowDto[]): PageTreeLevelDto => ({ rows, nextCursor: null });

// folder › page › sub-page: Specs › Auth flow › Edge cases.
const ROOT = level([folder('f1', 'Specs'), page('p0', 'Readme')]);
const SPECS = level([page('p1', 'Auth flow', true)]);
const AUTH = level([page('p2', 'Edge cases'), page('p3', 'Session storage')]);
const PATH = ['folder:f1', 'page:p1'];

let table: Record<string, PageTreeLevelDto | number> = {};
const reads: string[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const parent = new URL(String(input), 'http://localhost').searchParams.get('parent')!;
  reads.push(parent);
  const value = table[parent];
  if (value === undefined || typeof value === 'number') {
    return new Response('{}', { status: typeof value === 'number' ? value : 500 });
  }
  return new Response(JSON.stringify(value), { status: 200 });
});

function sidebarTree(props: Partial<PageTreeProps> = {}) {
  return (
    <PageTree
      density="compact"
      canEdit={false}
      projectKey="VIEW"
      initialRoot={ROOT}
      selectedPageId="p2"
      expandedPath={PATH}
      initialLevels={{ 'folder:f1': SPECS, 'page:p1': AUTH }}
      {...props}
    />
  );
}

/** A `matchMedia` answering the wide query with `wide`, and a way to flip it. */
function stubWidth(wide: boolean) {
  let matches = wide;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })),
  );
  return (next: boolean) => {
    matches = next;
    act(() => {
      for (const l of listeners) l();
    });
  };
}

beforeEach(() => {
  table = {};
  reads.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  resetPageSidebarPreferenceForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sidebarTreeEl = () => screen.getByRole('tree', { name: 'Page tree' });
const labels = () =>
  within(sidebarTreeEl())
    .getAllByRole('treeitem')
    .map((el) => [el.getAttribute('aria-label'), el.getAttribute('aria-level')]);

describe('PageTree — the page selected, its path open', () => {
  it('paints the path open from the server’s levels, with the sub-page selected and no read', () => {
    renderWithIntl(<ToastProvider>{sidebarTree()}</ToastProvider>);
    expect(labels()).toEqual([
      ['Specs', '1'],
      ['Auth flow', '2'],
      ['Edge cases', '3'],
      ['Session storage', '3'],
      ['Readme', '1'],
    ]);
    expect(reads).toEqual([]);
    const selected = screen.getByRole('treeitem', { name: 'Edge cases' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(within(selected).getByRole('link').getAttribute('aria-current')).toBe('page');
    expect(selected.className).toContain('bg-(--el-sidebar-item-bg-active)');
    expect(selected.getAttribute('tabindex')).toBe('0');
    expect(
      screen.getByRole('treeitem', { name: 'Session storage' }).getAttribute('aria-selected'),
    ).toBe('false');
    expect(screen.getByRole('treeitem', { name: 'Specs' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    // Navigation only: no row menus, no New, for anyone.
    expect(screen.queryByRole('button', { name: /actions/i })).toBeNull();
    // Compact rows: 32px, the mock's 8 / 22 / 36px per level.
    expect(selected.style.height).toBe('32px');
    expect(selected.style.paddingLeft).toBe('36px');
  });

  it('reads a path level the server did not hand in on mount, and the root when it was not read', async () => {
    table = { root: ROOT, 'page:p1': AUTH };
    await act(async () => {
      renderWithIntl(
        <ToastProvider>
          {sidebarTree({ initialRoot: undefined, initialLevels: { 'folder:f1': SPECS } })}
        </ToastProvider>,
      );
    });
    expect(reads.sort()).toEqual(['page:p1', 'root']);
    expect(screen.getByRole('treeitem', { name: 'Edge cases' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('shows a path level that fails in the tree’s own grammar', async () => {
    table = { 'page:p1': 500 };
    await act(async () => {
      renderWithIntl(
        <ToastProvider>{sidebarTree({ initialLevels: { 'folder:f1': SPECS } })}</ToastProvider>,
      );
    });
    expect(screen.getByText('Couldn’t load what’s inside.')).toBeTruthy();
  });

  it('scrolls the selected row into view once, and moves focus only when asked', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderWithIntl(<ToastProvider>{sidebarTree()}</ToastProvider>);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
    cleanup();

    // `/pages?folder=<id>`: the folder's row takes the tree's focus.
    renderWithIntl(
      <ToastProvider>
        <PageTree
          initialRoot={ROOT}
          canEdit={false}
          expandedPath={['folder:f1']}
          initialLevels={{ 'folder:f1': SPECS }}
          revealKey="folder:f1"
          focusRevealed
        />
      </ToastProvider>,
    );
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Specs' }));
  });

  it('waits for the selected row to appear before revealing it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    renderWithIntl(
      <ToastProvider>{sidebarTree({ initialLevels: { 'folder:f1': SPECS } })}</ToastProvider>,
    );
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => {
      release(new Response(JSON.stringify(AUTH), { status: 200 }));
    });
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe('PageSidebarLayout', () => {
  const mountLayout = () =>
    renderWithIntl(
      <PageSidebarLayout
        tree={<Link href="/pages/p2">Edge cases</Link>}
        breadcrumb={<nav aria-label="crumbs" />}
      >
        <h1>Page</h1>
      </PageSidebarLayout>,
    );
  const aside = () => screen.getByTestId('page-sidebar');
  const showButton = () => screen.getByRole('button', { name: 'Show page tree' });
  const hideButton = () => screen.getByRole('button', { name: 'Hide page tree' });

  it('docks at a wide width with its head linking to /pages; hiding is remembered', () => {
    stubWidth(true);
    mountLayout();
    expect(aside().getAttribute('data-state')).toBe('docked');
    expect(aside().getAttribute('aria-label')).toBe('Page tree');
    expect(within(aside()).getByRole('link', { name: 'Pages' }).getAttribute('href')).toBe(
      '/pages',
    );
    // The show button is CSS-hidden at xl while the column shows.
    expect(showButton().className).toContain('xl:hidden');

    fireEvent.click(hideButton());
    expect(aside().getAttribute('data-state')).toBe('hidden');
    expect(window.localStorage.getItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY)).toBe('true');
    expect(showButton().className).not.toContain('xl:hidden');

    fireEvent.click(showButton());
    expect(aside().getAttribute('data-state')).toBe('docked');
    expect(window.localStorage.getItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY)).toBeNull();
  });

  it('reads a stored hide on arrival', () => {
    stubWidth(true);
    window.localStorage.setItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY, 'true');
    mountLayout();
    expect(aside().getAttribute('data-state')).toBe('hidden');
  });

  it('keeps working when storage throws — the column shows, and the choice holds for the visit', () => {
    stubWidth(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mountLayout();
    expect(aside().getAttribute('data-state')).toBe('docked');
    fireEvent.click(hideButton());
    expect(aside().getAttribute('data-state')).toBe('hidden');
  });

  it('below 1280px opens as a drawer, closed by Esc, the scrim, or choosing a page', async () => {
    const setWide = stubWidth(false);
    mountLayout();
    // Hidden by CSS below xl until asked for.
    expect(aside().className).toContain('hidden');

    const open = async () => {
      await act(async () => {
        fireEvent.click(showButton());
      });
      expect(aside().getAttribute('data-state')).toBe('drawer');
      expect(aside().getAttribute('role')).toBe('dialog');
      expect(document.activeElement).toBe(hideButton());
    };

    await open();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Enter' });
    });
    expect(aside().getAttribute('data-state')).toBe('drawer');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(aside().getAttribute('data-state')).toBe('docked');
    expect(document.activeElement).toBe(showButton());

    await open();
    fireEvent.click(screen.getByTestId('page-sidebar-scrim'));
    expect(screen.queryByTestId('page-sidebar-scrim')).toBeNull();

    await open();
    fireEvent.click(within(aside()).getByRole('link', { name: 'Edge cases' }));
    expect(screen.queryByTestId('page-sidebar-scrim')).toBeNull();

    await open();
    // A click on the drawer that is not a link leaves it open; Hide closes it.
    fireEvent.click(within(aside()).getByRole('link', { name: 'Pages' }).parentElement!);
    expect(aside().getAttribute('data-state')).toBe('drawer');
    fireEvent.click(hideButton());
    expect(aside().getAttribute('data-state')).toBe('docked');
    // Hiding the drawer is not hiding the column.
    expect(window.localStorage.getItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY)).toBeNull();

    // Widening the window with the drawer open docks the column.
    await open();
    setWide(true);
    expect(aside().getAttribute('data-state')).toBe('docked');
  });

  it('treats a browser with no media queries as wide', () => {
    vi.stubGlobal('matchMedia', undefined);
    mountLayout();
    fireEvent.click(hideButton());
    fireEvent.click(showButton());
    expect(aside().getAttribute('data-state')).toBe('docked');
  });
});
