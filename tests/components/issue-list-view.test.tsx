// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/issues/_components/issueRows';

// The /issues view-switcher + sortable List headers (Subtask 2.5.8) under
// happy-dom — the client interactivity the card's "toggle view + sort updates
// the URL + re-queries" AC calls for. View + sort live in the URL, so both
// controls just NAVIGATE: clicking a header / a view option calls router.push
// with the canonical href, and the Server Component re-reads in the new order.
// We stub next/navigation (no real router under happy-dom) and assert the URLs.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
}));

import { IssueListTable } from '@/app/(authed)/issues/_components/IssueListTable';
import { IssueViewSwitcher } from '@/app/(authed)/issues/_components/IssueViewSwitcher';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

// Radix Popover (the switcher menu) needs a few browser APIs happy-dom lacks.
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
  push.mockReset();
  cleanup();
});

function row(over: Partial<IssueRowData> & { identifier: string }): IssueRowData {
  return {
    title: 'An issue',
    kind: 'task',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeName: null,
    priority: 'medium',
    reporterName: 'Owner',
    dueLabel: null,
    estimateLabel: null,
    ...over,
  };
}

const ROWS: IssueRowData[] = [
  row({ identifier: 'PROD-1', title: 'First' }),
  row({ identifier: 'PROD-2', title: 'Second' }),
];

describe('IssueListTable — sortable headers', () => {
  it('marks the active sort column with aria-sort and leaves the rest "none"', () => {
    render(
      <IssueListTable
        rows={ROWS}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
      />,
    );
    // Default key asc → the Title column (sorts by key) is the active ascending one.
    expect(screen.getByRole('columnheader', { name: /Title/ }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: /Priority/ }).getAttribute('aria-sort')).toBe(
      'none',
    );
  });

  it('renders both issues as whole-row links to their detail page', () => {
    render(
      <IssueListTable
        rows={ROWS}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
      />,
    );
    expect(screen.getByRole('link', { name: 'PROD-1 First' }).getAttribute('href')).toBe(
      '/issues/PROD-1',
    );
    expect(screen.getByRole('link', { name: 'PROD-2 Second' }).getAttribute('href')).toBe(
      '/issues/PROD-2',
    );
  });

  it('clicking a different header sorts by that column ascending (?view=list&sort=)', () => {
    render(
      <IssueListTable
        rows={ROWS}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Priority/ }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=priority%3Aasc');
  });

  it('clicking the active header flips its direction', () => {
    render(
      <IssueListTable
        rows={ROWS}
        sort={{ column: 'priority', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Priority/ }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=priority%3Adesc');
  });

  it('clicking the Title header sorts by key (the default column) descending', () => {
    render(
      <IssueListTable
        rows={ROWS}
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
        pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Title/ }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=key%3Adesc');
  });
});

describe('IssueViewSwitcher — Tree ↔ List toggle', () => {
  it('shows the active view on the trigger', () => {
    render(
      <IssueViewSwitcher
        view="list"
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
      />,
    );
    expect(screen.getByRole('button', { name: 'View: List' })).toBeTruthy();
  });

  it('switching to List navigates to ?view=list (preserving the current sort)', () => {
    render(
      <IssueViewSwitcher
        view="tree"
        sort={{ column: 'priority', direction: 'desc' }}
        filter={EMPTY_FILTER}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View: Tree' }));
    const list = screen.getByRole('menuitemradio', { name: /List/ });
    fireEvent.click(list);
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=priority%3Adesc');
  });

  it('switching to Tree PRESERVES the sort (the Tree sorts too since 2.5.14)', () => {
    render(
      <IssueViewSwitcher
        view="list"
        sort={{ column: 'priority', direction: 'desc' }}
        filter={EMPTY_FILTER}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View: List' }));
    const tree = screen.getByRole('menuitemradio', { name: /Tree/ });
    fireEvent.click(tree);
    // Pre-2.5.14 the Tree ignored sort so this dropped to '/issues'; now the
    // Tree sorts siblings within their parent, so the sort carries over.
    expect(push).toHaveBeenCalledWith('/issues?sort=priority%3Adesc');
  });

  it('the active view option is checked', () => {
    render(
      <IssueViewSwitcher
        view="list"
        sort={{ column: 'key', direction: 'asc' }}
        filter={EMPTY_FILTER}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View: List' }));
    expect(
      within(screen.getByRole('menuitemradio', { name: /List/ })).queryByText('List'),
    ).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /List/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: /Tree/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });
});

describe('IssueListTable — pagination footer (Subtask 2.5.12)', () => {
  const sort = { column: 'key', direction: 'asc' } as const;

  function renderPaged(page: number, total: number, pageSize = 50) {
    render(
      <IssueListTable
        rows={ROWS}
        sort={sort}
        filter={EMPTY_FILTER}
        pagination={{ total, page, pageSize }}
      />,
    );
  }

  it('shows the range + count of the filtered set', () => {
    renderPaged(2, 120);
    const count = screen.getByText(
      (_c, el) =>
        el?.tagName === 'SPAN' && /^Showing\s*51.100\s*of\s*120$/.test(el?.textContent ?? ''),
    );
    expect(count).toBeTruthy();
  });

  it('Next navigates to ?page=N+1; Prev (to page 1) drops the param', () => {
    renderPaged(2, 120);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&page=3');

    push.mockReset();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(push).toHaveBeenCalledWith('/issues?view=list'); // page 1 is the clean URL
  });

  it('a page number navigates to that page; the current page is aria-current', () => {
    renderPaged(2, 120);
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&page=3');
  });

  it('disables Prev on page 1 (no navigation)', () => {
    renderPaged(1, 120);
    const prev = screen.getByRole('button', { name: 'Previous page' });
    expect(prev.hasAttribute('disabled')).toBe(true);
    fireEvent.click(prev);
    expect(push).not.toHaveBeenCalled();
  });

  it('renders no pager nav when there is only one page (count only)', () => {
    renderPaged(1, 2);
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    expect(
      screen.getByText(
        (_c, el) =>
          el?.tagName === 'SPAN' && /^Showing\s*1.2\s*of\s*2$/.test(el?.textContent ?? ''),
      ),
    ).toBeTruthy();
  });
});
