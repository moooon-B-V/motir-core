// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// IssueTreeTable (Subtask 2.5.14) drives the lazy reads through Server Actions +
// next/navigation for the header-sort URL — stub both so the client orchestration
// (expand → fetch → render, load-more, sort nav) is testable under happy-dom.
const { push, listRootIssuesAction, listChildIssuesAction } = vi.hoisted(() => ({
  push: vi.fn(),
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
}));
vi.mock('@/app/(authed)/issues/actions', () => ({ listRootIssuesAction, listChildIssuesAction }));
// The rows are inline-editable (Subtask 2.5.5), so the cells import the detail
// page's edit Server Actions — stub them so this client test stays DB-free.
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { IssueTreeTable } from '@/app/(authed)/issues/_components/IssueTreeTable';
import type { TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
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
const sort = { column: 'key', direction: 'asc' } as const;
const filter = EMPTY_FILTER;

function node(over: Partial<WorkItemTreeRowDto> & { id: string; key: number }): WorkItemTreeRowDto {
  return {
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Issue ${over.key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasChildren: false,
    ...over,
  };
}

function renderTree(initialLevel: TreeLevelDto) {
  return render(
    <IssueTreeTable
      initialLevel={initialLevel}
      sort={sort}
      filter={filter}
      workflow={workflow}
      members={members}
    />,
  );
}

describe('IssueTreeTable — lazy + sortable', () => {
  // Regression: bug-tree-header-misalignment. The sortable Tree remaps the
  // shared issue columns to wrap each header in a sort button — and must FORWARD
  // each column's fixed `width`. Dropping it made TreeTable fall back to
  // `max-content`, so every independently-gridded row sized to its OWN content
  // and the header row landed on a different column grid than the data rows. The
  // header + every data row must carry the SAME grid template with the fixed px
  // tracks (the verified-real cause; alignment itself is measured in the
  // browser, but happy-dom can still assert the template the rows share).
  it('gives the header and data rows the same fixed-width column grid (not max-content)', () => {
    renderTree({
      rows: [node({ id: 'a', key: 1, hasChildren: true }), node({ id: 'b', key: 2 })],
      hasMore: false,
      total: 2,
    });
    const grid = screen.getByRole('treegrid');
    const headerRow = within(grid)
      .getAllByRole('row')
      .find((r) => within(r).queryAllByRole('columnheader').length > 0)!;
    const dataRow = screen.getByTestId('issue-row-PROD-1');

    const headerTemplate = headerRow.style.gridTemplateColumns;
    const dataTemplate = dataRow.style.gridTemplateColumns;

    // The fixed widths from buildIssueColumns are present — not collapsed to
    // content-sized tracks that drift per row.
    expect(headerTemplate).not.toContain('max-content');
    for (const px of ['120px', '150px', '90px', '130px']) {
      expect(headerTemplate).toContain(px);
    }
    // Header and data share ONE column grid → columns line up under headers.
    expect(dataTemplate).toBe(headerTemplate);
  });

  it('renders roots; a parent has an expand chevron, a leaf does not', () => {
    renderTree({
      rows: [node({ id: 'a', key: 1, hasChildren: true }), node({ id: 'b', key: 2 })],
      hasMore: false,
      total: 2,
    });
    const parent = screen.getByTestId('issue-row-PROD-1');
    const leaf = screen.getByTestId('issue-row-PROD-2');
    expect(within(parent).queryByRole('button', { name: 'Expand row' })).not.toBeNull();
    expect(within(leaf).queryByRole('button', { name: /Expand|Collapse/ })).toBeNull();
    // True sibling total drives aria-setsize.
    expect(parent.getAttribute('aria-setsize')).toBe('2');
  });

  it('lazy-loads a node’s children on expand (loading row → real rows)', async () => {
    listChildIssuesAction.mockResolvedValue({
      ok: true,
      level: { rows: [node({ id: 'a1', key: 9, parentId: 'a' })], hasMore: false, total: 1 },
    });
    renderTree({ rows: [node({ id: 'a', key: 1, hasChildren: true })], hasMore: false, total: 1 });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('issue-row-PROD-1')).getByRole('button', { name: 'Expand row' }),
      );
    });

    expect(listChildIssuesAction).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'a', sortParam: 'key:asc', offset: 0 }),
    );
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy());
  });

  it('shows "Load more children" past the page and appends on activate', async () => {
    listChildIssuesAction
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [node({ id: 'a1', key: 9, parentId: 'a' })], hasMore: true, total: 2 },
      })
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [node({ id: 'a2', key: 10, parentId: 'a' })], hasMore: false, total: 2 },
      });
    renderTree({ rows: [node({ id: 'a', key: 1, hasChildren: true })], hasMore: false, total: 1 });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('issue-row-PROD-1')).getByRole('button', { name: 'Expand row' }),
      );
    });
    const loadMore = await screen.findByText('Load more children');
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy();

    await act(async () => {
      fireEvent.click(loadMore);
    });
    expect(listChildIssuesAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentId: 'a', offset: 1 }),
    );
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-10')).toBeTruthy());
  });

  it('clicking a column header navigates to the new ?sort=', () => {
    renderTree({ rows: [node({ id: 'a', key: 1 })], hasMore: false, total: 1 });
    // Exact name: the inline priority CELL trigger is "Edit Priority" (2.5.5), so
    // the bare "Priority" matches only the sortable column header.
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]?.[0])).toContain('sort=priority');
  });
});
