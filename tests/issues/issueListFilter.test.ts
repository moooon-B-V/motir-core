import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  appendFilterParams,
  countActiveFilters,
  isFilterActive,
  parseIssueFilter,
  setFilterText,
  toProjectTreeFilter,
  toggleAssignee,
  toggleKind,
  toggleStatus,
  toggleUnassigned,
  type IssueFilter,
} from '@/lib/issues/issueListFilter';

// The /issues filter URL contract (Subtask 2.5.4) — pure parse / serialize /
// count / map logic, unit-tested in isolation (no React, no DB). The filter is
// multi-select and lives in the URL; these lock the canonical round-trip the
// Server Component (read) and the client bar both depend on.

function href(f: IssueFilter): string {
  const params = new URLSearchParams();
  appendFilterParams(params, f);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

describe('parseIssueFilter', () => {
  it('returns the empty filter for absent params', () => {
    expect(parseIssueFilter({})).toEqual(EMPTY_FILTER);
  });

  it('parses a single value per facet (string form)', () => {
    expect(parseIssueFilter({ kind: 'bug', status: 'todo', assignee: 'u1', q: 'oauth' })).toEqual({
      kinds: ['bug'],
      statuses: ['todo'],
      assigneeIds: ['u1'],
      includeUnassigned: false,
      text: 'oauth',
      advanced: null,
    });
  });

  it('parses repeated params as multi-select (array form)', () => {
    const f = parseIssueFilter({
      kind: ['bug', 'task'],
      status: ['in_progress', 'done'],
      assignee: ['u2', 'u1'],
    });
    // kinds in canonical issue-type order; statuses + assignees sorted.
    expect(f.kinds).toEqual(['task', 'bug']);
    expect(f.statuses).toEqual(['done', 'in_progress']);
    expect(f.assigneeIds).toEqual(['u1', 'u2']);
  });

  it('treats the assignee=unassigned token as the Unassigned bucket', () => {
    const f = parseIssueFilter({ assignee: ['unassigned', 'u1'] });
    expect(f.includeUnassigned).toBe(true);
    expect(f.assigneeIds).toEqual(['u1']);
  });

  it('drops unknown kinds and de-dupes', () => {
    const f = parseIssueFilter({ kind: ['bug', 'nonsense', 'bug'] });
    expect(f.kinds).toEqual(['bug']);
  });

  it('treats a blank q as no text filter', () => {
    expect(parseIssueFilter({ q: '   ' }).text).toBeNull();
    expect(parseIssueFilter({ q: '  oauth ' }).text).toBe('oauth');
  });
});

describe('appendFilterParams (URL serialization) round-trips through parse', () => {
  it('round-trips a populated filter to the canonical URL and back', () => {
    const f: IssueFilter = {
      kinds: ['task', 'bug'],
      statuses: ['done', 'in_progress'],
      assigneeIds: ['u1'],
      advanced: null,
      includeUnassigned: true,
      text: 'oauth',
    };
    const url = href(f);
    // Canonical order: kinds (type order) · statuses (sorted) · assignees (sorted)
    // + the unassigned token last · q.
    expect(url).toBe(
      '?kind=task&kind=bug&status=done&status=in_progress&assignee=u1&assignee=unassigned&q=oauth',
    );
    // Parse back via getAll (URLSearchParams keeps the repeats) → identical filter.
    const sp = new URLSearchParams(url.slice(1));
    expect(
      parseIssueFilter({
        kind: sp.getAll('kind'),
        status: sp.getAll('status'),
        assignee: sp.getAll('assignee'),
        q: sp.get('q') ?? undefined,
      }),
    ).toEqual(f);
  });

  it('appends nothing for the empty filter (clean URL)', () => {
    expect(href(EMPTY_FILTER)).toBe('');
  });
});

describe('countActiveFilters + isFilterActive', () => {
  it('counts each selected value (incl. Unassigned + non-empty text)', () => {
    const f: IssueFilter = {
      kinds: ['bug'],
      statuses: ['in_progress', 'done'],
      assigneeIds: ['u1'],
      advanced: null,
      includeUnassigned: true,
      text: 'oauth',
    };
    expect(countActiveFilters(f)).toBe(6); // 1 + 2 + 1 + 1 + 1
    expect(isFilterActive(f)).toBe(true);
  });

  it('the empty filter is inactive with count 0', () => {
    expect(countActiveFilters(EMPTY_FILTER)).toBe(0);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });
});

describe('toProjectTreeFilter (→ service read DTO)', () => {
  it('omits every empty axis', () => {
    expect(toProjectTreeFilter(EMPTY_FILTER)).toEqual({});
  });

  it('forwards only the non-empty axes', () => {
    expect(
      toProjectTreeFilter({
        kinds: ['bug'],
        statuses: [],
        assigneeIds: ['u1'],
        advanced: null,
        includeUnassigned: true,
        text: 'x',
      }),
    ).toEqual({ kinds: ['bug'], assigneeIds: ['u1'], includeUnassigned: true, text: 'x' });
  });
});

describe('immutable facet toggles', () => {
  it('toggleKind adds then removes, keeping canonical order', () => {
    const a = toggleKind(EMPTY_FILTER, 'bug');
    expect(a.kinds).toEqual(['bug']);
    const b = toggleKind(a, 'epic');
    expect(b.kinds).toEqual(['epic', 'bug']); // canonical type order, not insertion
    expect(toggleKind(b, 'bug').kinds).toEqual(['epic']);
  });

  it('toggleStatus / toggleAssignee add + remove (sorted)', () => {
    const s = toggleStatus(toggleStatus(EMPTY_FILTER, 'in_progress'), 'done');
    expect(s.statuses).toEqual(['done', 'in_progress']);
    const a = toggleAssignee(toggleAssignee(EMPTY_FILTER, 'u2'), 'u1');
    expect(a.assigneeIds).toEqual(['u1', 'u2']);
    expect(toggleAssignee(a, 'u1').assigneeIds).toEqual(['u2']);
  });

  it('toggleUnassigned flips the bucket; setFilterText trims to null', () => {
    expect(toggleUnassigned(EMPTY_FILTER).includeUnassigned).toBe(true);
    expect(setFilterText(EMPTY_FILTER, '  hi ').text).toBe('hi');
    expect(setFilterText(EMPTY_FILTER, '   ').text).toBeNull();
  });
});
