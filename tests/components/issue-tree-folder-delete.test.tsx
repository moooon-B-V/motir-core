// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// DELETE a folder from the /items tree (Story MOTIR-5308 · MOTIR-5346): Delete…
// counts what would move before it can be confirmed, confirming removes the row
// and re-reads the parent level exactly once, and a refusal stays inside the
// open dialog. Server Actions are stubbed at their boundary; the delete is proven
// on real Postgres in tests/integration/folders/folderDeleteAction.test.ts.
const mocks = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
  listFolderLevelAction: vi.fn(),
  listProjectFoldersAction: vi.fn(),
  moveFolderAction: vi.fn(),
  createFolderAction: vi.fn(),
  renameFolderAction: vi.fn(),
  describeFolderDeletionAction: vi.fn(),
  deleteFolderAction: vi.fn(),
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
  describeFolderDeletionAction: mocks.describeFolderDeletionAction,
  deleteFolderAction: mocks.deleteFolderAction,
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

const rootLevel: TreeLevelDto = {
  rows: [folder('f1', 'Parked', 'a0'), folder('f2', 'Archive', 'a1'), item(1)],
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

/**
 * The body rows' test ids, in order. `hidden: true` because an open alertdialog
 * is modal: it hides the rest of the page from the accessibility tree, which is
 * exactly what it should do — the rows are still there behind it.
 */
function rowIds(): Array<string | null> {
  const grid = screen.getByRole('treegrid', { hidden: true });
  const body = within(grid).getAllByRole('rowgroup', { hidden: true })[1]!;
  return within(body)
    .getAllByRole('row', { hidden: true })
    .map((r) => r.getAttribute('data-testid'));
}

async function chooseDelete(folderName: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Folder actions for ${folderName}` }));
  });
  const menu = await screen.findByRole('menu', { name: `Folder actions for ${folderName}` });
  const entry = within(menu).getByRole('menuitem', { name: 'Delete…' });
  await act(async () => {
    fireEvent.click(entry);
  });
}

const counted = {
  ok: true,
  preview: {
    folderId: 'f1',
    name: 'Parked',
    childFolderCount: 1,
    workItemCount: 2,
    destination: { folderId: null, name: null },
  },
};

describe('IssueTreeTable — delete a folder', () => {
  it('counts before it can be confirmed, then removes the row and re-reads the parent level exactly once', async () => {
    let resolveCount: (value: unknown) => void = () => {};
    mocks.describeFolderDeletionAction.mockImplementation(
      () => new Promise((resolve) => (resolveCount = resolve)),
    );
    mocks.deleteFolderAction.mockResolvedValue({
      ok: true,
      result: {
        deletedFolderId: 'f1',
        destinationFolderId: null,
        movedFolderIds: ['f3'],
        movedWorkItemIds: ['w8', 'w9'],
      },
    });
    mocks.listRootIssuesAction.mockResolvedValue({
      ok: true,
      level: {
        rows: [
          folder('f2', 'Archive', 'a1'),
          folder('f3', 'Moved up', 'a2'),
          item(1),
          item(8),
          item(9),
        ],
        hasMore: false,
        total: 5,
      },
    });
    renderTree();

    await chooseDelete('Parked');
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete folder' });
    expect(within(dialog).getByText('Counting what moves…')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      resolveCount(counted);
    });
    expect(within(dialog).getByTestId('folder-delete-moves').textContent).toBe(
      '1 folder and 2 work items will move to Project root. No work items are deleted.',
    );
    expect(mocks.describeFolderDeletionAction).toHaveBeenCalledWith({ folderId: 'f1' });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    });

    expect(mocks.deleteFolderAction).toHaveBeenCalledWith({ folderId: 'f1' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(rowIds()).toEqual([
        'folder-row-f2',
        'folder-row-f3',
        'issue-row-PROD-1',
        'issue-row-PROD-8',
        'issue-row-PROD-9',
      ]),
    );
    expect(mocks.listRootIssuesAction).toHaveBeenCalledTimes(1);
  });

  it('a SUBTASK_NEEDS_PLACEMENT refusal stays inside the open dialog and re-reads nothing', async () => {
    mocks.describeFolderDeletionAction.mockResolvedValue(counted);
    mocks.deleteFolderAction.mockResolvedValue({
      ok: false,
      code: 'SUBTASK_NEEDS_PLACEMENT',
      error: 'subtasks',
    });
    renderTree();

    await chooseDelete('Parked');
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Delete folder' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    });

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'A subtask filed here would be left at the project root',
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(rowIds()[0]).toBe('folder-row-f1');
    expect(mocks.listRootIssuesAction).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('a FOLDER_NAME_TAKEN refusal names the child folder that clashes', async () => {
    mocks.describeFolderDeletionAction.mockResolvedValue(counted);
    mocks.deleteFolderAction.mockResolvedValue({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      error: 'taken',
      folderName: 'Q1',
    });
    renderTree();

    await chooseDelete('Parked');
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Delete folder' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    });

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A folder named “Q1” is already where these would move. Rename or move it first.',
    );
  });

  it('Cancel closes the dialog without deleting', async () => {
    mocks.describeFolderDeletionAction.mockResolvedValue(counted);
    renderTree();

    await chooseDelete('Parked');
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.deleteFolderAction).not.toHaveBeenCalled();
    expect(rowIds()[0]).toBe('folder-row-f1');
  });
});
