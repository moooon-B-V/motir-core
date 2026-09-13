// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// MOVE and REORDER folders in the /items tree (Story MOTIR-5308 · MOTIR-5345):
// Move to… opens the picker anchored to the row, a pick moves the row out of its
// level and into a loaded destination IN PLACE, Move up / Move down swap rows in
// place, and a refusal renders at the top of the still-open picker. Server
// Actions are stubbed at their boundary; the service is proven on real Postgres
// in tests/integration/folders/folderMoveAction.test.ts.
const mocks = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
  listFolderLevelAction: vi.fn(),
  listProjectFoldersAction: vi.fn(),
  moveFolderAction: vi.fn(),
  createFolderAction: vi.fn(),
  renameFolderAction: vi.fn(),
  toast: vi.fn(),
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
  listProjectFoldersAction: mocks.listProjectFoldersAction,
  moveFolderAction: mocks.moveFolderAction,
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

import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import type { FolderDto } from '@/lib/dto/folders';
import type { FolderTreeRowDto, TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

function folder(id: string, name: string, position: string): FolderTreeRowDto {
  return {
    kind: 'folder',
    id,
    parentId: null,
    parentFolderId: null,
    name,
    position,
    hasChildren: true,
  };
}

function folderDto(
  id: string,
  name: string,
  parentFolderId: string | null,
  position: string,
): FolderDto {
  return {
    id,
    projectId: 'p1',
    parentFolderId,
    name,
    position,
    createdById: 'u1',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
}

const rootLevel: TreeLevelDto = {
  rows: [folder('f1', 'Later', 'a0'), folder('f2', 'Archive', 'a1'), item(1)],
  hasMore: false,
  total: 3,
};

function renderTree() {
  return render(
    <IssueTreeTable
      initialLevel={rootLevel}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      workflow={workflow}
      members={members}
      canEdit
    />,
  );
}

function rowIds(): Array<string | null> {
  const body = within(screen.getByRole('treegrid')).getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'));
}

async function chooseFromMenu(folderName: string, entry: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Folder actions for ${folderName}` }));
  });
  const menu = await screen.findByRole('menu', { name: `Folder actions for ${folderName}` });
  const item = within(menu).getByRole('menuitem', { name: entry });
  await act(async () => {
    fireEvent.click(item);
  });
}

const pickerFolders = {
  ok: true,
  data: {
    folders: [
      { id: 'f1', parentFolderId: null, name: 'Later', position: 'a0', path: ['Later'] },
      { id: 'f2', parentFolderId: null, name: 'Archive', position: 'a1', path: ['Archive'] },
    ],
    truncated: false,
  },
};

describe('IssueTreeTable — move and reorder folders', () => {
  it('Move to… moves the row out of its level and into the loaded destination, with no level re-read', async () => {
    mocks.listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: { rows: [], hasMore: false, total: 0 },
    });
    mocks.listProjectFoldersAction.mockResolvedValue(pickerFolders);
    mocks.moveFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f1', 'Later', 'f2', 'a0'),
    });
    renderTree();

    // Load the destination level first, so the moved row has somewhere to appear.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand folder Archive' }));
    });
    await screen.findByText('Nothing is filed here yet.');

    await chooseFromMenu('Later', 'Move to…');
    const listbox = await screen.findByRole('listbox', { name: 'Folders' });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Project rootCurrent location', 'LaterCan’t move a folder into itself.', 'Archive']);

    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Archive' }));
    });

    expect(mocks.moveFolderAction).toHaveBeenCalledWith({
      folderId: 'f1',
      targetParentFolderId: 'f2',
    });
    await waitFor(() =>
      expect(rowIds()).toEqual(['folder-row-f2', 'folder-row-f1', 'issue-row-PROD-1']),
    );
    expect(screen.getByTestId('folder-row-f1').getAttribute('aria-level')).toBe('2');
    expect(screen.queryByText('Nothing is filed here yet.')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(mocks.listFolderLevelAction).toHaveBeenCalledTimes(1);
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
  });

  it('Move up swaps two rows in place, and Move up is disabled on the first folder', async () => {
    mocks.moveFolderAction.mockResolvedValue({
      ok: true,
      folder: folderDto('f2', 'Archive', null, 'Zz'),
    });
    renderTree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Folder actions for Later' }));
    });
    const laterMenu = await screen.findByRole('menu', { name: 'Folder actions for Later' });
    expect(
      within(laterMenu).getByRole('menuitem', { name: 'Move up' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      within(laterMenu).getByRole('menuitem', { name: 'Move down' }).hasAttribute('disabled'),
    ).toBe(false);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await chooseFromMenu('Archive', 'Move up');

    expect(mocks.moveFolderAction).toHaveBeenCalledWith({
      folderId: 'f2',
      targetParentFolderId: null,
      beforeId: null,
      afterId: 'f1',
    });
    await waitFor(() =>
      expect(rowIds()).toEqual(['folder-row-f2', 'folder-row-f1', 'issue-row-PROD-1']),
    );
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
  });

  it('a cycle refusal shows the banner at the top of the still-open picker and re-reads the list', async () => {
    mocks.listProjectFoldersAction.mockResolvedValue(pickerFolders);
    mocks.moveFolderAction.mockResolvedValue({
      ok: false,
      code: 'FOLDER_CYCLE',
      error: 'cycle',
    });
    renderTree();

    await chooseFromMenu('Later', 'Move to…');
    const listbox = await screen.findByRole('listbox', { name: 'Folders' });
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Archive' }));
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A folder can’t move into one of its own folders.');
    await screen.findByRole('listbox', { name: 'Folders' });
    expect(mocks.listProjectFoldersAction).toHaveBeenCalledTimes(2);
    expect(rowIds()).toEqual(['folder-row-f1', 'folder-row-f2', 'issue-row-PROD-1']);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
