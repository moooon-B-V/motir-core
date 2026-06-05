// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';

// Component tests for the TreeTable primitive (Subtask 2.5.2) under happy-dom —
// pure presentation, no DB. Cover the structural a11y (treegrid roles +
// aria-level/expanded), indentation, chevron-on-parents-only, expand/collapse
// (controlled + uncontrolled), and the roving-tabindex keyboard model.

afterEach(cleanup);

interface Row {
  id: string;
  title: string;
}

const COLUMNS: TreeTableColumn<Row>[] = [
  { key: 'title', header: 'Title', cell: (r) => <span>{r.title}</span> },
  { key: 'meta', header: 'Meta', width: 120, cell: (r) => <span>meta-{r.id}</span> },
];

// epic A → [story B → [task D], story C]
const ROWS: TreeTableRow<Row>[] = [
  {
    id: 'A',
    data: { id: 'A', title: 'Epic A' },
    children: [
      {
        id: 'B',
        data: { id: 'B', title: 'Story B' },
        children: [{ id: 'D', data: { id: 'D', title: 'Task D' } }],
      },
      { id: 'C', data: { id: 'C', title: 'Story C' } },
    ],
  },
];

function renderTree(props: Partial<React.ComponentProps<typeof TreeTable<Row>>> = {}) {
  return render(
    <TreeTable
      label="Work Items"
      columns={COLUMNS}
      rows={ROWS}
      getRowTestId={(r) => `row-${r.id}`}
      {...props}
    />,
  );
}

describe('TreeTable — structure & a11y', () => {
  it('renders a treegrid with column headers and the root row', () => {
    renderTree();
    expect(screen.getByRole('treegrid', { name: 'Work Items' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Title',
      'Meta',
    ]);
    const root = screen.getByTestId('row-A');
    expect(root.getAttribute('role')).toBe('row');
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(root.getAttribute('aria-posinset')).toBe('1');
    expect(root.getAttribute('aria-setsize')).toBe('1');
    // A parent exposes aria-expanded; collapsed by default (uncontrolled).
    expect(root.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides descendants until expanded and sets aria-level + indent per depth', () => {
    renderTree({ defaultExpandedIds: ['A'] });
    const story = screen.getByTestId('row-B');
    expect(story.getAttribute('aria-level')).toBe('2');
    // Task D is under collapsed B → not rendered.
    expect(screen.queryByTestId('row-D')).toBeNull();

    // The tree cell of a depth-2 row is indented one level (22px).
    const treeCell = within(story).getAllByRole('gridcell')[0]!;
    expect(treeCell.style.paddingLeft).toBe('22px');
    // Depth-1 root has no indent.
    const rootCell = within(screen.getByTestId('row-A')).getAllByRole('gridcell')[0]!;
    expect(rootCell.style.paddingLeft).toBe('0px');
  });

  it('shows an expand control only on rows that have children', () => {
    renderTree({ defaultExpandedIds: ['A'] });
    // Parent rows (A, B) have a chevron button; leaf C does not.
    expect(within(screen.getByTestId('row-A')).queryByRole('button')).toBeTruthy();
    expect(within(screen.getByTestId('row-B')).queryByRole('button')).toBeTruthy();
    expect(within(screen.getByTestId('row-C')).queryByRole('button')).toBeNull();
  });
});

describe('TreeTable — expand / collapse', () => {
  it('uncontrolled: clicking the chevron toggles children + aria-expanded', () => {
    renderTree();
    const root = screen.getByTestId('row-A');
    expect(screen.queryByTestId('row-B')).toBeNull();

    fireEvent.click(within(root).getByRole('button'));
    expect(root.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('row-B')).toBeTruthy();

    fireEvent.click(within(root).getByRole('button'));
    expect(root.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('row-B')).toBeNull();
  });

  it('controlled: clicking the chevron calls onExpandedChange (not internal state)', () => {
    const onExpandedChange = vi.fn();
    renderTree({ expandedIds: new Set<string>(), onExpandedChange });

    fireEvent.click(within(screen.getByTestId('row-A')).getByRole('button'));
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    const next = onExpandedChange.mock.calls[0]![0] as Set<string>;
    expect([...next]).toEqual(['A']);
    // Controlled: with expandedIds still empty, children stay hidden.
    expect(screen.queryByTestId('row-B')).toBeNull();
  });
});

describe('TreeTable — keyboard (roving tabindex)', () => {
  it('only one row is in the tab sequence; ArrowDown moves focus', () => {
    renderTree({ defaultExpandedIds: ['A'] });
    const root = screen.getByTestId('row-A');
    const story = screen.getByTestId('row-B');
    // Roving: the first row is tabbable, the rest are not.
    expect(root.getAttribute('tabindex')).toBe('0');
    expect(story.getAttribute('tabindex')).toBe('-1');

    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(story);
    expect(story.getAttribute('tabindex')).toBe('0');
  });

  it('ArrowRight expands a collapsed parent; ArrowLeft collapses it', () => {
    renderTree({ defaultExpandedIds: ['A'] });
    const story = screen.getByTestId('row-B'); // collapsed parent
    story.focus();
    expect(story.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(story, { key: 'ArrowRight' });
    expect(story.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('row-D')).toBeTruthy();

    fireEvent.keyDown(story, { key: 'ArrowLeft' });
    expect(story.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('row-D')).toBeNull();
  });

  it('Enter activates the row link', () => {
    renderTree({
      defaultExpandedIds: ['A'],
      getRowHref: (r) => `/issues/${r.id}`,
      getRowLabel: (r) => `${r.id} ${r.title}`,
    });
    const root = screen.getByTestId('row-A');
    const link = within(root).getByRole('link', { name: 'A Epic A' });
    expect(link.getAttribute('href')).toBe('/issues/A');

    const click = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', click);
    root.focus();
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(1);
  });
});
