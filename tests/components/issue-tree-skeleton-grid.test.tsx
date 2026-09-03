// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { TreeTableRow } from '@/components/ui/TreeTable';

// The /items Suspense fallback must hold the SHAPE of the table it stands in
// for, or the settle is a layout JUMP rather than the absence of one (bug
// MOTIR-3452; the earlier MOTIR-1307 this restores). `IssueTreeSkeleton`
// restated its grid template and its header labels as two local constants, and
// three columns (Type · Points · Actions) were added to `buildIssueColumns`
// without sweeping them — 272px of fixed track that the `1fr` Title column was
// lent on every load and had taken back on settle.
//
// The file's own header comment stated the invariant in English ("the grid
// template is kept in sync with the columns") and stayed green for eighty days
// while it was false. A sentence addressed to a future author is not a
// mechanism; this file is. It renders the fallback and the real table into one
// document and compares the two `grid-template-columns` strings directly, so a
// column added to the registry and not to the skeleton fails here — and so does
// one REMOVED from it, which is how MOTIR-4258 landed: the Actions column went,
// and the only thing that needed changing in this file was the assertion that
// had been written about Actions BY NAME. The comparisons are safe in both
// directions precisely because they name no column.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
// The real rows are inline-editable (Subtask 2.5.5), so the cell modules import
// the detail page's edit Server Actions — stub them so this stays DB-free.
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { IssueTreeSkeleton } from '@/app/(authed)/items/_components/IssueTreeSkeleton';
import { IssueTreeStaticTable } from '@/app/(authed)/items/_components/IssueTreeStaticTable';
import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  push.mockReset();
  cleanup();
});

const ROW: IssueRowData = {
  id: 'wi_1',
  title: 'First',
  identifier: 'PROD-1',
  kind: 'task',
  type: null,
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
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
};
const TREE_ROWS: TreeTableRow<IssueRowData>[] = [{ id: ROW.id, data: ROW }];

/** The authored `grid-template-columns` of an element (both tables and the
 *  skeleton set it as an inline style, so this is the string as written). */
function gridOf(el: Element | null): string {
  expect(el).not.toBeNull();
  return (el as HTMLElement).style.gridTemplateColumns;
}

/** Every element in `root` that carries an inline grid template — the header
 *  row first, then one per body row. */
function gridRows(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[style*="grid-template-columns"]'));
}

function skeletonRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="issue-tree-skeleton"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function headerTexts(row: Element): string[] {
  return Array.from(row.children).map((c) => (c.textContent ?? '').trim());
}

describe('IssueTreeSkeleton — the fallback holds the table’s shape', () => {
  it('emits the SAME grid template as the nested Tree table', () => {
    const table = render(<IssueTreeStaticTable rows={TREE_ROWS} />).container;
    const skeleton = render(<IssueTreeSkeleton />).container;

    const tableGrid = gridOf(table.querySelector('[role="row"]'));
    const skeletonGrid = gridOf(gridRows(skeletonRoot(skeleton))[0] ?? null);

    // Quoted rather than only compared, so a failure names both strings.
    expect({ skeleton: skeletonGrid, table: tableGrid }).toEqual({
      skeleton: tableGrid,
      table: tableGrid,
    });
  });

  it('emits the SAME grid template as the flat List table in the `flat` variant', () => {
    const table = render(
      <IssueListTable
        rows={[ROW]}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: 1, page: 1, pageSize: 50 }}
      />,
    ).container;
    const skeleton = render(<IssueTreeSkeleton flat />).container;

    const tableGrid = gridOf(table.querySelector('[data-testid="issue-list-table"] [role="row"]'));
    const skeletonGrid = gridOf(gridRows(skeletonRoot(skeleton))[0] ?? null);

    expect({ skeleton: skeletonGrid, table: tableGrid }).toEqual({
      skeleton: tableGrid,
      table: tableGrid,
    });
  });

  it('keeps the indent/chevron as the ONLY delta between the two variants — the tracks are identical', () => {
    const tree = skeletonRoot(render(<IssueTreeSkeleton />).container);
    const flat = skeletonRoot(render(<IssueTreeSkeleton flat />).container);

    expect(gridOf(gridRows(flat)[0] ?? null)).toBe(gridOf(gridRows(tree)[0] ?? null));

    // The documented delta: the List drops the per-row chevron slot, so the
    // tree variant renders one more element inside its Title cell.
    const titleCell = (root: HTMLElement) => gridRows(root)[1]?.firstElementChild;
    expect(titleCell(tree)?.children.length).toBe((titleCell(flat)?.children.length ?? 0) + 1);
  });

  it('renders the same header labels, in the same order, as the real table', () => {
    const table = render(<IssueTreeStaticTable rows={TREE_ROWS} />).container;
    const skeleton = render(<IssueTreeSkeleton />).container;

    const expected = headerTexts(table.querySelector('[role="row"]') as Element);
    const actual = headerTexts(gridRows(skeletonRoot(skeleton))[0] as Element);

    expect(actual).toEqual(expected);

    // This used to end by asserting the LAST header carried a screen-reader-only
    // "Actions" caption — the one column with no visible label. MOTIR-4258
    // removed that column, so the invariant worth pinning is the one underneath
    // it: the skeleton grows no trailing header the real table does not have,
    // which is what a silently-added shimmer track would look like. Read off
    // both surfaces rather than named, so it survives the next column too.
    const lastOf = (r: Element) => headerTexts(r).at(-1);
    expect(lastOf(gridRows(skeletonRoot(skeleton))[0] as Element)).toBe(
      lastOf(table.querySelector('[role="row"]') as Element),
    );
  });

  it('gives every shimmer row exactly one cell per track', () => {
    const skeleton = skeletonRoot(render(<IssueTreeSkeleton />).container);
    const rows = gridRows(skeleton);
    const tracks = gridOf(rows[0] ?? null).split(' ').length;

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.children.length).toBe(tracks);
  });
});
