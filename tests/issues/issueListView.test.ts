import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  buildIssueListHref,
  nextSort,
  pageItems,
  parsePage,
  parseSort,
  parseView,
  serializeSort,
  type IssueSort,
} from '@/lib/issues/issueListView';

// The /issues view + sort URL contract (Subtask 2.5.8) — the pure parse/serialize
// + header-click transition the Server Component, the switcher, and the List
// headers all share. Whitelisting matters: a bad column must clamp to the default
// (it maps straight to a SQL ORDER BY), so these pin the fallback behaviour.

describe('parseView', () => {
  it("returns 'list' only for the exact 'list' param; everything else is the tree default", () => {
    expect(parseView('list')).toBe('list');
    expect(parseView('tree')).toBe('tree');
    expect(parseView(undefined)).toBe('tree');
    expect(parseView('')).toBe('tree');
    expect(parseView('LIST')).toBe('tree');
    expect(parseView(['list'])).toBe('tree'); // repeated param → not the literal
  });
});

describe('parseSort', () => {
  it('parses a valid column:direction pair', () => {
    expect(parseSort('priority:desc')).toEqual({ column: 'priority', direction: 'desc' });
    expect(parseSort('status:asc')).toEqual({ column: 'status', direction: 'asc' });
  });

  it('clamps anything invalid to the default (key asc)', () => {
    expect(parseSort(undefined)).toEqual(DEFAULT_SORT);
    expect(parseSort('')).toEqual(DEFAULT_SORT);
    expect(parseSort('key')).toEqual(DEFAULT_SORT); // missing direction
    expect(parseSort('bogus:asc')).toEqual(DEFAULT_SORT); // unknown column
    expect(parseSort('priority:sideways')).toEqual(DEFAULT_SORT); // bad direction
    expect(parseSort('; DROP TABLE work_item;--:asc')).toEqual(DEFAULT_SORT); // not whitelisted
    expect(parseSort(['key:asc'])).toEqual(DEFAULT_SORT);
  });

  it('round-trips through serializeSort', () => {
    const sort: IssueSort = { column: 'due', direction: 'desc' };
    expect(parseSort(serializeSort(sort))).toEqual(sort);
  });
});

describe('nextSort', () => {
  it('flips direction when the active column is clicked again', () => {
    expect(nextSort({ column: 'key', direction: 'asc' }, 'key')).toEqual({
      column: 'key',
      direction: 'desc',
    });
    expect(nextSort({ column: 'key', direction: 'desc' }, 'key')).toEqual({
      column: 'key',
      direction: 'asc',
    });
  });

  it('moves to a new column ascending when a different column is clicked', () => {
    expect(nextSort({ column: 'key', direction: 'desc' }, 'priority')).toEqual({
      column: 'priority',
      direction: 'asc',
    });
  });
});

describe('buildIssueListHref', () => {
  it('omits both defaults — the canonical Tree URL is the bare pathname', () => {
    expect(buildIssueListHref('/issues', { view: 'tree' })).toBe('/issues');
    expect(
      buildIssueListHref('/issues', {
        view: 'tree',
        sort: { column: 'priority', direction: 'desc' },
      }),
    ).toBe('/issues');
  });

  it('adds view=list, and the sort param only when it is non-default', () => {
    expect(buildIssueListHref('/issues', { view: 'list', sort: DEFAULT_SORT })).toBe(
      '/issues?view=list',
    );
    expect(
      buildIssueListHref('/issues', {
        view: 'list',
        sort: { column: 'priority', direction: 'desc' },
      }),
    ).toBe('/issues?view=list&sort=priority%3Adesc');
  });
});

describe('parsePage (Subtask 2.5.12)', () => {
  it('parses a positive integer; non-numeric / <1 / absent → 1', () => {
    expect(parsePage('3')).toBe(3);
    expect(parsePage('1')).toBe(1);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage(['2', '3'])).toBe(1); // arrays aren't a valid single page
  });

  it('does NOT upper-clamp (the service clamps to the filtered last page)', () => {
    expect(parsePage('9999')).toBe(9999);
  });
});

describe('pageItems (Subtask 2.5.12)', () => {
  it('shows every page with no ellipsis when small (≤7)', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('truncates both ends around the current page (matches the 2.5.10 design)', () => {
    expect(pageItems(1, 25)).toEqual([1, 2, 3, 'ellipsis', 25]);
    expect(pageItems(13, 25)).toEqual([1, 'ellipsis', 12, 13, 14, 'ellipsis', 25]);
    expect(pageItems(25, 25)).toEqual([1, 'ellipsis', 23, 24, 25]);
  });

  it('shows a single page when there are no others', () => {
    expect(pageItems(1, 0)).toEqual([1]);
  });
});

describe('buildIssueListHref — page param (Subtask 2.5.12)', () => {
  it('sets ?page only on the List, past page 1, preserving sort + filter', () => {
    expect(buildIssueListHref('/issues', { view: 'list', page: 3 })).toBe(
      '/issues?view=list&page=3',
    );
    // page 1 is the clean canonical URL (so a sort/filter change resets it)
    expect(buildIssueListHref('/issues', { view: 'list', page: 1 })).toBe('/issues?view=list');
    // the Tree never paginates
    expect(buildIssueListHref('/issues', { view: 'tree', page: 5 })).toBe('/issues');
    expect(
      buildIssueListHref('/issues', {
        view: 'list',
        sort: { column: 'priority', direction: 'desc' },
        page: 2,
      }),
    ).toBe('/issues?view=list&sort=priority%3Adesc&page=2');
  });
});
