// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// CREATE and RENAME folders in the /items tree (Story MOTIR-5308 · MOTIR-5344):
// the toolbar's "New folder" (through the command channel), the folder row's
// actions menu, the inline name row, the collision refusal, and the tree level
// updating IN PLACE with no re-read. The Server Actions are stubbed at their
// boundary; `foldersService` is proven on real Postgres in
// tests/integration/folders/folderWriteActions.test.ts.
const mocks = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
  listFolderLevelAction: vi.fn(),
  createFolderAction: vi.fn(),
  renameFolderAction: vi.fn(),
  toast: vi.fn(),
  canEdit: { current: true },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listRootIssuesAction: mocks.listRootIssuesAction,
  listChildIssuesAction: mocks.listChildIssuesAction,
  listFolderLevelAction: mocks.listFolderLevelAction,
  createFolderAction: mocks.createFolderAction,
  renameFolderAction: mocks.renameFolderAction,
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: () => {},
    openCreateIssue: () => {},
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));
vi.mock('@/app/(authed)/items/_components/IssueQuickView', () => ({
  usePeekRowClick: () => vi.fn(),
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => mocks.canEdit.current }),
}));

import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import {
  FolderCommandsProvider,
  NewFolderButton,
} from '@/app/(authed)/items/_components/FolderCommands';
import type { FolderDto } from '@/lib/dto/folders';
import type { FolderTreeRowDto, TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.canEdit.current = true;
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u1', name: 'Ada', email: 'ada@x.com', role: 'admin' },
];
const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
  ],
  transitions: [],
  policyMode: 'restricted',
};

function item(key: number): WorkItemTreeRowDto {
  return {
    id: `w${key}`,
    key,
    parentId: null,
    kind: 'task',
    type: null,
    identifier: `PROD-${key}`,
    title: `Issue ${key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    hasChildren: false,
  };
}

function folder(id: string, name: string): FolderTreeRowDto {
  return {
    kind: 'folder',
    id,
    parentId: null,
    parentFolderId: null,
    name,
    position: 'a0',
    hasChildren: true,
  };
}

function folderDto(id: string, name: string, parentFolderId: string | null): FolderDto {
  return {
    id,
    projectId: 'p1',
    parentFolderId,
    name,
    position: 'a9',
    createdById: 'u1',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
}

const rootLevel: TreeLevelDto = {
  rows: [folder('f1', 'Later'), folder('f2', 'Archive'), item(1), item(2)],
  hasMore: false,
  total: 4,
};

function renderTree({
  canEdit = true,
  level = rootLevel,
}: { canEdit?: boolean; level?: TreeLevelDto } = {}) {
  mocks.canEdit.current = canEdit;
  return render(
    <FolderCommandsProvider>
      <NewFolderButton />
      <IssueTreeTable
        initialLevel={level}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        workflow={workflow}
        members={members}
        canEdit={canEdit}
      />
    </FolderCommandsProvider>,
  );
}

/** The body rows' test ids, in order. */
function rowIds(): Array<string | null> {
  const body = within(screen.getByRole('treegrid')).getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'));
}

async function openMenu(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Folder actions for ${name}` }));
  });
  return screen.findByRole('menu', { name: `Folder actions for ${name}` });
}

