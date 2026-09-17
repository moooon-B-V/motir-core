// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// FOLDER ROWS in the lazy /items tree (Story MOTIR-5308 · MOTIR-5315): a folder
// renders ahead of the work items with empty work-item cells, its whole row
// expands and collapses (never a quick view), its level lazy-loads ONCE through
// `listFolderLevelAction`, an empty folder shows one quiet row, and a long folder
// pages with the shipped "Load more children". The level reads are stubbed at the
// Server Action boundary, as in issue-tree-lazy.test.tsx.
const { listRootIssuesAction, listChildIssuesAction, listFolderLevelAction, onPeek } = vi.hoisted(
  () => ({
    listRootIssuesAction: vi.fn(),
    listChildIssuesAction: vi.fn(),
    listFolderLevelAction: vi.fn(),
    onPeek: vi.fn(),
  }),
);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listRootIssuesAction,
  listChildIssuesAction,
  listFolderLevelAction,
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
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
  usePeekRowClick: () => onPeek,
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

function item(key: number, over: Partial<WorkItemTreeRowDto> = {}): WorkItemTreeRowDto {
  return {
    id: `w${key}`,
    key,
    parentId: null,
    kind: 'task',
    type: null,
    identifier: `PROD-${key}`,
    title: `Issue ${key}`,
    status: 'todo',
    ciState: null,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    hasChildren: false,
    ...over,
  };
}

function folder(id: string, name: string, over: Partial<FolderTreeRowDto> = {}): FolderTreeRowDto {
  return {
    kind: 'folder',
    id,
    parentId: null,
    parentFolderId: null,
    name,
    position: 'a0',
    hasChildren: true,
    ...over,
  };
}

function renderTree(initialLevel: TreeLevelDto) {
  return render(
    <IssueTreeTable
      initialLevel={initialLevel}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      workflow={workflow}
      members={members}
    />,
  );
}

const rootLevel: TreeLevelDto = {
  rows: [folder('f1', 'Later'), folder('f2', 'Archive'), item(1), item(2), item(3)],
  hasMore: false,
  total: 5,
};

describe('IssueTreeTable — folder rows', () => {
  it('renders folders first, with a glyph and name and empty work-item cells', () => {
    renderTree(rootLevel);
    const grid = screen.getByRole('treegrid');
    const body = within(grid).getAllByRole('rowgroup')[1]!;
    const rows = within(body).getAllByRole('row');

    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'folder-row-f1',
      'folder-row-f2',
      'issue-row-PROD-1',
      'issue-row-PROD-2',
      'issue-row-PROD-3',
    ]);
    const later = rows[0]!;
    expect(later.textContent).toBe('Later');
    expect(later.getAttribute('aria-expanded')).toBe('false');
    expect(later.getAttribute('aria-setsize')).toBe('5');
    // Only the tree cell carries content: the seven work-item cells are empty.
    const cells = within(later).getAllByRole('gridcell');
    expect(cells.slice(1).every((c) => c.textContent === '')).toBe(true);
    expect(within(later).queryByRole('link')).toBeNull();
  });

  it('clicking a folder row loads its level once, renders the contents beneath it, and never opens a quick view', async () => {
    listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: {
        rows: [folder('f3', '2025', { parentFolderId: 'f1', hasChildren: false }), item(9)],
        hasMore: false,
        total: 2,
      },
    });
    renderTree(rootLevel);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand folder Later' }));
    });

    expect(listFolderLevelAction).toHaveBeenCalledTimes(1);
    expect(listFolderLevelAction).toHaveBeenCalledWith({
      folderId: 'f1',
      sortParam: 'key:asc',
      offset: 0,
    });
    expect(listChildIssuesAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy());
    expect(screen.getByTestId('folder-row-f1').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('folder-row-f3').getAttribute('aria-level')).toBe('2');
    expect(screen.getByTestId('issue-row-PROD-9').getAttribute('aria-level')).toBe('2');
    expect(onPeek).not.toHaveBeenCalled();

    // Collapse and re-expand reuses the loaded level: no second read.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse folder Later' }));
    });
    expect(screen.queryByTestId('issue-row-PROD-9')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand folder Later' }));
    });
    expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy();
    expect(listFolderLevelAction).toHaveBeenCalledTimes(1);
  });

  it('Enter on a focused folder row toggles it', async () => {
    listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: { rows: [item(9)], hasMore: false, total: 1 },
    });
    renderTree(rootLevel);

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('folder-row-f1'), { key: 'Enter' });
    });

    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy());
    expect(listFolderLevelAction).toHaveBeenCalledTimes(1);
  });

  it('an expanded empty folder shows one quiet row', async () => {
    listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: { rows: [], hasMore: false, total: 0 },
    });
    renderTree({
      rows: [folder('f1', 'Spikes', { hasChildren: false })],
      hasMore: false,
      total: 1,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand folder Spikes' }));
    });

    const empty = await screen.findByText('Nothing is filed here yet.');
    expect(empty.closest('[role="row"]')?.getAttribute('aria-level')).toBe('2');
  });

  it('a folder longer than one page shows "Load more children" and appends the next page', async () => {
    listFolderLevelAction
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [item(9)], hasMore: true, total: 2 },
      })
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [item(10)], hasMore: false, total: 2 },
      });
    renderTree(rootLevel);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand folder Later' }));
    });
    const loadMore = await screen.findByText('Load more children');
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy();

    await act(async () => {
      fireEvent.click(loadMore);
    });

    expect(listFolderLevelAction).toHaveBeenLastCalledWith({
      folderId: 'f1',
      sortParam: 'key:asc',
      offset: 1,
    });
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-10')).toBeTruthy());
    expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy();
  });
});
