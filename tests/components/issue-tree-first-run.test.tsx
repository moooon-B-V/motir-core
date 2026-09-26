// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The /items FIRST RUN (Story MOTIR-4927 · MOTIR-5541): the unfiltered Tree shows
// its empty state when the ROOT holds no work items, whatever folders it holds —
// decided by the level read's `workItemTotal`, never by counting the rows drawn
// (design/work-items/design-notes.md § `/items` first run). Every new project is
// born with a Bugs folder, so this is the state every project opens in. The read
// itself is proven on real Postgres in tests/integration/folders/folderTreeRead.test.ts.
const mocks = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
  listFolderLevelAction: vi.fn(),
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
  usePeekRowClick: () => vi.fn(),
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => mocks.canEdit.current }),
}));

import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import { FolderCommandsProvider } from '@/app/(authed)/items/_components/FolderCommands';
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
  { userId: 'u1', name: 'Ada', email: 'ada@x.com', workspaceRole: 'manager', customRole: null },
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
    hasChildren: false,
  };
}

/** The section's drawn empty state, stood in for by its heading. */
const emptyState = <h2>No work items yet</h2>;

function renderTree(level: TreeLevelDto, { canEdit = true }: { canEdit?: boolean } = {}) {
  mocks.canEdit.current = canEdit;
  return render(
    <FolderCommandsProvider>
      <IssueTreeTable
        initialLevel={level}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        workflow={workflow}
        members={members}
        canEdit={canEdit}
        emptyState={emptyState}
      />
    </FolderCommandsProvider>,
  );
}

const onlyFolders: TreeLevelDto = {
  rows: [folder('f1', 'Bugs'), folder('f2', 'Later')],
  hasMore: false,
  total: 2,
  workItemTotal: 0,
};

describe('IssueTreeTable — the first run', () => {
  it('a root holding only folders draws the folder rows, with the empty state BELOW them, for an editor', () => {
    renderTree(onlyFolders);

    const grid = screen.getByRole('treegrid');
    expect(within(grid).getByTestId('folder-row-f1')).toBeTruthy();
    expect(within(grid).getByTestId('folder-row-f2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Folder actions for Bugs' })).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'No work items yet' });
    expect(grid.contains(heading)).toBe(false);
    expect(grid.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the same for a member without work_item:edit, with no folder actions', () => {
    renderTree(onlyFolders, { canEdit: false });

    const grid = screen.getByRole('treegrid');
    expect(within(grid).getByTestId('folder-row-f1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Folder actions for Bugs' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'No work items yet' })).toBeTruthy();
  });

  it('a root with at least one work item draws the tree and no empty state', () => {
    renderTree({
      rows: [folder('f1', 'Bugs'), item(1)],
      hasMore: false,
      total: 2,
      workItemTotal: 1,
    });

    expect(screen.getByTestId('issue-row-PROD-1')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No work items yet' })).toBeNull();
  });

  it('the rule reads the COUNT, not the rows: a first page of folders over a root that holds work items shows no empty state', () => {
    renderTree({ rows: [folder('f1', 'Bugs')], hasMore: true, total: 60, workItemTotal: 59 });

    expect(screen.getByTestId('folder-row-f1')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No work items yet' })).toBeNull();
  });

  it('a root with nothing at all draws only the empty state', () => {
    renderTree({ rows: [], hasMore: false, total: 0, workItemTotal: 0 });

    expect(screen.queryByRole('treegrid')).toBeNull();
    expect(screen.getByRole('heading', { name: 'No work items yet' })).toBeTruthy();
  });
});
