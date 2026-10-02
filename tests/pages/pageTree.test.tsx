// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { FileText } from 'lucide-react';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { ToastProvider } from '@/components/ui/Toast';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';

// THE PAGE TREE (Story MOTIR-5753 · MOTIR-7373) — `components/pages/tree/PageTree.tsx`
// against `design/pages/pages--tree.mock.html` panels 1–8 and `design-notes.md`
// § The page tree. Rendered with the real catalogs, the real row components,
// the real `FolderRowMenu` and the real Toast; `fetch` (the level read and the
// create, `tests/api/pages-routes-tree.test.ts` proves the routes themselves)
// and the router are the only stubs.
//
// Every read the tree makes is answered from a per-test table keyed by the
// level it names (`root`, `folder:<id>`, `page:<id>`, plus `@<cursor>` for a
// Load more), so a test says exactly what the server holds and the assertion
// waits on the read's own answer — an `act` around the press that starts it,
// or a hand-settled promise when the in-flight state is the subject.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';

const folder = (id: string, name: string, hasChildren = true): PageTreeRowDto => ({
  kind: 'folder',
  id,
  name,
  hasChildren,
});
const page = (id: string, title: string, hasChildren = false): PageTreeRowDto => ({
  kind: 'page',
  id,
  title,
  hasChildren,
});
const level = (rows: PageTreeRowDto[], nextCursor: string | null = null): PageTreeLevelDto => ({
  rows,
  nextCursor,
});

const ROOT = level([
  folder('f1', 'Specs'),
  folder('f2', 'Runbooks'),
  page('p1', 'Auth flow', true),
  page('p2', ''),
]);

type Answer = PageTreeLevelDto | number | Promise<Response>;
let table: Record<string, Answer> = {};
const reads: string[] = [];
const posts: unknown[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function answer(value: Answer | undefined): Promise<Response> {
  if (value === undefined) return Promise.reject(new TypeError('Failed to fetch'));
  if (typeof value === 'number') return Promise.resolve(json({ code: 'X' }, value));
  if (value instanceof Promise) return value;
  return Promise.resolve(json(value));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  if (init?.method === 'POST') {
    posts.push(JSON.parse(String(init.body)));
    return answer(table['POST']);
  }
  const parent = url.searchParams.get('parent')!;
  const cursor = url.searchParams.get('cursor');
  reads.push(url.search);
  return answer(table[cursor ? `${parent}@${cursor}` : parent]);
});

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function mount(props: Partial<PageTreeProps> = {}, zh = false) {
  return renderWithIntl(
    <ToastProvider>
      <PageTree initialRoot={ROOT} projectKey="VIEW" canEdit {...props} />
    </ToastProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
}

const tree = () => screen.getByRole('tree', { name: 'Folders and pages in this project' });
const item = (name: string) => screen.getByRole('treeitem', { name });
const labels = () =>
  within(tree())
    .getAllByRole('treeitem')
    .map((el) => el.getAttribute('aria-label'));

async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function key(el: Element, k: string) {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
  });
}

