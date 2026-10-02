// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import type { FolderCommandActions } from '@/components/folders/folderActions';
import type { FolderDto } from '@/lib/dto/folders';
import { ToastProvider } from '@/components/ui/Toast';
import { FolderCommandsProvider, NewRootFolderButton } from '@/components/folders/FolderCommands';
import zhMessages from '@/messages/zh.json';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';

// MOVING IN THE PAGE TREE (Story MOTIR-5753 · MOTIR-7374) — `PageTree`'s page
// row menu (`PageRowMenu`), the Move to… picker (`PagePlacementPicker`), the
// placement hook (`usePageMove`) and the folder rows' shipped folder commands,
// against `design/pages/pages--tree.mock.html` panels 2, 9, 10 and 12.
//
// Rendered with the real catalogs, rows, menus, picker and Toast. The stubs are
// `fetch` (the level read and the placement PATCH — `tests/api/pages-routes-tree`
// proves the routes), the router, and the folder actions, which the tree is
// HANDED as props exactly as `/pages` hands it the `/items` server actions.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  unstable_isUnrecognizedActionError: () => false,
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';
import { reorderNeighbours, usePageMove } from '@/components/pages/tree/usePageMove';

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
const level = (rows: PageTreeRowDto[], nextCursor: string | null = null): PageTreeLevelDto => ({
  rows,
  nextCursor,
});

const ROOT = level([
  folder('f1', 'Specs'),
  folder('f2', 'Runbooks'),
  page('p1', 'Auth flow', true),
  page('p2', 'Billing model'),
  page('p3', 'Onboarding'),
]);

type Answer = PageTreeLevelDto | number | { status: number; body: unknown };
let table: Record<string, Answer> = {};
let patchAnswers: Answer[] = [];
const reads: string[] = [];
const patches: { url: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function answer(value: Answer | undefined): Promise<Response> {
  if (value === undefined) return Promise.reject(new TypeError('Failed to fetch'));
  if (typeof value === 'number') return Promise.resolve(json({ code: 'X' }, value));
  if ('status' in value) return Promise.resolve(json(value.body, value.status));
  return Promise.resolve(json(value));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  if (init?.method === 'PATCH') {
    patches.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
    return answer(patchAnswers.shift());
  }
  const parent = url.searchParams.get('parent')!;
  reads.push(`${parent}:${url.searchParams.get('limit')}`);
  return answer(table[parent]);
});

const moved = (id: string, parent: unknown) => ({
  status: 200,
  body: { id, parent, position: 'a5', ancestorPageIds: [], moved: true },
});

