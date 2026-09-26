// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE DECISION-WAITING MARKER ON `/items` ROWS (MOTIR-5881; design MOTIR-5875 §
// *The List / Tree status cell*). The GLYPH form, in the STATUS cell after the
// status pill and OUTSIDE its edit trigger; loud when the decision is the
// reader's, quiet naming the routed member when it is someone else's, nothing
// when none. The per-reader answer reaches the rows BESIDE the DTOs — through the
// row shapers (List, static Tree), `initialPending` (lazy roots) and each lazy
// level's action result.

const { listRootIssuesAction, listChildIssuesAction } = vi.hoisted(() => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({ listRootIssuesAction, listChildIssuesAction }));
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

import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import {
  collectTreeIds,
  toIssueListRows,
  toIssueRows,
  type PendingDecisionMap,
} from '@/app/(authed)/items/_components/issueRows';
import type { TreeLevelDto, WorkItemTreeNodeDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import zhMessages from '@/messages/zh.json';

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u-me', name: 'Me', email: 'me@x.com', workspaceRole: 'manager', customRole: null },
  {
    userId: 'u-ana',
    name: 'Ana Ruiz',
    email: 'ana@x.com',
    workspaceRole: 'member',
    customRole: null,
  },
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

function node(over: Partial<WorkItemTreeRowDto> & { id: string; key: number }): WorkItemTreeRowDto {
  return {
    parentId: null,
    kind: 'task',
    type: null,
    identifier: `PROD-${over.key}`,
    title: `Issue ${over.key}`,
    status: 'todo',
    ciState: null,
    priority: 'medium',
    assigneeId: 'u-me',
    reporterId: 'u-me',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    hasChildren: false,
    ...over,
  };
}

const YOURS = { state: 'yours', kind: 'design_result', routedToId: 'u-me' } as const;
const ANAS = { state: 'others', kind: 'acceptance_result', routedToId: 'u-ana' } as const;

function markerIn(rowTestId: string): HTMLElement | null {
  return within(screen.getByTestId(rowTestId)).queryByRole('img', { name: /Awaiting|Waiting/ });
}

function renderList(pending: PendingDecisionMap, locale?: { locale: string; messages: object }) {
  const items = [node({ id: 'a', key: 1 }), node({ id: 'b', key: 2 }), node({ id: 'c', key: 3 })];
  return render(
    <IssueListTable
      rows={toIssueListRows(items, workflow, members, 'en', pending)}
      sort={sort}
      filter={EMPTY_FILTER}
      pagination={{ total: 3, page: 1, pageSize: 50 }}
    />,
    locale as never,
  );
}

describe('the row shapers carry the map onto the rows', () => {
  it('applies an entry, resolves the routed name, and leaves a row with no entry null', () => {
    const rows = toIssueListRows(
      [node({ id: 'a', key: 1 }), node({ id: 'b', key: 2 }), node({ id: 'c', key: 3 })],
      workflow,
      members,
      'en',
      { a: YOURS, b: ANAS, c: { ...ANAS, routedToId: 'u-gone' } },
    );
    expect(rows[0]!.pendingDecision).toEqual(YOURS);
    expect(rows[1]!.pendingRoutedToName).toBe('Ana Ruiz');
    // A routed person the member list cannot name — the marker's fallback renders.
    expect(rows[2]!.pendingRoutedToName).toBeNull();
    expect(
      toIssueListRows([node({ id: 'z', key: 9 })], workflow, members)[0]!.pendingDecision,
    ).toBeNull();
  });
});

describe('the forest shaper and its id collector (the filtered Tree’s one call)', () => {
  it('collects every id in the forest, depth-first, and carries the map onto nested rows', () => {
    const forest = [
      {
        ...node({ id: 's', key: 1, kind: 'story' }),
        matched: true,
        children: [{ ...node({ id: 'c', key: 2, parentId: 's' }), matched: true, children: [] }],
      },
      { ...node({ id: 't', key: 3 }), matched: true, children: [] },
    ] as unknown as WorkItemTreeNodeDto[];

    expect(collectTreeIds(forest)).toEqual(['s', 'c', 't']);

    const rows = toIssueRows(forest, workflow, members, 'en', { c: ANAS });
    expect(rows[0]!.data.pendingDecision).toBeNull();
    expect(rows[0]!.children?.[0]?.data.pendingDecision).toEqual(ANAS);
    expect(rows[0]!.children?.[0]?.data.pendingRoutedToName).toBe('Ana Ruiz');
    expect(toIssueRows(forest, workflow, members)[1]!.data.pendingDecision).toBeNull();
  });
});

describe('the List row — the glyph in the status cell', () => {
  it('loud for yours, quiet naming the member for someone else’s, nothing for none', () => {
    renderList({ a: YOURS, b: ANAS });

    const loud = markerIn('issue-row-PROD-1')!;
    expect(loud.getAttribute('aria-label')).toBe('Awaiting you — design approval');
    expect(loud.getAttribute('data-decision-marker')).toBe('yours');

    const quiet = markerIn('issue-row-PROD-2')!;
    expect(quiet.getAttribute('aria-label')).toBe('Waiting on Ana Ruiz — acceptance approval');
    expect(quiet.getAttribute('title')).toBe('Waiting on Ana Ruiz — acceptance approval');
    // A distinct treatment, not only distinct words.
    expect(quiet.className).not.toBe(loud.className);

    expect(markerIn('issue-row-PROD-3')).toBeNull();
  });

  it('sits AFTER the status pill and OUTSIDE any button, so it is never part of the edit trigger', () => {
    renderList({ a: YOURS });
    const glyph = markerIn('issue-row-PROD-1')!;
    expect(glyph.closest('button')).toBeNull();
    expect(glyph.previousElementSibling?.textContent).toContain('To Do');
  });

  it('the status cell FILLS its track, so the pill never wraps on a row without a marker', () => {
    // Asserted on the class because happy-dom has no layout. Measured in Chromium:
    // without `w-full` the wrapper shrinks to the trigger's content width less its
    // `-mx-1` margins, and the trigger's `max-w-full` then wraps *In Progress*
    // (38px tall, 79px wide) — only on rows with NO marker (MOTIR-5880's frame).
    renderList({});
    const pill = within(screen.getByTestId('issue-row-PROD-1')).getByText('To Do');
    const wrapper = pill.closest('span.flex.items-center.gap-1\\.5');
    expect(wrapper?.className).toContain('w-full');
  });

  it('names the routed member in zh', () => {
    renderList({ b: ANAS }, { locale: 'zh', messages: zhMessages });
    expect(
      within(screen.getByTestId('issue-row-PROD-2')).getByRole('img', {
        name: '等待 Ana Ruiz 处理——验收审批',
      }),
    ).toBeTruthy();
  });
});

describe('the lazy Tree — every level carries its own marker', () => {
  function renderTree(initialLevel: TreeLevelDto, initialPending?: PendingDecisionMap) {
    return render(
      <IssueTreeTable
        initialLevel={initialLevel}
        initialPending={initialPending}
        sort={sort}
        filter={EMPTY_FILTER}
        workflow={workflow}
        members={members}
      />,
    );
  }

  it('the first roots draw from `initialPending`', () => {
    renderTree(
      { rows: [node({ id: 'a', key: 1 }), node({ id: 'b', key: 2 })], hasMore: false, total: 2 },
      { a: YOURS },
    );
    expect(markerIn('issue-row-PROD-1')?.getAttribute('data-decision-marker')).toBe('yours');
    expect(markerIn('issue-row-PROD-2')).toBeNull();
  });

  it('an EXPANDED level draws from its own action result, and a row appended by Load more from ITS', async () => {
    listChildIssuesAction
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [node({ id: 'a1', key: 9, parentId: 'a' })], hasMore: true, total: 2 },
        pending: { a1: ANAS },
      })
      .mockResolvedValueOnce({
        ok: true,
        level: { rows: [node({ id: 'a2', key: 10, parentId: 'a' })], hasMore: false, total: 2 },
        pending: { a2: YOURS },
      });
    renderTree({ rows: [node({ id: 'a', key: 1, hasChildren: true })], hasMore: false, total: 1 });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('issue-row-PROD-1')).getByRole('button', { name: 'Expand row' }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-9')).toBeTruthy());
    expect(markerIn('issue-row-PROD-9')?.getAttribute('data-decision-marker')).toBe('others');

    await act(async () => {
      fireEvent.click(await screen.findByText('Load more children'));
    });
    await waitFor(() => expect(screen.getByTestId('issue-row-PROD-10')).toBeTruthy());
    expect(markerIn('issue-row-PROD-10')?.getAttribute('data-decision-marker')).toBe('yours');
    // The earlier row keeps its own marker — the append merged, it did not replace.
    expect(markerIn('issue-row-PROD-9')?.getAttribute('data-decision-marker')).toBe('others');
  });
});