beforeEach(() => {
  table = {};
  reads.length = 0;
  posts.length = 0;
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

describe('PageTree — rows and order (panel 1)', () => {
  it('renders the root level as given — folders first, then pages — as a labelled tree', () => {
    mount();
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Untitled']);
    for (const name of ['Specs', 'Runbooks', 'Auth flow', 'Untitled']) {
      expect(item(name).getAttribute('aria-level')).toBe('1');
    }
    // A folder is ALWAYS expandable; a page only when it has sub-pages.
    expect(item('Specs').getAttribute('aria-expanded')).toBe('false');
    expect(item('Runbooks').getAttribute('aria-expanded')).toBe('false');
    expect(item('Auth flow').getAttribute('aria-expanded')).toBe('false');
    expect(item('Untitled').hasAttribute('aria-expanded')).toBe(false);
    // Nothing is read until a row is expanded.
    expect(reads).toEqual([]);
  });

  it('a page row’s title is a link to its address; an untitled page is italic secondary', () => {
    mount();
    const link = within(item('Auth flow')).getByRole('link', { name: 'Auth flow' });
    expect(link.getAttribute('href')).toBe('/pages/p1');
    const untitled = within(item('Untitled')).getByRole('link', { name: 'Untitled' });
    expect(untitled.getAttribute('href')).toBe('/pages/p2');
    expect(untitled.className).toContain('italic');
    expect(untitled.className).toContain('text-(--el-text-secondary)');
    // A page without sub-pages has no chevron, only the reserved slot.
    expect(within(item('Untitled')).queryByRole('button', { name: /Expand/ })).toBeNull();
  });

  it('exactly one row is in the tab order — the first', () => {
    mount();
    const tabbable = within(tree())
      .getAllByRole('treeitem')
      .filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable.map((el) => el.getAttribute('aria-label'))).toEqual(['Specs']);
  });

  it('renders zh chrome beside the writer’s own titles', () => {
    mount({}, true);
    expect(screen.getByRole('tree', { name: '此项目中的文件夹和页面' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: '无标题' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开“Auth flow”' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开文件夹“Specs”' })).toBeTruthy();
  });
});

describe('PageTree — lazy expand (panels 1, 3, 5)', () => {
  it('expanding a folder reads ITS level once, and shows its folders and pages one level down', async () => {
    table['folder:f1'] = level([folder('f3', 'API'), page('p3', 'Token refresh', true)]);
    mount();
    await press(item('Specs'));
    expect(reads).toEqual(['?parent=folder%3Af1&limit=50&projectKey=VIEW']);
    expect(item('Specs').getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toEqual([
      'Specs',
      'API',
      'Token refresh',
      'Runbooks',
      'Auth flow',
      'Untitled',
    ]);
    expect(item('API').getAttribute('aria-level')).toBe('2');
    expect(item('Token refresh').getAttribute('aria-level')).toBe('2');

    // Collapse hides the level; expanding again shows it WITHOUT a second read.
    await press(within(item('Specs')).getByRole('button', { name: 'Collapse folder Specs' }));
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Untitled']);
    await press(within(item('Specs')).getByRole('button', { name: 'Expand folder Specs' }));
    expect(labels()).toContain('API');
    expect(reads).toHaveLength(1);
  });

  it('expanding a page shows its sub-pages; three levels of pages nest', async () => {
    table['page:p1'] = level([page('p4', 'Token refresh', true)]);
    table['page:p4'] = level([page('p5', 'Edge cases')]);
    mount();
    await press(within(item('Auth flow')).getByRole('button', { name: 'Expand Auth flow' }));
    await press(
      within(item('Token refresh')).getByRole('button', { name: 'Expand Token refresh' }),
    );
    expect(item('Edge cases').getAttribute('aria-level')).toBe('3');
    expect(
      within(item('Auth flow')).getByRole('button', { name: 'Collapse Auth flow' }),
    ).toBeTruthy();
    expect(reads.map((r) => new URLSearchParams(r).get('parent'))).toEqual(['page:p1', 'page:p4']);
  });

  it('while a level reads, the row is aria-busy and one status row says Loading pages…', async () => {
    const answerLater = deferred();
    table['folder:f2'] = answerLater.promise;
    mount();
    await press(item('Runbooks'));
    expect(item('Runbooks').getAttribute('aria-busy')).toBe('true');
    expect(item('Runbooks').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading pages…');

    await act(async () => {
      answerLater.resolve(json(level([folder('f4', 'Incidents')])));
    });
    expect(item('Runbooks').hasAttribute('aria-busy')).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    // A level holding only a folder shows it and no message (panel 3).
    expect(screen.queryByText('No pages here')).toBeNull();
  });

  it('an empty folder says so, and offers an editor New page here', async () => {
    table['folder:f2'] = level([]);
    mount();
    await press(item('Runbooks'));
    const empty = screen.getByTestId('page-tree-empty');
    expect(within(empty).getByText('No pages here')).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'New page here' })).toBeTruthy();
  });

  it('an empty page level offers New sub-page instead', async () => {
    table['page:p1'] = level([]);
    mount();
    await press(within(item('Auth flow')).getByRole('button', { name: 'Expand Auth flow' }));
    const empty = screen.getByTestId('page-tree-empty');
    expect(within(empty).getByRole('button', { name: 'New sub-page' })).toBeTruthy();
  });
});

