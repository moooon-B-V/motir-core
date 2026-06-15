import { describe, expect, it } from 'vitest';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';

// The board-scoped filter URL contract (Story 6.15 · Subtask 6.15.3). The board
// reuses the /issues filter components but must serialize their state WITHOUT
// dropping the `?board=` selection (which `buildIssueListHref` would). These
// assert the board href: `?board=` preserved + lead, the facets + advanced param
// appended in canonical order, `?peek=` never carried, empty → clean `/boards`.

describe('buildBoardFilterHref', () => {
  it('returns clean /boards when no board + no filter', () => {
    expect(buildBoardFilterHref({ filter: EMPTY_FILTER })).toBe('/boards');
  });

  it('preserves the ?board= selection when no filter is set', () => {
    expect(buildBoardFilterHref({ boardId: 'brd_1', filter: EMPTY_FILTER })).toBe(
      '/boards?board=brd_1',
    );
  });

  it('appends a facet, leading with ?board= (per board)', () => {
    const filter: IssueFilter = { ...EMPTY_FILTER, kinds: ['bug'] };
    expect(buildBoardFilterHref({ boardId: 'brd_1', filter })).toBe('/boards?board=brd_1&kind=bug');
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
    const href = buildBoardFilterHref({ boardId: 'brd_1', filter });
    expect(href).toBe(
      '/boards?board=brd_1&kind=bug&type=code&type=untyped&status=in_progress&assignee=u1&assignee=unassigned&q=login&filter=v1%3Aabc',
    );
  });

  it('omits ?board= when no board is selected (project default), still appending the filter', () => {
    const filter: IssueFilter = { ...EMPTY_FILTER, statuses: ['done'] };
    expect(buildBoardFilterHref({ filter })).toBe('/boards?status=done');
  });

  it('never carries a peek param (the filter components do not pass one)', () => {
    // buildBoardFilterHref only knows board + filter — there is no peek input, so
    // a filter navigation can never re-emit `?peek=`. (Documents the design
    // decision: a filter edit happens from the toolbar, not over a peek modal.)
    const href = buildBoardFilterHref({ boardId: 'brd_1', filter: { ...EMPTY_FILTER, text: 'x' } });
    expect(href).not.toContain('peek');
  });
});
