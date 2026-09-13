// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// A PLACEMENT change reported to the /items tree (Story MOTIR-5308 · MOTIR-5353):
// something else on the page — the quick view's Folder field — reports where a
// work item now sits through `FolderCommandsProvider`, and the tree moves that
// row in place across whichever levels are loaded, with no level re-read. The
// level reads are stubbed at the Server Action boundary; the report goes through
// the provider exactly as a caller's would.
const mocks = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
  listFolderLevelAction: vi.fn(),
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

import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import {
  FolderCommandsProvider,
  useFolderCommands,
  type WorkItemPlacement,
} from '@/app/(authed)/items/_components/FolderCommands';
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

function folder(id: string, name: string, position = 'a0'): FolderTreeRowDto {
  return {
    kind: 'folder',
    id,
    parentId: null,
    parentFolderId: null,
    name,
    position,
    hasChildren: false,
  };
}

const level = (rows: TreeLevelDto['rows'], hasMore = false): TreeLevelDto => ({
  rows,
  hasMore,
  total: rows.length,
});

/** Mount the tree inside the provider, and hand back the channel a caller would use. */
function renderTree(initialLevel: TreeLevelDto) {
  let report: (p: WorkItemPlacement) => void = () => {
    throw new Error('channel not captured');
  };
  function Caller() {
    const commands = useFolderCommands();
    report = (p) => commands!.reportWorkItemPlacement(p);
    return null;
  }
  render(
    <FolderCommandsProvider>
      <Caller />
      <IssueTreeTable
        initialLevel={initialLevel}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        workflow={workflow}
        members={members}
        canEdit
      />
    </FolderCommandsProvider>,
  );
  return {
    report: (p: WorkItemPlacement) =>
      act(async () => {
        report(p);
      }),
  };
}

async function expand(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function expandWorkItem(identifier: string) {
  await act(async () => {
    fireEvent.click(
      within(screen.getByTestId(`issue-row-${identifier}`)).getByRole('button', {
        name: 'Expand row',
      }),
    );
  });
}

const readCalls = () =>
  mocks.listRootIssuesAction.mock.calls.length +
  mocks.listChildIssuesAction.mock.calls.length +
  mocks.listFolderLevelAction.mock.calls.length;

describe('IssueTreeTable — a reported placement change', () => {
  it('a root work item reported into a loaded, empty folder leaves the root and appears in it', async () => {
    mocks.listFolderLevelAction.mockResolvedValue({ ok: true, level: level([]) });
    const { report } = renderTree(level([folder('f1', 'Later'), item(1), item(2)]));
    await expand('Expand folder Later');
    await screen.findByText('Nothing is filed here yet.');
    const reads = readCalls();

    await report({ workItemId: 'w1', folderId: 'f1', parentId: null });

    const moved = await screen.findByTestId('issue-row-PROD-1');
    expect(moved.getAttribute('aria-level')).toBe('2');
    expect(screen.queryByText('Nothing is filed here yet.')).toBeNull();
    expect(screen.getByTestId('issue-row-PROD-2').getAttribute('aria-level')).toBe('1');
    expect(readCalls()).toBe(reads);
  });

  it('a story leaving an expanded epic lands under the folder and turns the epic’s chevron off', async () => {
    mocks.listChildIssuesAction.mockResolvedValue({
      ok: true,
      level: level([item(20, { kind: 'story', parentId: 'w10' })]),
    });
    mocks.listFolderLevelAction.mockResolvedValue({ ok: true, level: level([]) });
    const { report } = renderTree(
      level([folder('f1', 'Later'), item(10, { kind: 'epic', hasChildren: true })]),
    );
    await expandWorkItem('PROD-10');
    await screen.findByTestId('issue-row-PROD-20');
    await expand('Expand folder Later');
    await screen.findByText('Nothing is filed here yet.');
    const reads = readCalls();

    await report({ workItemId: 'w20', folderId: 'f1', parentId: null });

    const story = screen.getByTestId('issue-row-PROD-20');
    expect(story.getAttribute('aria-level')).toBe('2');
    const rowIds = screen.getAllByRole('row').map((r) => r.getAttribute('data-testid'));
    expect(rowIds.indexOf('issue-row-PROD-20')).toBe(rowIds.indexOf('folder-row-f1') + 1);
    const epic = screen.getByTestId('issue-row-PROD-10');
    expect(within(epic).queryByRole('button', { name: /Expand row|Collapse row/ })).toBeNull();
    expect(readCalls()).toBe(reads);
  });

  it('an expanded epic reported into a folder keeps its loaded stories beneath it', async () => {
    mocks.listChildIssuesAction.mockResolvedValue({
      ok: true,
      level: level([item(20, { kind: 'story', parentId: 'w10' })]),
    });
    mocks.listFolderLevelAction.mockResolvedValue({ ok: true, level: level([]) });
    const { report } = renderTree(
      level([folder('f1', 'Later'), item(10, { kind: 'epic', hasChildren: true })]),
    );
    await expand('Expand folder Later');
    await expandWorkItem('PROD-10');
    await screen.findByTestId('issue-row-PROD-20');

    await report({ workItemId: 'w10', folderId: 'f1', parentId: null });

    await waitFor(() =>
      expect(screen.getByTestId('issue-row-PROD-10').getAttribute('aria-level')).toBe('2'),
    );
    expect(screen.getByTestId('issue-row-PROD-20').getAttribute('aria-level')).toBe('3');
  });

  it('a report into a folder whose level is not loaded removes the row and inserts nothing', async () => {
    const { report } = renderTree(level([folder('f1', 'Later'), item(1)]));

    await report({ workItemId: 'w1', folderId: 'f1', parentId: null });

    expect(screen.queryByTestId('issue-row-PROD-1')).toBeNull();
    expect(screen.getByTestId('folder-row-f1')).toBeTruthy();
    expect(readCalls()).toBe(0);
  });

  it('a report back to the root moves a filed row out of its folder', async () => {
    mocks.listFolderLevelAction.mockResolvedValue({
      ok: true,
      level: level([item(5)]),
    });
    const { report } = renderTree(level([folder('f1', 'Later'), item(1)]));
    await expand('Expand folder Later');
    await screen.findByTestId('issue-row-PROD-5');
    const reads = readCalls();

    await report({ workItemId: 'w5', folderId: null, parentId: null });

    expect(screen.getByTestId('issue-row-PROD-5').getAttribute('aria-level')).toBe('1');
    expect(await screen.findByText('Nothing is filed here yet.')).toBeTruthy();
    expect(readCalls()).toBe(reads);
  });

  it('a report with no tree registered does nothing and throws nothing', () => {
    let commands: ReturnType<typeof useFolderCommands> = null;
    function Caller() {
      commands = useFolderCommands();
      return null;
    }
    rtlRender(
      <FolderCommandsProvider>
        <Caller />
      </FolderCommandsProvider>,
    );

    expect(() =>
      commands!.reportWorkItemPlacement({ workItemId: 'w1', folderId: 'f1', parentId: null }),
    ).not.toThrow();
  });
});
