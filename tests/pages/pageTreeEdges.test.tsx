// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import type { FolderCommandActions } from '@/components/folders/folderActions';
import type { FolderDto } from '@/lib/dto/folders';
import { ToastProvider } from '@/components/ui/Toast';
import { FolderCommandsProvider } from '@/components/folders/FolderCommands';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';

// THE PAGE TREE'S EDGES (Story MOTIR-5753 · MOTIR-7377, the story's Vitest gate).
//
// `pageTree.test.tsx` and `pageTreeMove.test.tsx` drive every happy path and the
// headline refusals of the tree, its row menus and the folder commands. What
// they leave is what a later change could break unseen, and what the story's
// coverage floor over `components/pages/tree/**` measured as untested:
//
//   • every folder-command refusal the tree maps itself — each Move to… code,
//     a failed or refused folder list, a reorder or delete that the transport
//     drops or the server refuses, the delete dialog's three refusals;
//   • the SEQUENCING the island promises (CLAUDE.md § optimistic mutations): an
//     answer to a picker, a name row, a delete dialog or a level read that the
//     reader has since closed or superseded never lands;
//   • folder reorder inside a FOLDER level (the parent the move names), and a
//     nested folder moved to the project root;
//   • `usePageMove`'s mapping of a response that carries no JSON body.
//
// Same harness as the sibling suites: real catalogs, rows, menus, pickers and
// Toast; stubbed `fetch`, router, and the folder actions the page hands in.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  unstable_isUnrecognizedActionError: () => false,
}));

import { PageTree, type PageTreeProps } from '@/components/pages/tree/PageTree';
import { usePageMove } from '@/components/pages/tree/usePageMove';

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
  page('p2', 'Billing model'),
]);

/** A level's answer: a level, an HTTP status, or a held response the test releases. */
type Answer = PageTreeLevelDto | number | { status: number; body: unknown } | Promise<Response>;
let table: Record<string, Answer> = {};
let patchAnswers: Answer[] = [];
const reads: string[] = [];
const patches: { url: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function answer(value: Answer | undefined): Promise<Response> {
  if (value === undefined) return Promise.reject(new TypeError('Failed to fetch'));
  if (value instanceof Promise) return value;
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
  const cursor = url.searchParams.get('cursor');
  reads.push(`${parent}:${url.searchParams.get('limit')}${cursor ? `@${cursor}` : ''}`);
  return answer(table[cursor ? `${parent}@${cursor}` : parent]);
});