describe('IssueTreeTable — create and rename folders', () => {
  it('New folder opens a name row after the last root folder; Enter creates it in place with no re-read', async () => {
    mocks.createFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f9', 'Parked', null),
    });
    renderTree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    });
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    expect(rowIds()).toEqual([
      'folder-row-f1',
      'folder-row-f2',
      'folder-draft-row',
      'issue-row-PROD-1',
      'issue-row-PROD-2',
    ]);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '  Parked ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(mocks.createFolderAction).toHaveBeenCalledWith({ parentFolderId: null, name: 'Parked' });
    await waitFor(() =>
      expect(rowIds()).toEqual([
        'folder-row-f1',
        'folder-row-f2',
        'folder-row-f9',
        'issue-row-PROD-1',
        'issue-row-PROD-2',
      ]),
    );
    expect(screen.getByTestId('folder-row-f9').textContent).toContain('Parked');
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
    expect(mocks.listFolderLevelAction).not.toHaveBeenCalled();
  });

  it('at a root with epics and no folder, New folder opens and lands after the epics and before the other work items', async () => {
    // The project root reads its epics, then its folders, then the rest (MOTIR-5550).
    mocks.createFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f9', 'Parked', null),
    });
    renderTree({
      level: {
        rows: [{ ...item(1), kind: 'epic' }, { ...item(2), kind: 'epic' }, item(3)],
        hasMore: false,
        total: 3,
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    });
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    expect(rowIds()).toEqual([
      'issue-row-PROD-1',
      'issue-row-PROD-2',
      'folder-draft-row',
      'issue-row-PROD-3',
    ]);

    fireEvent.change(input, { target: { value: 'Parked' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() =>
      expect(rowIds()).toEqual([
        'issue-row-PROD-1',
        'issue-row-PROD-2',
        'folder-row-f9',
        'issue-row-PROD-3',
      ]),
    );
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
  });

  it('the folder menu is keyboard-operable and lists its entries in the design order', async () => {
    renderTree();
    const menu = await openMenu('Later');

    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'New folder inside',
      'Rename',
      'Move to…',
      'Move up',
      'Move down',
      'Delete…',
    ]);
    // Opening focuses the first entry; the arrow keys move between ENABLED
    // entries ("Later" is the first folder, so Move up is skipped) and wrap.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[5]);

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('New folder inside expands the folder and creates inside it, before its work items', async () => {
    mocks.listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: { rows: [item(9)], hasMore: false, total: 1 },
    });
    mocks.createFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f7', '2026', 'f1'),
    });
    renderTree();

    const menu = await openMenu('Later');
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'New folder inside' }));
    });

    expect(mocks.listFolderLevelAction).toHaveBeenCalledTimes(1);
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    expect(screen.getByTestId('folder-draft-row').getAttribute('aria-level')).toBe('2');
    fireEvent.change(input, { target: { value: '2026' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(mocks.createFolderAction).toHaveBeenCalledWith({ parentFolderId: 'f1', name: '2026' });
    await waitFor(() => expect(screen.getByTestId('folder-row-f7')).toBeTruthy());
    const ids = rowIds();
    expect(ids.indexOf('folder-row-f7')).toBe(ids.indexOf('folder-row-f1') + 1);
    expect(ids.indexOf('issue-row-PROD-9')).toBe(ids.indexOf('folder-row-f7') + 1);
    expect(screen.getByTestId('folder-row-f7').getAttribute('aria-level')).toBe('2');
    expect(mocks.listFolderLevelAction).toHaveBeenCalledTimes(1);
  });

  it('Rename turns the name into a prefilled input and updates the row in place', async () => {
    mocks.renameFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f1', 'Parked', null),
    });
    renderTree();

    const menu = await openMenu('Later');
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    });
    const input = (await screen.findByRole('textbox', { name: 'Folder name' })) as HTMLInputElement;
    expect(input.value).toBe('Later');
    expect(screen.getByTestId('folder-row-f1').contains(input)).toBe(true);

    fireEvent.change(input, { target: { value: 'Parked' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(mocks.renameFolderAction).toHaveBeenCalledWith({ folderId: 'f1', name: 'Parked' });
    await waitFor(() => expect(screen.getByTestId('folder-row-f1').textContent).toBe('Parked'));
    expect(rowIds()[0]).toBe('folder-row-f1');
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
  });

  it('a FOLDER_NAME_TAKEN result keeps the input open, aria-invalid, with the reason', async () => {
    mocks.createFolderAction.mockResolvedValue({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      error: 'taken',
    });
    renderTree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    });
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'archive' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A folder named “archive” is already here.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(screen.getByTestId('folder-draft-row')).toBeTruthy();
    expect(mocks.toast).not.toHaveBeenCalled();

    // Typing again clears the stale reason.
    fireEvent.change(input, { target: { value: 'archive two' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('an empty name is refused without a call, and Escape cancels with no call', async () => {
    renderTree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    });
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name.');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
    expect(screen.queryByTestId('folder-draft-row')).toBeNull();
    expect(mocks.createFolderAction).not.toHaveBeenCalled();
  });

  it('any other refusal uses the error toast', async () => {
    mocks.renameFolderAction.mockResolvedValue({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
      error: 'That folder no longer exists.',
    });
    renderTree();

    const menu = await openMenu('Archive');
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    });
    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'Old' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        variant: 'error',
        title: 'That folder no longer exists.',
      }),
    );
  });

  it('a viewer without work_item:edit sees no New folder button and no row actions button', () => {
    renderTree({ canEdit: false });

    expect(screen.getByTestId('folder-row-f1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Folder actions for/ })).toBeNull();
  });
});
