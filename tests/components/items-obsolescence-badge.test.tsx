// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { WorkItemObsolescenceDto, WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
// Story MOTIR-6575 · MOTIR-6677 — the OBSOLESCENCE glyph on /items List and Tree
// rows, per `design/work-items/list--obsolescence.mock.html`: the shared
// `ObsolescenceBadge` in its glyph form, in the status cell after the status pill
// and outside the edit trigger. The two views share ONE column builder, so the
// same glyph must come out of each. Nothing hides, dims or re-sorts a marked row.
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

function listRow(obsolescence: WorkItemObsolescenceDto | null, status = 'done'): IssueRowData {
  return {
    id: 'wi_1',
    identifier: 'PROD-1',
    title: 'A change',
    kind: 'task',
    type: null,
    status,
    statusLabel: status === 'done' ? 'Done' : 'To Do',
    statusCategory: status === 'done' ? 'done' : 'todo',
    ciState: null,
    obsolescence,
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

function treeNode(obsolescence: WorkItemObsolescenceDto | null): WorkItemTreeNodeDto {
  return {
    id: 'wi_1',
    parentId: null,
    kind: 'task',
    type: null,
    key: 1,
    identifier: 'PROD-1',
    title: 'A change',
    status: 'done',
    ciState: null,
    obsolescence,
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

/** The mark as a ROW renders it: the glyph, a labelled `role="img"`. */
function markIn(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-obsolescence]');
}

function renderList(rows: IssueRowData[]) {
  return render(
    <IssueListTable
      rows={rows}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: rows.length, page: 1, pageSize: 50 }}
    />,
  );
}

describe('the obsolescence glyph on /items List and Tree rows (MOTIR-6677)', () => {
  it('draws the SAME glyph through each table, in the status cell after the status pill', () => {
    const { container: listContainer } = renderList([listRow('deprecated')]);
    const fromList = markIn(listContainer)!;
    expect(fromList).toBeTruthy();
    cleanup();

    const { container: treeContainer } = render(
      <IssueTreeTable
        initialLevel={{ rows: [treeNode('deprecated')], hasMore: false, total: 1 }}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        workflow={WORKFLOW}
        members={[]}
      />,
    );
    const fromTree = markIn(treeContainer)!;
    expect(fromTree).toBeTruthy();
    expect(fromTree.getAttribute('data-obsolescence')).toBe('deprecated');
    expect(fromTree.getAttribute('aria-label')).toBe(fromList.getAttribute('aria-label'));
    expect(fromTree.className).toBe(fromList.className);
  });

  it.each([
    ['outdated', 'Outdated', '--el-text-secondary'],
    ['deprecated', 'Deprecated', '--el-danger-on-surface'],
  ] as const)('%s is a labelled glyph with no visible word, in its AA ink', (mark, word, ink) => {
    const { container } = renderList([listRow(mark)]);
    const glyph = markIn(container)!;
    expect(glyph.getAttribute('role')).toBe('img');
    expect(glyph.getAttribute('aria-label')).toBe(word);
    expect(glyph.getAttribute('title')).toBe(word);
    expect(glyph.className).toContain(ink);
    expect(glyph.className).toContain('shrink-0');
    expect(glyph.className).not.toContain('--el-danger-text');
    expect(screen.queryByText(word)).toBeNull();
  });

  it('sits AFTER the status and outside its edit trigger', () => {
    const { container } = renderList([listRow('outdated')]);
    const glyph = markIn(container)!;
    expect(glyph.closest('button')).toBeNull();
    const cell = glyph.parentElement!;
    const children = [...cell.children];
    expect(children.indexOf(glyph)).toBeGreaterThan(0);
  });

  it('an unmarked row draws nothing new', () => {
    const { container } = renderList([listRow(null)]);
    expect(markIn(container)).toBeNull();
  });

  it('a mark changes no row order', () => {
    const a = { ...listRow(null), id: 'a', identifier: 'PROD-1', title: 'First' };
    const b = { ...listRow('outdated'), id: 'b', identifier: 'PROD-2', title: 'Second' };
    const c = { ...listRow(null), id: 'c', identifier: 'PROD-3', title: 'Third' };
    const { container } = renderList([a, b, c]);
    const text = container.textContent!;
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'));
    expect(text.indexOf('Second')).toBeLessThan(text.indexOf('Third'));
  });
});