describe('PageTree — errors and retry (panel 6)', () => {
  it('a failed expand leaves the row expanded with an error row; Try again re-reads that level only', async () => {
    table['folder:f1'] = 500;
    mount();
    await press(item('Specs'));
    expect(item('Specs').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load what’s inside.');

    table['folder:f1'] = level([page('p9', 'Retried')]);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(item('Retried').getAttribute('aria-level')).toBe('2');
    expect(reads).toHaveLength(2);
  });

  it('collapsing and expanding a failed row reads it again; a network failure is the same row', async () => {
    mount(); // no table entry: the read rejects
    await press(item('Specs'));
    expect(screen.getByRole('alert')).toBeTruthy();
    await press(item('Specs')); // collapse
    expect(screen.queryByRole('alert')).toBeNull();
    table['folder:f1'] = level([page('p9', 'Second time')]);
    await press(item('Specs')); // expand → re-read
    expect(item('Second time')).toBeTruthy();
    expect(reads).toHaveLength(2);
  });

  it('a failed first level shows the sentence and Try again inside the frame', async () => {
    mount({ initialRoot: null });
    expect(screen.queryByRole('tree')).toBeNull();
    const failed = screen.getByTestId('page-tree-failed');
    expect(within(failed).getByRole('alert').textContent).toContain('Couldn’t load the pages.');

    const later = deferred();
    table['root'] = later.promise;
    await press(within(failed).getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status').textContent).toBe('Loading pages…');
    await act(async () => {
      later.resolve(json(ROOT));
    });
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Untitled']);
  });
});

describe('PageTree — Load more (panel 7)', () => {
  it('a level with more ends in Load more and a count of rows SHOWN; it appends the next read', async () => {
    mount({ initialRoot: level([page('a', 'A'), page('b', 'B')], 'c1') });
    expect(screen.getByText('2 shown')).toBeTruthy();

    const later = deferred();
    table['root@c1'] = later.promise;
    await press(screen.getByRole('button', { name: 'Load more' }));
    expect(new URLSearchParams(reads[0]).get('cursor')).toBe('c1');
    // The same status row covers Load more.
    expect(screen.getByRole('status').textContent).toBe('Loading pages…');
    expect(labels()).toEqual(['A', 'B']);

    await act(async () => {
      later.resolve(json(level([page('c', 'C')])));
    });
    expect(labels()).toEqual(['A', 'B', 'C']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed Load more is the error row; Try again repeats it from the same cursor', async () => {
    mount({ initialRoot: level([page('a', 'A')], 'c1') });
    table['root@c1'] = 503;
    await press(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load what’s inside.');
    table['root@c1'] = level([page('b', 'B')], 'c2');
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(labels()).toEqual(['A', 'B']);
    expect(screen.getByText('2 shown')).toBeTruthy();
    expect(reads.map((r) => new URLSearchParams(r).get('cursor'))).toEqual(['c1', 'c1']);
  });

  it('reads the active project when no project key is given', async () => {
    mount({ initialRoot: level([page('a', 'A')], 'c1'), projectKey: undefined });
    table['root@c1'] = level([]);
    await press(screen.getByRole('button', { name: 'Load more' }));
    expect(new URLSearchParams(reads[0]).has('projectKey')).toBe(false);
  });
});

describe('PageTree — the root read on mount, and the empty project (panel 4)', () => {
  it('with no server-read root, it reads the root itself', async () => {
    table['root'] = ROOT;
    await act(async () => {
      mount({ initialRoot: undefined });
    });
    expect(reads).toEqual(['?parent=root&limit=50&projectKey=VIEW']);
    expect(labels()).toHaveLength(4);
  });

  it('an empty project renders the empty state in place of the tree', () => {
    mount({ initialRoot: level([]), emptyState: <p>Nothing yet</p> });
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('a retry that finds the project empty lands on the same empty state', async () => {
    mount({ initialRoot: null, emptyState: <p>Nothing yet</p> });
    table['root'] = level([]);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Nothing yet')).toBeTruthy();
  });

  it('with no empty state supplied, an empty root is an empty tree', () => {
    mount({ initialRoot: level([]) });
    expect(within(tree()).queryAllByRole('treeitem')).toHaveLength(0);
  });
});

describe('PageTree — New page here / New sub-page (panel 2)', () => {
  it('New sub-page creates under that page, shows Creating page… under it, and opens the new page', async () => {
    const later = deferred();
    table['POST'] = later.promise;
    mount();
    await press(screen.getByRole('button', { name: 'Page actions for Auth flow' }));
    const menu = await screen.findByRole('menu', { name: 'Page actions for Auth flow' });
    await press(within(menu).getByRole('menuitem', { name: 'New sub-page' }));

    expect(posts).toEqual([{ parent: { kind: 'page', id: 'p1' } }]);
    const pending = screen.getByTestId('page-tree-creating');
    expect(pending.textContent).toBe('Creating page…');
    // It sits directly under its parent, one level in.
    const rows = Array.from(tree().children);
    expect(rows.indexOf(pending)).toBe(rows.indexOf(item('Auth flow')) + 1);
    expect(pending.style.paddingLeft).toBe('50px');

    await act(async () => {
      later.resolve(json({ id: 'p-new' }, 201));
    });
    expect(push).toHaveBeenCalledWith('/pages/p-new');
  });

  it('New page here creates in the folder; in an expanded level the pending row leads its pages', async () => {
    table['folder:f1'] = level([folder('f3', 'API'), page('p3', 'Token refresh')]);
    const later = deferred();
    table['POST'] = later.promise;
    mount();
    await press(item('Specs'));
    await press(screen.getByRole('button', { name: 'Folder actions for Specs' }));
    const menu = await screen.findByRole('menu', { name: 'Folder actions for Specs' });
    await press(within(menu).getByRole('menuitem', { name: 'New page here' }));

    expect(posts).toEqual([{ parent: { kind: 'folder', id: 'f1' } }]);
    const rows = Array.from(tree().children);
    const pending = screen.getByTestId('page-tree-creating');
    expect(rows.indexOf(pending)).toBe(rows.indexOf(item('API')) + 1);
    expect(rows.indexOf(pending)).toBe(rows.indexOf(item('Token refresh')) - 1);
    await act(async () => {
      later.resolve(json({ id: 'p-x' }, 201));
    });
  });

  it('an empty level’s New page here creates there; the empty sentence gives way to the pending row', async () => {
    table['folder:f2'] = level([]);
    const later = deferred();
    table['POST'] = later.promise;
    mount();
    await press(item('Runbooks'));
    await press(screen.getByRole('button', { name: 'New page here' }));
    expect(posts).toEqual([{ parent: { kind: 'folder', id: 'f2' } }]);
    expect(screen.queryByText('No pages here')).toBeNull();
    expect(screen.getByTestId('page-tree-creating')).toBeTruthy();
    await act(async () => {
      later.resolve(json({ id: 'p-y' }, 201));
    });
    expect(push).toHaveBeenCalledWith('/pages/p-y');
  });

  it('a pending create while its level still reads, or failed, still shows the pending row', async () => {
    const reading = deferred();
    table['folder:f1'] = reading.promise;
    table['folder:f2'] = 500;
    const creating = deferred();
    table['POST'] = creating.promise;
    mount();
    await press(item('Specs'));
    await press(item('Runbooks'));
    await press(screen.getByRole('button', { name: 'Folder actions for Specs' }));
    await press(
      within(await screen.findByRole('menu', { name: 'Folder actions for Specs' })).getByRole(
        'menuitem',
        { name: 'New page here' },
      ),
    );
    const rows = Array.from(tree().children);
    expect(rows.indexOf(screen.getByTestId('page-tree-creating'))).toBe(
      rows.indexOf(item('Specs')) + 1,
    );
    await act(async () => {
      creating.resolve(json({ code: 'X' }, 500));
      reading.resolve(json(level([])));
    });
  });

  it('a refused create is the shipped toast, the pending row goes, and nothing navigates', async () => {
    table['POST'] = 403;
    mount();
    await press(screen.getByRole('button', { name: 'Page actions for Auth flow' }));
    await press(
      within(await screen.findByRole('menu', { name: 'Page actions for Auth flow' })).getByRole(
        'menuitem',
        { name: 'New sub-page' },
      ),
    );
    expect(await screen.findByText('Couldn’t create the page. Try again.')).toBeTruthy();
    expect(screen.queryByTestId('page-tree-creating')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('a later card’s entries are appended after the row’s own entries, on both kinds of row', async () => {
    const onMove = vi.fn();
    mount({
      pageMenuEntries: (row) => [
        { kind: 'separator', key: 'sep' },
        { kind: 'item', key: 'move', label: `Move ${row.title}`, icon: FileText, onSelect: onMove },
      ],
      folderMenuEntries: (row) => [
        {
          kind: 'item',
          key: 'rename',
          label: `Rename ${row.name}`,
          icon: FileText,
          onSelect: onMove,
        },
      ],
    });
    await press(screen.getByRole('button', { name: 'Page actions for Auth flow' }));
    let menu = await screen.findByRole('menu', { name: 'Page actions for Auth flow' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['New sub-page', 'Move to…', 'Move down', 'Move Auth flow']);
    await press(within(menu).getByRole('menuitem', { name: 'Move Auth flow' }));
    expect(onMove).toHaveBeenCalledTimes(1);

    await press(screen.getByRole('button', { name: 'Folder actions for Specs' }));
    menu = await screen.findByRole('menu', { name: 'Folder actions for Specs' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['New page here', 'Rename Specs']);
  });
});

describe('PageTree — read-only viewer (panel 8)', () => {
  it('a reader without page:edit gets no menu and no New anywhere, and still expands', async () => {
    table['folder:f2'] = level([]);
    mount({ canEdit: false });
    expect(screen.queryByRole('button', { name: /actions for/ })).toBeNull();
    await press(item('Runbooks'));
    expect(screen.getByText('No pages here')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New/ })).toBeNull();
  });
});

describe('PageTree — keyboard (role=tree)', () => {
  it('↑ ↓ Home End move focus between rows, carrying the one tab stop', async () => {
    mount();
    act(() => item('Specs').focus());
    await key(item('Specs'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Runbooks'));
    expect(item('Runbooks').getAttribute('tabindex')).toBe('0');
    expect(item('Specs').getAttribute('tabindex')).toBe('-1');
    await key(item('Runbooks'), 'End');
    expect(document.activeElement).toBe(item('Untitled'));
    await key(item('Untitled'), 'ArrowDown'); // clamps at the end
    expect(document.activeElement).toBe(item('Untitled'));
    await key(item('Untitled'), 'ArrowUp');
    expect(document.activeElement).toBe(item('Auth flow'));
    await key(item('Auth flow'), 'Home');
    expect(document.activeElement).toBe(item('Specs'));
    await key(item('Specs'), 'Tab'); // not the tree's key
    expect(document.activeElement).toBe(item('Specs'));
  });

  it('→ expands, → again steps into the first child; ← steps out to the parent, then collapses', async () => {
    table['folder:f1'] = level([page('p3', 'Token refresh')]);
    mount();
    await key(item('Specs'), 'ArrowRight');
    expect(item('Specs').getAttribute('aria-expanded')).toBe('true');
    await key(item('Specs'), 'ArrowRight');
    expect(document.activeElement).toBe(item('Token refresh'));
    await key(item('Token refresh'), 'ArrowRight'); // a leaf: nothing
    expect(document.activeElement).toBe(item('Token refresh'));
    await key(item('Token refresh'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('Specs'));
    await key(item('Specs'), 'ArrowLeft');
    expect(item('Specs').getAttribute('aria-expanded')).toBe('false');
    await key(item('Specs'), 'ArrowLeft'); // a root row: nothing
    expect(item('Specs').getAttribute('aria-expanded')).toBe('false');
  });

  it('→ on an expanded row whose level is empty stays put', async () => {
    table['folder:f2'] = level([]);
    mount();
    await key(item('Runbooks'), 'ArrowRight');
    act(() => item('Runbooks').focus());
    await key(item('Runbooks'), 'ArrowRight');
    expect(document.activeElement).toBe(item('Runbooks'));
  });

  it('Enter toggles a folder and opens a page', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    table['folder:f1'] = level([]);
    mount();
    await key(item('Specs'), 'Enter');
    expect(item('Specs').getAttribute('aria-expanded')).toBe('true');
    await key(item('Auth flow'), 'Enter');
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).getAttribute('href')).toBe(
      '/pages/p1',
    );
  });

  it('a key pressed on a control inside the row is the control’s, not the tree’s', async () => {
    mount();
    const chevron = within(item('Auth flow')).getByRole('button', { name: 'Expand Auth flow' });
    await key(chevron, 'ArrowDown');
    expect(document.activeElement).not.toBe(item('Untitled'));
    // Focusing a control inside the row does not move the tab stop either.
    act(() => chevron.focus());
    expect(item('Specs').getAttribute('tabindex')).toBe('0');
  });
});

describe('PageTree — windowing a long level (panel 7)', () => {
  it('mounts only the rows near the viewport, and End scrolls the last row in and focuses it', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset['scroller'] ? 200 : 0;
    });
    // happy-dom does no layout: place the tree where a real browser would — its
    // top moves up by however far its scroller has scrolled.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const scrolled = (this.closest('[data-scroller]') as HTMLElement | null)?.scrollTop ?? 0;
      const top = this.getAttribute('role') === 'tree' ? -scrolled : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
    const rows = Array.from({ length: 60 }, (_, i) => page(`p${i}`, `Page ${i}`));
    renderWithIntl(
      <ToastProvider>
        <div data-scroller="1" style={{ overflowY: 'auto' }}>
          <PageTree initialRoot={level(rows)} canEdit={false} />
        </div>
      </ToastProvider>,
    );
    const mounted = within(tree()).getAllByRole('treeitem');
    expect(mounted.length).toBeLessThan(60);
    expect(tree().style.height).toBe('2400px');
    expect(mounted[1]!.style.position).toBe('absolute');
    expect(mounted[1]!.style.top).toBe('40px');

    const scroller = tree().closest('[data-scroller]') as HTMLElement;
    await key(item('Page 0'), 'End');
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(document.activeElement).toBe(item('Page 59'));
  });
});

describe('pageTreeRow — level keys', () => {
  it('a level key and the parent it names round-trip, the root included', async () => {
    const { parentKey, parentOf, rowKey, ROOT_LEVEL } =
      await import('@/components/pages/tree/pageTreeRow');
    expect(parentKey({ kind: 'root' })).toBe(ROOT_LEVEL);
    expect(parentOf(ROOT_LEVEL)).toEqual({ kind: 'root' });
    expect(parentOf(parentKey({ kind: 'folder', id: 'f:1' }))).toEqual({
      kind: 'folder',
      id: 'f:1',
    });
    expect(parentOf('page:p1')).toEqual({ kind: 'page', id: 'p1' });
    expect(rowKey(page('p1', 'x'))).toBe('page:p1');
  });

  it('the compact density draws the sidebar’s 32px rows and 14px indent', () => {
    mount({ density: 'compact' });
    expect(item('Specs').style.height).toBe('32px');
    // 8px in at the top level (MOTIR-7375: the sidebar has no drag gutter).
    expect(item('Specs').style.paddingLeft).toBe('8px');
  });
});
