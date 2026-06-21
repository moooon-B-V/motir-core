// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      getRowHref: (r) => `/items/${r.id}`,
      getRowLabel: (r) => `${r.id} ${r.title}`,
    });
    const root = screen.getByTestId('row-A');
    const link = within(root).getByRole('link', { name: 'A Epic A' });
    expect(link.getAttribute('href')).toBe('/items/A');

    const click = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', click);
    root.focus();
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(1);
  });
});

// ── Virtualization (Subtask 2.5.15) ─────────────────────────────────────────
// Window the treegrid against a scroll viewport: only viewport(+overscan) rows
// mount, the rowgroup keeps its full height, and roving-tabindex arrow keys that
// land on an off-window row scroll it in, mount it, and focus it. happy-dom does
// no layout, so we supply a controllable scroll element (via getScrollElement)
// and stub its metrics — getBoundingClientRect is wired so the body's offset from
// the viewport top stays 0 at any scrollTop (the real scroll-invariant geometry).

const ROW_PX = 40; // mirrors TreeTable's fixed row height

function flatRows(n: number): TreeTableRow<Row>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    data: { id: `r${i}`, title: `Row ${i}` },
  }));
}

/** A stub scroll viewport with settable scrollTop + a fixed clientHeight. */
function makeViewport(clientHeight: number) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let scrollTop = 0;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return el;
}

function mountedDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="row-r"]'));
}

describe('TreeTable — virtualization', () => {
  let viewport: HTMLElement;

  beforeEach(() => {
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    viewport = makeViewport(320); // 8 rows tall
    // Geometry: viewport top is the origin; everything else sits at -scrollTop, so
    // bodyOffset = bodyTop - viewportTop + scrollTop = (-scrollTop) - 0 + scrollTop = 0.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isViewport = this === viewport;
      const top = isViewport ? 0 : -viewport.scrollTop;
      const height = isViewport ? 320 : ROW_PX;
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
    vi.restoreAllMocks();
    viewport.remove();
  });

  function renderBig(count: number) {
    return render(
      <TreeTable
        label="Big"
        columns={COLUMNS}
        rows={flatRows(count)}
        getRowTestId={(r) => `row-${r.id}`}
        getScrollElement={() => viewport}
      />,
    );
  }

  it('mounts only a window of a tall tree and keeps the full scroll height', () => {
    const { container } = renderBig(500);

    const mounted = mountedDataRows(container);
    // A window — far fewer than all 500 rows — but the top rows are present.
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(60);
    expect(screen.getByTestId('row-r0')).toBeTruthy();
    expect(screen.queryByTestId('row-r400')).toBeNull();

    // The rowgroup body reserves the full height (spacer), so the scrollbar is honest.
    const body = container.querySelectorAll<HTMLElement>('[role="rowgroup"]')[1]!;
    expect(body.style.height).toBe(`${500 * ROW_PX}px`);
  });

  it('mounts a different window after the viewport scrolls', () => {
    renderBig(500);
    expect(screen.getByTestId('row-r0')).toBeTruthy();

    viewport.scrollTop = 400 * ROW_PX;
    fireEvent.scroll(viewport);

    // The window moved to the rows around index 400; the top rows unmounted.
    expect(screen.getByTestId('row-r400')).toBeTruthy();
    expect(screen.queryByTestId('row-r0')).toBeNull();
  });

  it('arrowing past the window scrolls the landed row in, mounts it, and focuses it', () => {
    renderBig(500);
    const first = screen.getByTestId('row-r0');
    first.focus();
    expect(document.activeElement).toBe(first);

    // Step well past the initial window; each ArrowDown re-targets the focused row.
    for (let i = 0; i < 20; i++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    }

    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('data-testid')).toBe('row-r20');
    expect(active.isConnected).toBe(true); // it was mounted by the scroll-into-view
    expect(active.getAttribute('tabindex')).toBe('0'); // roving tabindex followed
    // The starting row scrolled out of the window and unmounted.
    expect(screen.queryByTestId('row-r0')).toBeNull();
  });

  it('End jumps to and focuses the last row (honest aria-setsize across the window)', () => {
    renderBig(500);
    const first = screen.getByTestId('row-r0');
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });

    const last = screen.getByTestId('row-r499');
    expect(document.activeElement).toBe(last);
    expect(last.getAttribute('aria-setsize')).toBe('500'); // true total, not the window size
    expect(last.getAttribute('aria-posinset')).toBe('500');
  });
});