function folderDto(id: string, name: string, parentFolderId: string | null = null): FolderDto {
  return {
    id,
    projectId: 'proj',
    parentFolderId,
    name,
    position: 'a0',
    createdById: 'u1',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function makeActions(): { [K in keyof FolderCommandActions]: ReturnType<typeof vi.fn> } {
  return {
    createFolder: vi.fn(
      async ({ name, parentFolderId }: { name: string; parentFolderId: string | null }) => ({
        ok: true as const,
        folder: folderDto('f9', name, parentFolderId),
      }),
    ),
    renameFolder: vi.fn(async ({ folderId, name }: { folderId: string; name: string }) => ({
      ok: true as const,
      folder: folderDto(folderId, name),
    })),
    moveFolder: vi.fn(async ({ folderId }: { folderId: string }) => ({
      ok: true as const,
      folder: folderDto(folderId, 'x'),
    })),
    listProjectFolders: vi.fn(async () => ({
      ok: true as const,
      data: {
        folders: [
          { id: 'f1', parentFolderId: null, name: 'Specs', position: 'a0', path: ['Specs'] },
          { id: 'f2', parentFolderId: null, name: 'Runbooks', position: 'a1', path: ['Runbooks'] },
        ],
        truncated: false,
      },
    })),
    describeFolderDeletion: vi.fn(async ({ folderId }: { folderId: string }) => ({
      ok: true as const,
      preview: {
        folderId,
        name: 'Specs',
        childFolderCount: 0,
        workItemCount: 0,
        pageCount: 3,
        destination: { folderId: null, name: null },
      },
    })),
    deleteFolder: vi.fn(async ({ folderId }: { folderId: string }) => ({
      ok: true as const,
      result: {
        deletedFolderId: folderId,
        destinationFolderId: null,
        movedFolderIds: [],
        movedWorkItemIds: [],
        movedPageIds: ['p7'],
      },
    })),
  };
}

let actions = makeActions();

function mount(props: Partial<PageTreeProps> = {}, zh = false, header?: ReactNode) {
  return renderWithIntl(
    <ToastProvider>
      <FolderCommandsProvider>
        {header}
        <PageTree
          initialRoot={ROOT}
          projectKey="VIEW"
          canEdit
          canEditFolders
          folderActions={actions as unknown as FolderCommandActions}
          {...props}
        />
      </FolderCommandsProvider>
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

async function openMenu(kind: 'Page' | 'Folder', name: string) {
  await press(screen.getByRole('button', { name: `${kind} actions for ${name}` }));
  return screen.findByRole('menu', { name: `${kind} actions for ${name}` });
}
const entries = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent);
async function choose(menu: HTMLElement, name: string) {
  await press(within(menu).getByRole('menuitem', { name }));
}

beforeEach(() => {
  table = {};
  patchAnswers = [];
  reads.length = 0;
  patches.length = 0;
  actions = makeActions();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  push.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reorderNeighbours — Move up / Move down among sibling pages', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('Move up lands after the page two above and before the one above', () => {
    expect(reorderNeighbours(ids, 'c', 'up')).toEqual({ beforeId: 'a', afterId: 'b' });
    expect(reorderNeighbours(ids, 'b', 'up')).toEqual({ beforeId: null, afterId: 'a' });
  });
  it('Move down lands after the page below and before the one two below', () => {
    expect(reorderNeighbours(ids, 'b', 'down')).toEqual({ beforeId: 'c', afterId: 'd' });
    expect(reorderNeighbours(ids, 'c', 'down')).toEqual({ beforeId: 'd', afterId: null });
  });
  it('is null at the edges and for a page not in the level', () => {
    expect(reorderNeighbours(ids, 'a', 'up')).toBeNull();
    expect(reorderNeighbours(ids, 'd', 'down')).toBeNull();
    expect(reorderNeighbours(ids, 'z', 'up')).toBeNull();
  });
});

describe('Page row menu (panel 2)', () => {
  it('New sub-page · Move to… | Move up · Move down — the edge entries ABSENT', async () => {
    mount();
    expect(entries(await openMenu('Page', 'Auth flow'))).toEqual([
      'New sub-page',
      'Move to…',
      'Move down',
    ]);
    cleanup();
    mount();
    expect(entries(await openMenu('Page', 'Billing model'))).toEqual([
      'New sub-page',
      'Move to…',
      'Move up',
      'Move down',
    ]);
    cleanup();
    mount();
    expect(entries(await openMenu('Page', 'Onboarding'))).toEqual([
      'New sub-page',
      'Move to…',
      'Move up',
    ]);
  });

  it('an only page has neither, and no separator', async () => {
    mount({ initialRoot: level([page('p1', 'Solo')]) });
    const menu = await openMenu('Page', 'Solo');
    expect(entries(menu)).toEqual(['New sub-page', 'Move to…']);
    expect(within(menu).queryByRole('separator')).toBeNull();
  });

  it('Move down PATCHes the neighbours and re-reads the level in place', async () => {
    mount();
    table.root = level([
      folder('f1', 'Specs'),
      folder('f2', 'Runbooks'),
      page('p2', 'Billing model'),
      page('p1', 'Auth flow', true),
      page('p3', 'Onboarding'),
    ]);
    patchAnswers = [moved('p1', { kind: 'root' })];
    await choose(await openMenu('Page', 'Auth flow'), 'Move down');
    expect(patches).toEqual([
      {
        url: '/api/pages/p1/placement',
        body: { parent: { kind: 'root' }, beforeId: 'p2', afterId: 'p3' },
      },
    ]);
    expect(reads).toEqual(['root:50']);
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Billing model', 'Auth flow', 'Onboarding']);
  });

  it('Move up inside a folder names the folder as the parent', async () => {
    table['folder:f1'] = level([page('p5', 'One'), page('p6', 'Two')]);
    mount();
    await press(item('Specs'));
    table['folder:f1'] = level([page('p6', 'Two'), page('p5', 'One')]);
    table.root = ROOT;
    patchAnswers = [moved('p6', { kind: 'folder', id: 'f1' })];
    await choose(await openMenu('Page', 'Two'), 'Move up');
    expect(patches[0]!.body).toEqual({
      parent: { kind: 'folder', id: 'f1' },
      beforeId: null,
      afterId: 'p5',
    });
    // The folder's level is re-read; so is the root, which holds the folder row.
    expect(reads).toEqual(['folder:f1:50', 'folder:f1:50', 'root:50']);
    expect(labels()).toEqual([
      'Specs',
      'Two',
      'One',
      'Runbooks',
      'Auth flow',
      'Billing model',
      'Onboarding',
    ]);
  });

  it('a refused reorder is a toast with the move’s sentence, and nothing is re-read', async () => {
    mount();
    patchAnswers = [{ status: 422, body: { code: 'PAGE_DEPTH_EXCEEDED', limit: 10 } }];
    await choose(await openMenu('Page', 'Billing model'), 'Move up');
    expect(
      await screen.findByText(
        'Pages nest at most 10 levels deep, and this move would go past that. It stayed where it was.',
      ),
    ).toBeTruthy();
    expect(reads).toEqual([]);
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Billing model', 'Onboarding']);
  });

  it('a stale neighbour reads `gone` and re-reads the level', async () => {
    mount();
    table.root = ROOT;
    patchAnswers = [{ status: 422, body: { code: 'PAGE_NEIGHBOUR_INVALID' } }];
    await choose(await openMenu('Page', 'Billing model'), 'Move down');
    expect(
      await screen.findByText(
        'That folder or page no longer exists. The page stayed where it was.',
      ),
    ).toBeTruthy();
    expect(reads).toEqual(['root:50']);
  });

  it('a lost connection is the shipped transport sentence', async () => {
    mount();
    patchAnswers = [];
    await choose(await openMenu('Page', 'Billing model'), 'Move down');
    expect(
      await screen.findByText("That change wasn't saved. Check your connection and try again."),
    ).toBeTruthy();
  });

  it('a viewer gets no menu at all', () => {
    mount({ canEdit: false });
    expect(screen.queryByRole('button', { name: /actions for/ })).toBeNull();
  });
});

describe('Move to… (panels 9–10)', () => {
  async function openPicker(name = 'Billing model') {
    table.root = ROOT;
    await choose(await openMenu('Page', name), 'Move to…');
    return screen.findByRole('listbox', { name: 'Folders and pages' });
  }
  const options = (list: HTMLElement) =>
    within(list)
      .getAllByRole('option')
      .map((el) => el.textContent);

  it('lists Project root first, then the root level; the page itself disabled with its reason', async () => {
    mount();
    const list = await openPicker('Auth flow');
    expect(screen.getByText('Move “Auth flow” to…')).toBeTruthy();
    expect(reads).toEqual(['root:100']);
    expect(options(list)).toEqual([
      'Project rootCurrent location',
      'Specs',
      'Runbooks',
      'Auth flowIt’s this page — a page can’t move into itself or its sub-pages.',
      'Billing model',
      'Onboarding',
    ]);
    const self = within(list).getAllByRole('option')[3]!;
    expect(self.getAttribute('aria-disabled')).toBe('true');
    // No chevron: its sub-pages are never offered.
    expect(within(self).queryByRole('button')).toBeNull();
    expect(self.className).toContain('text-(--el-text-faint)');
  });

  it('expands a folder option lazily, and picking it moves the page there and opens it', async () => {
    mount();
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    const list = await openPicker();
    await press(within(list).getByRole('button', { name: 'Expand Specs' }));
    expect(reads).toEqual(['root:100', 'folder:f1:100']);
    expect(options(list)).toContain('Spec one');

    table.root = level([
      folder('f1', 'Specs'),
      folder('f2', 'Runbooks'),
      page('p1', 'Auth flow', true),
      page('p3', 'Onboarding'),
    ]);
    table['folder:f1'] = level([page('p5', 'Spec one'), page('p2', 'Billing model')]);
    patchAnswers = [moved('p2', { kind: 'folder', id: 'f1' })];
    await press(within(list).getAllByRole('option')[1]!);
    expect(patches[0]!.body).toEqual({
      parent: { kind: 'folder', id: 'f1' },
      beforeId: null,
      afterId: null,
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    // Both levels show the result: the root lost the page, the folder opened with it.
    expect(labels()).toEqual([
      'Specs',
      'Spec one',
      'Billing model',
      'Runbooks',
      'Auth flow',
      'Onboarding',
    ]);
  });

  it('a page can be moved under another page', async () => {
    mount();
    table['page:p1'] = level([page('p4', 'Child'), page('p2', 'Billing model')]);
    const list = await openPicker();
    patchAnswers = [moved('p2', { kind: 'page', id: 'p1' })];
    await press(within(list).getByRole('option', { name: /^Auth flow/ }));
    expect(patches[0]!.body).toMatchObject({ parent: { kind: 'page', id: 'p1' } });
    expect(item('Auth flow').getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toContain('Child');
  });

  it('picking the current location writes nothing', async () => {
    mount();
    const list = await openPicker();
    await press(within(list).getByRole('option', { name: /^Project root/ }));
    expect(patches).toEqual([]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it.each([
    [
      { status: 422, body: { code: 'PAGE_CYCLE' } },
      'A page can’t move into one of its own sub-pages. It stayed where it was.',
    ],
    [
      { status: 422, body: { code: 'PAGE_DEPTH_EXCEEDED', limit: 10, attemptedLevel: 11 } },
      'Pages nest at most 10 levels deep, and this move would go past that. It stayed where it was.',
    ],
    [
      { status: 422, body: { code: 'CROSS_PROJECT_PAGE_PARENT' } },
      'That folder or page belongs to another project. The page stayed where it was.',
    ],
    [
      { status: 404, body: { code: 'FOLDER_NOT_FOUND' } },
      'That folder or page no longer exists. The page stayed where it was.',
    ],
  ])(
    'a forced refusal renders its sentence at the picker’s top; the tree is unchanged',
    async (refusal, sentence) => {
      mount();
      const list = await openPicker();
      patchAnswers = [refusal];
      const before = labels();
      const readsBefore = reads.length;
      await press(within(list).getByRole('option', { name: 'Runbooks' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(sentence);
      expect(screen.getByRole('listbox')).toBeTruthy();
      expect(labels()).toEqual(before);
      // No TREE level is re-read; a `gone` only re-opens the picker's own list.
      const treeReads = reads.slice(readsBefore).filter((r) => !r.endsWith(':100'));
      expect(treeReads).toEqual([]);
    },
  );

  it('the listbox is keyboard-driven: arrows move, → expands, Enter picks, Esc dismisses', async () => {
    mount();
    table['folder:f1'] = level([]);
    const list = await openPicker();
    expect(document.activeElement).toBe(list);
    const active = () => document.getElementById(list.getAttribute('aria-activedescendant')!)!;
    expect(active().textContent).toContain('Project root');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(active().textContent).toBe('Specs');
    await act(async () => {
      fireEvent.keyDown(list, { key: 'ArrowRight' });
    });
    expect(reads).toContain('folder:f1:100');
    await act(async () => {
      fireEvent.keyDown(list, { key: 'ArrowLeft' });
    });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(active().textContent).toContain('Project root');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(active().textContent).toBe('Onboarding');
    patchAnswers = [moved('p2', { kind: 'root' })];
    table.root = ROOT;
    await act(async () => {
      fireEvent.keyDown(list, { key: 'Enter' });
    });
    expect(patches[0]!.body).toMatchObject({ parent: { kind: 'page', id: 'p3' } });

    const again = await openPicker();
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a failed picker read offers Try again, and a long level Load more', async () => {
    mount();
    table.root = 500;
    await choose(await openMenu('Page', 'Billing model'), 'Move to…');
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Couldn’t load what’s inside.')).toBeTruthy();
    table.root = level([page('p2', 'Billing model')], 'c1');
    await press(within(list).getByRole('button', { name: 'Try again' }));
    expect(within(list).getByRole('button', { name: 'Load more' })).toBeTruthy();
    table.root = level([page('p8', 'Later')]);
    await press(within(list).getByRole('button', { name: 'Load more' }));
    expect(within(list).getByRole('option', { name: 'Later' })).toBeTruthy();
  });

  it('renders zh chrome', async () => {
    mount({}, true);
    table.root = ROOT;
    await press(screen.getByRole('button', { name: '“Billing model”的页面操作' }));
    const menu = await screen.findByRole('menu');
    await press(within(menu).getByRole('menuitem', { name: '移动到…' }));
    expect(await screen.findByRole('listbox', { name: '文件夹和页面' })).toBeTruthy();
  });
});

describe('Folder rows — the shared folder commands (panels 2, 12)', () => {
  it('New page here, then the shipped folder menu — edge Move up / down DISABLED', async () => {
    mount();
    const menu = await openMenu('Folder', 'Specs');
    expect(entries(menu)).toEqual([
      'New page here',
      'New folder inside',
      'Rename',
      'Move to…',
      'Move up',
      'Move down',
      'Delete…',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Move up' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Move down' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('without folder permission (or actions) the menu holds New page here alone', async () => {
    mount({ canEditFolders: false });
    expect(entries(await openMenu('Folder', 'Specs'))).toEqual(['New page here']);
  });

  it('New folder inside opens the name row first in the folder, and the folder lands there', async () => {
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'New folder inside');
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: '  ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'API' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(actions.createFolder).toHaveBeenCalledWith({ parentFolderId: 'f1', name: 'API' });
    expect(labels()).toEqual([
      'Specs',
      'API',
      'Spec one',
      'Runbooks',
      'Auth flow',
      'Billing model',
      'Onboarding',
    ]);
  });

  it('a taken name keeps the row open with the shipped reason; Escape cancels', async () => {
    actions.createFolder.mockResolvedValueOnce({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      error: 'taken',
    });
    mount({}, false, <NewRootFolderButton />);
    await press(screen.getByRole('button', { name: 'New folder' }));
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'Specs' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.getByText('A folder named “Specs” is already here.')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('the header’s New folder on an EMPTY project shows the tree with the name row', async () => {
    mount(
      { initialRoot: level([]), emptyState: <p>Nothing yet</p> },
      false,
      <NewRootFolderButton />,
    );
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'New folder' }));
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'Specs' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(actions.createFolder).toHaveBeenCalledWith({ parentFolderId: null, name: 'Specs' });
    expect(labels()).toEqual(['Specs']);
  });

  it('Rename edits the name in place', async () => {
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Rename');
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'Ops' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(actions.renameFolder).toHaveBeenCalledWith({ folderId: 'f2', name: 'Ops' });
    expect(labels()).toEqual(['Specs', 'Ops', 'Auth flow', 'Billing model', 'Onboarding']);
  });

  it('Move to… picks a folder and re-reads the source level; a cycle is refused at the top', async () => {
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders' });
    actions.moveFolder.mockResolvedValueOnce({ ok: false, code: 'FOLDER_CYCLE', error: 'x' });
    await press(within(list).getByRole('option', { name: 'Specs' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A folder can’t move into one of its own folders.',
    );
    table.root = level([folder('f1', 'Specs'), page('p1', 'Auth flow', true)]);
    const relisted = await screen.findByRole('listbox', { name: 'Folders' });
    await press(within(relisted).getByRole('option', { name: 'Specs' }));
    expect(actions.moveFolder).toHaveBeenLastCalledWith({
      folderId: 'f2',
      targetParentFolderId: 'f1',
    });
    expect(reads).toEqual(['root:50']);
    expect(labels()).toEqual(['Specs', 'Auth flow']);
  });

  it('Move down reorders through the folder move, and re-reads the level', async () => {
    mount();
    table.root = level([folder('f2', 'Runbooks'), folder('f1', 'Specs')]);
    await choose(await openMenu('Folder', 'Specs'), 'Move down');
    expect(actions.moveFolder).toHaveBeenCalledWith({
      folderId: 'f1',
      targetParentFolderId: null,
      beforeId: 'f2',
      afterId: null,
    });
    expect(labels()).toEqual(['Runbooks', 'Specs']);
  });

  it('Delete names the page count; confirming removes the folder and its pages show at the parent', async () => {
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'Delete…');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('folder-delete-moves').textContent).toBe(
      '3 pages will move to Project root. No work items or pages are deleted.',
    );
    table.root = level([
      folder('f2', 'Runbooks'),
      page('p1', 'Auth flow', true),
      page('p7', 'Moved up'),
    ]);
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(actions.deleteFolder).toHaveBeenCalledWith({ folderId: 'f1' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels()).toEqual(['Runbooks', 'Auth flow', 'Moved up']);
  });

  it('a delete refusal stays in the open dialog', async () => {
    actions.deleteFolder.mockResolvedValueOnce({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      error: 'x',
      folderName: 'API',
    });
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'Delete…');
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('A folder named “API”');
  });

  it('a transport failure is the shipped toast', async () => {
    actions.renameFolder.mockRejectedValueOnce(new Error('offline'));
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'Rename');
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'X' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(
      await screen.findByText("That change wasn't saved. Check your connection and try again."),
    ).toBeTruthy();
  });
});

describe('usePageMove — sequencing', () => {
  it('drops the answer of a move a newer move of the same page superseded', async () => {
    const refresh = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {children}
      </NextIntlClientProvider>
    );
    const { result } = renderHook(() => usePageMove({ refresh }), { wrapper });
    patchAnswers = [moved('p1', { kind: 'root' }), moved('p1', { kind: 'folder', id: 'f1' })];
    let first: unknown;
    let second: unknown;
    await act(async () => {
      const a = result.current.move({ pageId: 'p1', from: 'root', parent: { kind: 'root' } });
      const b = result.current.move({
        pageId: 'p1',
        from: 'root',
        parent: { kind: 'folder', id: 'f1' },
      });
      [first, second] = await Promise.all([a, b]);
    });
    expect(first).toBeNull();
    expect(second).toMatchObject({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(['root', 'folder:f1']);
  });
});
