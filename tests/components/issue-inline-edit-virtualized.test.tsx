// @vitest-environment happy-dom
//
// Regression: bug-inline-status-revert-on-second-edit, the post-#640
// recurrence. The #640 fix kept a confirmed inline edit ONLY in the cell's
// useConvergingOverride component state — but TreeTable virtualizes (2.5.15,
// merged before that fix): a row scrolled out of the window UNMOUNTS,
// destroying the override, and the Tree re-renders it on remount from its
// `levels` client cache, which inline edits never wrote into → the OLD status
// came back (display-only; the DB held the new value). "Editing a second item"
// correlated because reaching it is what scrolls the first row out (+8
// overscan); collapse→re-expand of a parent hit the same path via the cached
// child level. The fix records every confirmed (rowId, field) → value in the
// PROVIDER's ledger — which outlives row mounts — and remounting cells re-read
// it under the same catch-up rule, so a genuinely fresher server row (someone
// else's later edit) still wins.
//
// happy-dom does no layout (clientHeight 0 → windowing off — which is exactly
// why the #640 tests missed this), so the scroll viewport is stubbed the same
// way tree-table.test.tsx does: a scroll parent findScrollParent() resolves,
// with scroll-invariant getBoundingClientRect geometry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

const { push, listRootIssuesAction, listChildIssuesAction, changeStatusAction } = vi.hoisted(
  () => ({
    push: vi.fn(),
    listRootIssuesAction: vi.fn(),
    listChildIssuesAction: vi.fn(),
    changeStatusAction: vi.fn(),
  }),
);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({ listRootIssuesAction, listChildIssuesAction }));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction,
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const createIssue = vi.hoisted(() => ({ issuesChangedAt: 0 }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: () => {},
    openCreateIssue: () => {},
    canCreate: true,
    issuesChangedAt: createIssue.issuesChangedAt,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { IssueTreeTable } from '@/app/(authed)/items/_components/IssueTreeTable';
import type { TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

const ROW_PX = 40; // mirrors TreeTable's fixed row height
const VIEWPORT_PX = 320; // 8 rows tall

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
    {
      id: 's2',
      projectId: 'p1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open', // every status is a legal target
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
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasChildren: false,
    ...over,
  };
}

function renderTree(initialLevel: TreeLevelDto, container?: HTMLElement) {
  return render(
    <IssueTreeTable
      initialLevel={initialLevel}
      sort={sort}
      filter={EMPTY_FILTER}
      workflow={workflow}
      members={members}
    />,
    container ? { container } : undefined,
  );
}

/** Inline-edit a mounted row's STATUS to "In Progress" via the shared picker. */
async function editStatus(identifier: string) {
  const row = screen.getByTestId(`issue-row-${identifier}`);
  fireEvent.click(within(row).getByRole('button', { name: 'Edit Status' }));
  fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
  await waitFor(() =>
    expect(
      within(screen.getByTestId(`issue-row-${identifier}`)).getByText('In Progress'),
    ).toBeTruthy(),
  );
}

describe('inline edits survive row unmounts (virtualization scroll-out)', () => {
  let viewport: HTMLElement;

  beforeEach(() => {
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    // The scroll parent findScrollParent() resolves — standing in for the real
    // /items page's scrolling main column. Inline overflow-y makes
    // getComputedStyle see it; clientHeight/scrollTop are stubbed (no layout).
    viewport = document.createElement('div');
    viewport.style.overflowY = 'auto';
    document.body.appendChild(viewport);
    let scrollTop = 0;
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      get: () => VIEWPORT_PX,
    });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    // Scroll-invariant geometry, same stub as tree-table.test.tsx: the viewport
    // sits at 0; everything else sits at -scrollTop → bodyOffset stays 0.
    const vp = viewport;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isViewport = this === vp;
      const top = isViewport ? 0 : -vp.scrollTop;
      const height = isViewport ? VIEWPORT_PX : ROW_PX;
      return {
        top,
        bottom: top + height,
        left: 0,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON() {},
      } as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    createIssue.issuesChangedAt = 0;
    viewport.remove();
  });

  const sixtyRoots = (): TreeLevelDto => ({
    rows: Array.from({ length: 60 }, (_, i) => node({ id: `w${i + 1}`, key: i + 1 })),
    hasMore: false,
    total: 60,
  });

  it('keeps the first row’s new status after scrolling away, editing a second item, and scrolling back', async () => {
    renderTree(sixtyRoots(), viewport);

    // Sanity: virtualization is ON — the 60-row tree mounts only a window.
    expect(screen.getByTestId('issue-row-PROD-1')).toBeTruthy();
    expect(screen.queryByTestId('issue-row-PROD-50')).toBeNull();

    // 1. Inline-edit PROD-1's status → To Do → In Progress; the action confirms.
    changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
    await editStatus('PROD-1');

    // 2. Scroll down to reach a second item — PROD-1 leaves the window and its
    //    cell components unmount (the converging overrides die with them).
    viewport.scrollTop = 30 * ROW_PX;
    fireEvent.scroll(viewport);
    expect(screen.queryByTestId('issue-row-PROD-1')).toBeNull();

    // 3. Edit the second item.
    changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:01.000Z' });
    await editStatus('PROD-31');

    // 4. Scroll back up — PROD-1 remounts from the Tree's `levels` cache, which
    //    still holds the pre-edit row. The provider ledger must supply the
    //    confirmed status; before the fix this rendered "To Do" again.
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    const row1 = screen.getByTestId('issue-row-PROD-1');
    expect(within(row1).queryByText('To Do')).toBeNull();
    expect(within(row1).getByText('In Progress')).toBeTruthy();
  });

  it('yields the remount-persisted value to a genuinely fresher server row', async () => {
    const initialLevel = sixtyRoots();
    const { rerender } = renderTree(initialLevel, viewport);

    changeStatusAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
    await editStatus('PROD-1');

    // Scroll PROD-1 out and back — it now renders from the ledger entry.
    viewport.scrollTop = 30 * ROW_PX;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(within(screen.getByTestId('issue-row-PROD-1')).getByText('In Progress')).toBeTruthy();

    // A create elsewhere bumps the tick → the tree refetches roots. The fresh
    // read carries someone's LATER edit (back to To Do, newer updatedAt): the
    // served row has caught up past the acknowledged write, so the server
    // value must win — the ledger never pins a confirmed-but-superseded value.
    listRootIssuesAction.mockResolvedValue({
      ok: true,
      level: {
        rows: [
          { ...node({ id: 'w1', key: 1 }), status: 'todo', updatedAt: '2026-06-12T00:00:00.000Z' },
          ...initialLevel.rows.slice(1),
        ],
        hasMore: false,
        total: 60,
      },
    });
    await act(async () => {
      createIssue.issuesChangedAt = 1;
      rerender(
        <IssueTreeTable
          initialLevel={initialLevel}
          sort={sort}
          filter={EMPTY_FILTER}
          workflow={workflow}
          members={members}
        />,
      );
    });
    const row1 = screen.getByTestId('issue-row-PROD-1');
    expect(within(row1).getByText('To Do')).toBeTruthy();
    expect(within(row1).queryByText('In Progress')).toBeNull();
  });
});
