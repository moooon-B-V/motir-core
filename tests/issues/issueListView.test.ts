import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  buildIssueListHref,
  nextSort,
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
  it('the default-sorted Tree URL is the bare pathname (no view, no sort param)', () => {
    expect(buildIssueListHref('/issues', { view: 'tree' })).toBe('/issues');
    expect(buildIssueListHref('/issues', { view: 'tree', sort: DEFAULT_SORT })).toBe('/issues');
  });

  it('the Tree carries a non-default sort too (sortable since 2.5.14)', () => {
    // Pre-2.5.14 the Tree ignored sort; now sorting re-orders siblings, so the
    // sort param must persist for the Tree view as well as the List.
    expect(
      buildIssueListHref('/issues', {
        view: 'tree',
        sort: { column: 'priority', direction: 'desc' },
      }),
    ).toBe('/issues?sort=priority%3Adesc');
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
