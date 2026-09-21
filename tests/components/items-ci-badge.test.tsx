// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

// MOTIR-5474 — the CI badge renders IDENTICALLY in the List and the Tree.
//
// The two views share ONE column builder (`buildIssueColumns`), which is exactly
// why this is worth asserting rather than assuming: the shared builder is the
// mechanism that keeps them the same, and a change that rendered the badge in one
// view's own cell instead would pass every other test in the suite.
//
// It also pins the ROW form, which the design's width budget forces: a row carries
// the GLYPH with the shipped string as its accessible name, never the labelled
// pill the board card gets. At the row's 1204px minimum the title track is only
// its 160px floor, and a labelled pill there overlapped the item key.

// The tree subscribes to `CreateIssueProvider`'s tick to refetch roots after a
// create. The real provider mounts the create modal (Server Actions + blob
// upload), which has no place in a client unit test — mocked exactly as the other
// tree component tests mock it.
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

const WORKFLOW: WorkflowDto = {
  policyMode: 'open',
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
    {
      id: 's2',
      projectId: 'p1',
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
};

function listRow(ciState: string | null): IssueRowData {
  return {
    id: 'wi_1',
    identifier: 'PROD-1',
    title: 'A change',
    kind: 'task',
    type: null,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    ciState,
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    priority: 'medium',
    reporterName: 'Owner',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    storyPoints: null,
    estimateLabel: null,
    storyPointsLabel: null,
    hasChildren: false,
    pendingDecision: null,
    pendingRoutedToName: null,
  };
}

function treeNode(ciState: string | null): WorkItemTreeNodeDto {
  return {
    id: 'wi_1',
    parentId: null,
    kind: 'task',
    type: null,
    key: 1,
    identifier: 'PROD-1',
    title: 'A change',
    status: 'todo',
    ciState,
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    hasChildren: false,
  } as WorkItemTreeNodeDto;
}

/** The badge as a ROW renders it: a labelled `role="img"`, no visible text. */
function badgeIn(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-ci-state]');
}

describe('the CI badge renders the same in the List and the Tree (MOTIR-5474)', () => {
  it('finds ONE identical failing badge through each table', () => {
    const { container: listContainer } = render(
      <IssueListTable
        rows={[listRow('failing')]}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: 1, page: 1, pageSize: 50 }}
      />,
    );
    const fromList = badgeIn(listContainer);
    expect(fromList).toBeTruthy();
    cleanup();

    const { container: treeContainer } = render(
      <IssueTreeTable
        initialLevel={{ rows: [treeNode('failing')], hasMore: false, total: 1 }}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        workflow={WORKFLOW}
        members={[]}
      />,
    );
    const fromTree = badgeIn(treeContainer);
    expect(fromTree).toBeTruthy();

    // The SAME badge: same state, same accessible name, same element shape.
    expect(fromTree!.getAttribute('data-ci-state')).toBe(fromList!.getAttribute('data-ci-state'));
    expect(fromTree!.getAttribute('aria-label')).toBe(fromList!.getAttribute('aria-label'));
    expect(fromTree!.getAttribute('role')).toBe(fromList!.getAttribute('role'));
  });

  it('is the GLYPH form on a row — an accessible name, no visible label', () => {
    // The row form is what the width budget forces. The string still has to reach
    // assistive tech, which is what makes the glyph legitimate rather than colour
    // alone: `role="img"` plus the shipped `github.development.ciState.*` copy.
    const { container } = render(
      <IssueListTable
        rows={[listRow('running')]}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: 1, page: 1, pageSize: 50 }}
      />,
    );
    const badge = badgeIn(container)!;
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Checks running');
    expect(badge.querySelector('svg')).toBeTruthy();
    // No visible text — the pill's label would not fit the title track.
    expect(screen.queryByText('Checks running')).toBeNull();
    // `shrink-0` is what makes the TITLE truncate instead of the badge overlapping
    // the item key.
    expect(badge.className).toContain('shrink-0');
  });

  it('draws nothing for passing, for null, or on a done-category row', () => {
    for (const row of [
      listRow('passing'),
      listRow(null),
      {
        ...listRow('failing'),
        status: 'done',
        statusLabel: 'Done',
        statusCategory: 'done' as const,
      },
    ]) {
      const { container } = render(
        <IssueListTable
          rows={[row]}
          sort={{ column: 'key', direction: 'asc' }}
          filter={EMPTY_FILTER}
          pagination={{ total: 1, page: 1, pageSize: 50 }}
        />,
      );
      expect(badgeIn(container)).toBeNull();
      cleanup();
    }
  });
});
