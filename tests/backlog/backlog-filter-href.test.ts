import { describe, expect, it } from 'vitest';
import { buildBacklogFilterHref } from '@/lib/backlog/backlogFilterHref';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';

// The backlog-scoped filter URL contract (Story 8.8 · Subtask 8.8.18). The
// backlog reuses the /issues filter components (exactly as the board did,
// 6.15.3) but serializes their state onto `/backlog` with NO view/sort/page
// (the backlog is cursor-paginated). These assert the backlog href: the facets +
// advanced param appended in canonical order, empty → clean `/backlog`.

describe('buildBacklogFilterHref', () => {
  it('returns clean /backlog when no filter is set', () => {
    expect(buildBacklogFilterHref({ filter: EMPTY_FILTER })).toBe('/backlog');
  });

  it('appends a single kind facet', () => {
    const filter: IssueFilter = { ...EMPTY_FILTER, kinds: ['bug'] };
    expect(buildBacklogFilterHref({ filter })).toBe('/backlog?kind=bug');
  });

  it('serializes every facet axis + the advanced param in canonical order', () => {
    const filter: IssueFilter = {
      kinds: ['bug'],
      types: ['code'],
      includeUntyped: true,
      statuses: ['in_progress'],
      assigneeIds: ['u1'],
      includeUnassigned: true,
      text: 'login',
      advanced: 'v1:abc',
    };
    const href = buildBacklogFilterHref({ filter });
    expect(href).toBe(
      '/backlog?kind=bug&type=code&type=untyped&status=in_progress&assignee=u1&assignee=unassigned&q=login&filter=v1%3Aabc',
    );
  });

  it('carries no view/sort/page param (the backlog has none — cursor-paginated)', () => {
    const href = buildBacklogFilterHref({ filter: { ...EMPTY_FILTER, statuses: ['done'] } });
    expect(href).toBe('/backlog?status=done');
    expect(href).not.toContain('view');
    expect(href).not.toContain('sort');
    expect(href).not.toContain('page');
  });
});