/** A promise the test resolves by hand — an answer still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

const FOLDER_LIST = {
  ok: true as const,
  data: {
    folders: [
      { id: 'f1', parentFolderId: null, name: 'Specs', position: 'a0', path: ['Specs'] },
      { id: 'f2', parentFolderId: null, name: 'Runbooks', position: 'a1', path: ['Runbooks'] },
      {
        id: 'd1',
        parentFolderId: 'f1',
        name: 'Drafts',
        position: 'a0',
        path: ['Specs', 'Drafts'],
      },
    ],
    truncated: false,
  },
};

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
    listProjectFolders: vi.fn(async () => FOLDER_LIST),
    describeFolderDeletion: vi.fn(async ({ folderId }: { folderId: string }) => ({
      ok: true as const,
      preview: {
        folderId,
        name: 'Specs',
        childFolderCount: 0,
        workItemCount: 0,
        pageCount: 2,
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
        movedPageIds: [],
      },
    })),
  };
}

let actions = makeActions();

function tree(props: Partial<PageTreeProps> = {}) {
  return (
    <ToastProvider>
      <FolderCommandsProvider>
        <PageTree
          initialRoot={ROOT}
          projectKey="VIEW"
          canEdit
          canEditFolders
          folderActions={actions as unknown as FolderCommandActions}
          {...props}
        />
      </FolderCommandsProvider>
    </ToastProvider>
  );
}
const mount = (props: Partial<PageTreeProps> = {}) => renderWithIntl(tree(props));

const treeEl = () => screen.getByRole('tree', { name: 'Folders and pages in this project' });
const labels = () =>
  within(treeEl())
    .getAllByRole('treeitem')
    .map((el) => el.getAttribute('aria-label'));

async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function settle() {
  await act(async () => {});
}
async function openMenu(kind: 'Page' | 'Folder', name: string) {
  await press(screen.getByRole('button', { name: `${kind} actions for ${name}` }));
  return screen.findByRole('menu', { name: `${kind} actions for ${name}` });
}
async function choose(menu: HTMLElement, name: string) {
  await press(within(menu).getByRole('menuitem', { name }));
}
async function typeName(value: string) {
  const input = await screen.findByRole('textbox', { name: 'Folder name' });
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  return input;
}
const TRANSPORT = "That change wasn't saved. Check your connection and try again.";

beforeEach(() => {
  table = {};
  patchAnswers = [];
  reads.length = 0;
  patches.length = 0;
  actions = makeActions();
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

describe('folder Move to… — the list it picks from', () => {
  it('a list read the transport drops closes the picker with the shipped sentence', async () => {
    actions.listProjectFolders.mockRejectedValueOnce(new Error('offline'));
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
    expect(await screen.findByText(TRANSPORT)).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: 'Folders' })).toBeNull();
  });

  it('a refused list read keeps the picker open, empty, with the refusal at its top', async () => {
    actions.listProjectFolders.mockResolvedValueOnce({ ok: false, error: 'No folders for you.' });
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
    expect((await screen.findByRole('alert')).textContent).toBe('No folders for you.');
    const list = screen.getByRole('listbox', { name: 'Folders' });
    // Only the project root is offered; no folder was listed.
    expect(within(list).getAllByRole('option')).toHaveLength(1);
  });

  it('a list that answers after the picker was dismissed is dropped', async () => {
    const held = deferred<typeof FOLDER_LIST>();
    actions.listProjectFolders.mockReturnValueOnce(held.promise);
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => held.resolve(FOLDER_LIST));
    expect(screen.queryByRole('listbox', { name: 'Folders' })).toBeNull();
  });
  it('a list read that fails after the picker was dismissed says nothing', async () => {
    const held = deferred<typeof FOLDER_LIST>();
    actions.listProjectFolders.mockReturnValueOnce(held.promise);
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Escape' });
    await act(async () => held.reject(new Error('offline')));
    expect(screen.queryByText(TRANSPORT)).toBeNull();
  });
});

describe('folder Move to… — every refusal the tree maps', () => {
  async function pickSpecsFor(name: string) {
    await choose(await openMenu('Folder', name), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders' });
    await press(within(list).getByRole('option', { name: 'Specs' }));
  }

  it.each([
    ['CROSS_PROJECT_FOLDER', 'That folder belongs to another project.'],
    ['FOLDER_NAME_TAKEN', 'A folder named “Runbooks” is already here.'],
    ['FOLDER_NOT_FOUND', 'That folder no longer exists.'],
  ])('%s says why at the picker’s top and re-lists the folders', async (code, sentence) => {
    actions.moveFolder.mockResolvedValueOnce({ ok: false, code, error: 'x' });
    mount();
    await pickSpecsFor('Runbooks');
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    expect(actions.listProjectFolders).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('listbox', { name: 'Folders' })).toBeTruthy();
    expect(reads).toEqual([]);
  });

  it('a code the picker has no sentence for is a toast; the picker stays open to try again', async () => {
    actions.moveFolder.mockResolvedValueOnce({
      ok: false,
      code: 'SOMETHING_ELSE',
      error: 'The server said no.',
    });
    mount();
    await pickSpecsFor('Runbooks');
    expect(await screen.findByText('The server said no.')).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Folders' });
    expect(actions.listProjectFolders).toHaveBeenCalledTimes(1);
    // No longer pending: a second pick is a second write.
    await press(within(list).getByRole('option', { name: 'Specs' }));
    expect(actions.moveFolder).toHaveBeenCalledTimes(2);
  });

  it('a move the transport drops is the shipped toast, and the picker can pick again', async () => {
    actions.moveFolder.mockRejectedValueOnce(new Error('offline'));
    mount();
    await pickSpecsFor('Runbooks');
    expect(await screen.findByText(TRANSPORT)).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Folders' });
    await press(within(list).getByRole('option', { name: 'Specs' }));
    expect(actions.moveFolder).toHaveBeenCalledTimes(2);
    expect(reads).toEqual(['root:50']);
  });

  it('a refusal that answers after the picker was dismissed is dropped', async () => {
    const held = deferred<unknown>();
    actions.moveFolder.mockReturnValueOnce(held.promise);
    mount();
    await pickSpecsFor('Runbooks');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await act(async () => held.resolve({ ok: false, code: 'FOLDER_CYCLE', error: 'x' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('listbox', { name: 'Folders' })).toBeNull();
    expect(actions.listProjectFolders).toHaveBeenCalledTimes(1);
  });

  it('a nested folder moved to the project root names no parent and re-reads both levels', async () => {
    table['folder:f1'] = level([folder('d1', 'Drafts', false), page('p5', 'Spec one')]);
    mount();
    await press(screen.getByRole('treeitem', { name: 'Specs' }));
    await choose(await openMenu('Folder', 'Drafts'), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders' });
    table.root = level([
      ...ROOT.rows.slice(0, 2),
      folder('d1', 'Drafts', false),
      ...ROOT.rows.slice(2),
    ]);
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    await press(within(list).getByRole('option', { name: /^Project root/ }));
    expect(actions.moveFolder).toHaveBeenCalledWith({ folderId: 'd1', targetParentFolderId: null });
    expect(reads.slice(1).sort()).toEqual(['folder:f1:50', 'root:50']);
    expect(labels()).toEqual([
      'Specs',
      'Spec one',
      'Runbooks',
      'Drafts',
      'Auth flow',
      'Billing model',
    ]);
  });
});

describe('folder Move up / Move down inside a folder level', () => {
  const SUB = level([
    folder('d1', 'Alpha', false),
    folder('d2', 'Beta', false),
    folder('d3', 'Gamma', false),
  ]);

  async function openSpecs() {
    table['folder:f1'] = SUB;
    // A reorder re-reads the folder's level and the root that holds its row.
    table.root = ROOT;
    mount();
    await press(screen.getByRole('treeitem', { name: 'Specs' }));
  }

  it('names the folder the level sits in, and the neighbours on each side', async () => {
    await openSpecs();
    await choose(await openMenu('Folder', 'Gamma'), 'Move up');
    expect(actions.moveFolder).toHaveBeenLastCalledWith({
      folderId: 'd3',
      targetParentFolderId: 'f1',
      beforeId: 'd1',
      afterId: 'd2',
    });
    await choose(await openMenu('Folder', 'Beta'), 'Move up');
    expect(actions.moveFolder).toHaveBeenLastCalledWith({
      folderId: 'd2',
      targetParentFolderId: 'f1',
      beforeId: null,
      afterId: 'd1',
    });
    await choose(await openMenu('Folder', 'Alpha'), 'Move down');
    expect(actions.moveFolder).toHaveBeenLastCalledWith({
      folderId: 'd1',
      targetParentFolderId: 'f1',
      beforeId: 'd2',
      afterId: 'd3',
    });
    // Each success re-reads the folder's level (and the root, which holds Specs).
    expect(reads.filter((r) => r === 'folder:f1:50')).toHaveLength(4);
  });

  it('a refused reorder is the server’s sentence as a toast, and nothing is re-read', async () => {
    await openSpecs();
    actions.moveFolder.mockResolvedValueOnce({ ok: false, code: 'X', error: 'Not now.' });
    await choose(await openMenu('Folder', 'Beta'), 'Move down');
    expect(await screen.findByText('Not now.')).toBeTruthy();
    expect(reads).toEqual(['folder:f1:50']);
  });

  it('a reorder the transport drops is the shipped toast', async () => {
    await openSpecs();
    actions.moveFolder.mockRejectedValueOnce(new Error('offline'));
    await choose(await openMenu('Folder', 'Beta'), 'Move up');
    expect(await screen.findByText(TRANSPORT)).toBeTruthy();
    expect(reads).toEqual(['folder:f1:50']);
  });
});

describe('folder writes a newer write of the same folder superseded', () => {
  it('an older reorder’s answer — success or failure — is dropped once a newer one was sent', async () => {
    const SUB = level([
      folder('d1', 'Alpha', false),
      folder('d2', 'Beta', false),
      folder('d3', 'Gamma', false),
    ]);
    table['folder:f1'] = SUB;
    table.root = ROOT;
    const older = deferred<unknown>();
    const oldest = deferred<unknown>();
    actions.moveFolder
      .mockReturnValueOnce(oldest.promise)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ ok: false, code: 'X', error: 'Newest refused.' });
    mount();
    await press(screen.getByRole('treeitem', { name: 'Specs' }));
    reads.length = 0;
    await choose(await openMenu('Folder', 'Beta'), 'Move down');
    await choose(await openMenu('Folder', 'Beta'), 'Move up');
    await choose(await openMenu('Folder', 'Beta'), 'Move down');
    expect(await screen.findByText('Newest refused.')).toBeTruthy();
    await act(async () => {
      oldest.reject(new Error('offline'));
      older.resolve({ ok: true, folder: folderDto('d2', 'Beta', 'f1') });
    });
    // Neither late answer re-read a level nor raised the transport sentence.
    expect(reads).toEqual([]);
    expect(screen.queryByText(TRANSPORT)).toBeNull();
  });

  it('a picker move a later reorder of the same folder superseded is dropped', async () => {
    const pickedFail = deferred<unknown>();
    const pickedOk = deferred<unknown>();
    const picks = [pickedFail.promise, pickedOk.promise];
    // A Move to… names no neighbours; a reorder does — and answers at once.
    actions.moveFolder.mockImplementation(async (input: { beforeId?: string | null }) =>
      'beforeId' in input ? { ok: true, folder: folderDto('f2', 'Runbooks') } : picks.shift(),
    );
    table.root = ROOT;
    mount();
    for (const held of [pickedFail, pickedOk]) {
      await choose(await openMenu('Folder', 'Runbooks'), 'Move to…');
      const list = await screen.findByRole('listbox', { name: 'Folders' });
      await press(within(list).getByRole('option', { name: 'Specs' }));
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      await choose(await openMenu('Folder', 'Runbooks'), 'Move up');
      reads.length = 0;
      await act(async () => {
        if (held === pickedFail) held.reject(new Error('offline'));
        else held.resolve({ ok: true, folder: folderDto('f2', 'Runbooks', 'f1') });
      });
      expect(reads).toEqual([]);
      expect(screen.queryByText(TRANSPORT)).toBeNull();
    }
  });
});

describe('folder Delete… — what the dialog does with each answer', () => {
  async function openDelete(name = 'Specs') {
    await choose(await openMenu('Folder', name), 'Delete…');
  }

  it('a count the transport drops closes the dialog with the shipped sentence', async () => {
    actions.describeFolderDeletion.mockRejectedValueOnce(new Error('offline'));
    mount();
    await openDelete();
    expect(await screen.findByText(TRANSPORT)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a folder already gone leaves its level with no dialog; another refusal is a toast', async () => {
    actions.describeFolderDeletion
      .mockResolvedValueOnce({ ok: false, code: 'FOLDER_NOT_FOUND', error: 'gone' })
      .mockResolvedValueOnce({ ok: false, code: 'X', error: 'Cannot count.' });
    mount();
    await openDelete();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels()).toEqual(['Runbooks', 'Auth flow', 'Billing model']);
    await openDelete('Runbooks');
    expect(await screen.findByText('Cannot count.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels()).toEqual(['Runbooks', 'Auth flow', 'Billing model']);
  });

  it('a count that answers after the dialog was cancelled is dropped', async () => {
    const held = deferred<unknown>();
    actions.describeFolderDeletion.mockReturnValueOnce(held.promise);
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => held.resolve({ ok: false, code: 'FOLDER_NOT_FOUND', error: 'gone' }));
    // The late "gone" did not remove a row the reader never confirmed deleting.
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Billing model']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a count or a delete the transport drops after the dialog was cancelled says nothing', async () => {
    const count = deferred<unknown>();
    actions.describeFolderDeletion.mockReturnValueOnce(count.promise);
    mount();
    await openDelete();
    await press(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    await act(async () => count.reject(new Error('offline')));
    expect(screen.queryByText(TRANSPORT)).toBeNull();

    const del = deferred<unknown>();
    actions.deleteFolder.mockReturnValueOnce(del.promise);
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await press(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => del.reject(new Error('offline')));
    expect(screen.queryByText(TRANSPORT)).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a delete the transport drops keeps the dialog, confirmable again', async () => {
    actions.deleteFolder.mockRejectedValueOnce(new Error('offline'));
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(await screen.findByText(TRANSPORT)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Delete folder' });
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });

  it('a folder deleted meanwhile closes the dialog and leaves its level, with no re-read', async () => {
    actions.deleteFolder.mockResolvedValueOnce({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
      error: 'gone',
    });
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels()).toEqual(['Runbooks', 'Auth flow', 'Billing model']);
    expect(reads).toEqual([]);
  });

  it.each([
    [
      { ok: false, code: 'SUBTASK_NEEDS_PLACEMENT', error: 'x' },
      'A subtask filed here would be left at the project root',
    ],
    [
      { ok: false, code: 'FOLDER_NAME_TAKEN', error: 'x', folderName: null },
      'A folder named “” is already where these would move.',
    ],
  ])('a refusal the dialog can explain stays in it: %o', async (refusal, sentence) => {
    actions.deleteFolder.mockResolvedValueOnce(refusal);
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(sentence);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(reads).toEqual([]);
  });

  it('a refusal it cannot explain is a toast, and the dialog stays open', async () => {
    actions.deleteFolder.mockResolvedValueOnce({ ok: false, code: 'X', error: 'Server says no.' });
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    expect(await screen.findByText('Server says no.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a delete that answers after the dialog was cancelled changes nothing on screen', async () => {
    const held = deferred<unknown>();
    actions.deleteFolder.mockReturnValueOnce(held.promise);
    mount();
    await openDelete();
    const dialog = await screen.findByRole('alertdialog');
    await press(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await press(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () =>
      held.resolve({
        ok: true,
        result: {
          deletedFolderId: 'f1',
          destinationFolderId: null,
          movedFolderIds: [],
          movedWorkItemIds: [],
          movedPageIds: [],
        },
      }),
    );
    expect(reads).toEqual([]);
    expect(labels()).toEqual(['Specs', 'Runbooks', 'Auth flow', 'Billing model']);
  });
});

describe('the folder name row — refusals and answers it no longer waits for', () => {
  it('an invalid name is the required-name reason; another refusal is a toast', async () => {
    actions.renameFolder
      .mockResolvedValueOnce({ ok: false, code: 'INVALID_FOLDER_NAME', error: 'x' })
      .mockResolvedValueOnce({ ok: false, code: 'X', error: 'Rename refused.' });
    mount();
    await choose(await openMenu('Folder', 'Runbooks'), 'Rename');
    await typeName('???');
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    await typeName('Ops');
    expect(await screen.findByText('Rename refused.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toBeTruthy();
  });

  it('a create that answers after the row was cancelled adds no folder', async () => {
    const held = deferred<unknown>();
    actions.createFolder.mockReturnValueOnce(held.promise);
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'New folder inside');
    const input = await typeName('API');
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => held.resolve({ ok: true, folder: folderDto('f9', 'API', 'f1') }));
    expect(labels()).not.toContain('API');
  });

  it('a create the transport drops after the row was cancelled says nothing', async () => {
    const held = deferred<unknown>();
    actions.createFolder.mockReturnValueOnce(held.promise);
    table['folder:f1'] = level([]);
    mount();
    await choose(await openMenu('Folder', 'Specs'), 'New folder inside');
    const input = await typeName('API');
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => held.reject(new Error('offline')));
    expect(screen.queryByText(TRANSPORT)).toBeNull();
  });

  it('a rename changes the folder where it is loaded, and leaves every other level alone', async () => {
    table['folder:f1'] = level([folder('d1', 'Drafts', false), page('p5', 'Spec one')]);
    mount();
    await press(screen.getByRole('treeitem', { name: 'Specs' }));
    await choose(await openMenu('Folder', 'Drafts'), 'Rename');
    await typeName('Notes');
    expect(labels()).toEqual([
      'Specs',
      'Notes',
      'Spec one',
      'Runbooks',
      'Auth flow',
      'Billing model',
    ]);
  });
});

describe('page Move to… and the level reads — what a late answer may not do', () => {
  it('an untitled page’s picker is titled with the untitled name', async () => {
    table.root = ROOT;
    mount({ initialRoot: level([page('p9', '')]) });
    await choose(await openMenu('Page', 'Untitled'), 'Move to…');
    expect(await screen.findByText('Move “Untitled” to…')).toBeTruthy();
  });

  it('a move that lands after the picker was dismissed opens nothing', async () => {
    const held = deferred<Response>();
    table.root = ROOT;
    mount();
    await choose(await openMenu('Page', 'Billing model'), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders and pages' });
    patchAnswers = [held.promise];
    await press(within(list).getByRole('option', { name: 'Specs' }));
    fireEvent.keyDown(list, { key: 'Escape' });
    table['folder:f1'] = level([page('p2', 'Billing model')]);
    await act(async () => held.resolve(json(moved('p2', { kind: 'folder', id: 'f1' }).body)));
    // The tree still re-reads what changed; it does not open the target for a
    // reader who walked away from the picker.
    expect(screen.getByRole('treeitem', { name: 'Specs' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('a move into a folder that is already open keeps it open and re-reads it once', async () => {
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    mount();
    await press(screen.getByRole('treeitem', { name: 'Specs' }));
    table.root = ROOT;
    await choose(await openMenu('Page', 'Billing model'), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders and pages' });
    table['folder:f1'] = level([page('p5', 'Spec one'), page('p2', 'Billing model')]);
    patchAnswers = [moved('p2', { kind: 'folder', id: 'f1' })];
    reads.length = 0;
    await press(within(list).getByRole('option', { name: 'Specs' }));
    expect(reads.filter((r) => r === 'folder:f1:50')).toHaveLength(1);
    expect(screen.getByRole('treeitem', { name: 'Specs' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('a move into a folder the tree never loaded re-reads only what it shows', async () => {
    table.root = ROOT;
    table['folder:f1'] = level([folder('d1', 'Drafts', false)]);
    mount();
    await choose(await openMenu('Page', 'Billing model'), 'Move to…');
    const list = await screen.findByRole('listbox', { name: 'Folders and pages' });
    await press(within(list).getByRole('button', { name: 'Expand Specs' }));
    patchAnswers = [moved('p2', { kind: 'folder', id: 'd1' })];
    reads.length = 0;
    await press(within(list).getByRole('option', { name: 'Drafts' }));
    // The root is re-read (the page left it); Drafts is opened, which reads it.
    expect(reads).toContain('root:50');
    expect(reads).toContain('folder:d1:50');
  });

  it('a Load more still in flight when its level changes in place does not land', async () => {
    const held = deferred<Response>();
    table['root@c1'] = held.promise;
    mount({ initialRoot: level(ROOT.rows, 'c1') });
    await press(screen.getByRole('button', { name: 'Load more' }));
    // The folder is found gone while the read is out: its row leaves in place,
    // retiring the read that was taken before.
    actions.describeFolderDeletion.mockResolvedValueOnce({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
      error: 'gone',
    });
    await choose(await openMenu('Folder', 'Specs'), 'Delete…');
    await act(async () => held.resolve(json(level([folder('f1', 'Specs'), page('p8', 'Later')]))));
    expect(labels()).toEqual(['Runbooks', 'Auth flow', 'Billing model']);
  });

  it('re-rendering with another project key does not repeat the mount reads', async () => {
    table.root = ROOT;
    const view = mount({ initialRoot: undefined });
    await settle();
    expect(reads).toEqual(['root:50']);
    view.rerender(tree({ initialRoot: undefined, projectKey: 'OTHER' }));
    await settle();
    expect(reads).toEqual(['root:50']);
  });
});

describe('usePageMove — a refusal with no JSON body', () => {
  function hook() {
    const refresh = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {children}
      </NextIntlClientProvider>
    );
    return { refresh, ...renderHook(() => usePageMove({ refresh }), { wrapper }) };
  }

  it('a bare 404 is `gone`; a 500 whose body is not JSON is the transport sentence', async () => {
    const { result, refresh } = hook();
    patchAnswers = [
      Promise.resolve(new Response('not json', { status: 404 })),
      Promise.resolve(new Response('null', { status: 500 })),
      { status: 409, body: { code: 'SOMETHING_NEW' } },
    ];
    let outcomes: unknown[] = [];
    await act(async () => {
      outcomes = [
        await result.current.move({ pageId: 'p1', from: 'root', parent: { kind: 'root' } }),
        await result.current.move({ pageId: 'p1', from: 'root', parent: { kind: 'root' } }),
        await result.current.move({ pageId: 'p1', from: 'root', parent: { kind: 'root' } }),
      ];
    });
    expect(outcomes).toEqual([
      {
        ok: false,
        refusal: 'gone',
        message: 'That folder or page no longer exists. The page stayed where it was.',
      },
      { ok: false, refusal: 'failed', message: TRANSPORT },
      { ok: false, refusal: 'failed', message: TRANSPORT },
    ]);
    expect(refresh).not.toHaveBeenCalled();
  });
});
