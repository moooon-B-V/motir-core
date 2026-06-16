import { describe, expect, it } from 'vitest';
import {
  buildExploreHref,
  hasActiveFilters,
  parseExploreSearchParams,
  type ExploreQuery,
} from '@/lib/projectSquare/exploreParams';

// Story 6.13 · Subtask 6.13.6 — the URL-param model behind the fully-public,
// server-rendered PROJECT SQUARE page. Pure (no DB): parsing normalises junk
// rank/window to the default (a crawler never 500s on a malformed ordering
// param), and href-building composes the other params + resets the cursor on any
// ordering/filter change. `/explore` (no params) is the canonical default view.

const BASE = '/explore';

describe('parseExploreSearchParams', () => {
  it('defaults rank to trending and window to week when absent', () => {
    const q = parseExploreSearchParams({});
    expect(q.rank).toBe('trending');
    expect(q.window).toBe('week');
    expect(q.search).toBeUndefined();
    expect(q.category).toBeUndefined();
    expect(q.cursor).toBeUndefined();
  });

  it('passes through valid rank / window / q / category / cursor', () => {
    const q = parseExploreSearchParams({
      rank: 'popular',
      window: 'month',
      q: 'analytics',
      category: 'ai',
      cursor: 'abc',
    });
    expect(q).toEqual({
      rank: 'popular',
      window: 'month',
      search: 'analytics',
      category: 'ai',
      cursor: 'abc',
    });
  });

  it('normalises an unrecognised rank / window to the default (no throw)', () => {
    const q = parseExploreSearchParams({ rank: 'bogus', window: 'decade' });
    expect(q.rank).toBe('trending');
    expect(q.window).toBe('week');
  });

  it('trims whitespace and treats an empty query as absent', () => {
    expect(parseExploreSearchParams({ q: '  spaced  ' }).search).toBe('spaced');
    expect(parseExploreSearchParams({ q: '   ' }).search).toBeUndefined();
  });

  it('takes the first value of a repeated param', () => {
    expect(parseExploreSearchParams({ q: ['first', 'second'] }).search).toBe('first');
  });

  it('lets an explicit category override (a topic page) win over the URL', () => {
    const q = parseExploreSearchParams({ category: 'ai' }, { category: 'design' });
    expect(q.category).toBe('design');
  });
});

describe('buildExploreHref', () => {
  const base = (over: Partial<ExploreQuery> = {}): ExploreQuery => ({
    rank: 'trending',
    window: 'week',
    ...over,
  });

  it('omits default rank/window — the default view is a bare /explore', () => {
    expect(buildExploreHref(BASE, base())).toBe('/explore');
  });

  it('emits a non-default rank', () => {
    expect(buildExploreHref(BASE, base(), { rank: 'popular' })).toBe('/explore?rank=popular');
  });

  it('emits the window only for the trending rank', () => {
    expect(buildExploreHref(BASE, base(), { window: 'month' })).toBe('/explore?window=month');
    // Switching to popular drops the (now-meaningless) window entirely.
    expect(buildExploreHref(BASE, base({ window: 'month' }), { rank: 'popular' })).toBe(
      '/explore?rank=popular',
    );
  });

  it('preserves the other params when paging forward with a cursor', () => {
    const current = base({ rank: 'popular', search: 'cms', category: 'content' });
    expect(buildExploreHref(BASE, current, { cursor: 'NEXT' })).toBe(
      '/explore?q=cms&category=content&rank=popular&cursor=NEXT',
    );
  });

  it('resets the cursor when the rank changes', () => {
    const current = base({ rank: 'trending', cursor: 'STALE' });
    expect(buildExploreHref(BASE, current, { rank: 'recent' })).toBe('/explore?rank=recent');
  });

  it('resets the cursor when the search or topic changes', () => {
    const current = base({ search: 'old', cursor: 'STALE' });
    expect(buildExploreHref(BASE, current, { search: 'new' })).toBe('/explore?q=new');
  });

  it('clears a filter when an override is null', () => {
    const current = base({ search: 'analytics', category: 'ai' });
    expect(buildExploreHref(BASE, current, { category: null })).toBe('/explore?q=analytics');
    expect(buildExploreHref(BASE, current, { search: null })).toBe('/explore?category=ai');
  });

  it('builds against a topic base path', () => {
    const current = base({ rank: 'popular' });
    expect(buildExploreHref('/explore/topic/ai', current, { cursor: 'P2' })).toBe(
      '/explore/topic/ai?rank=popular&cursor=P2',
    );
  });
});

describe('hasActiveFilters', () => {
  it('is true when a search or a category is set, false otherwise', () => {
    expect(hasActiveFilters({ rank: 'trending', window: 'week' })).toBe(false);
    expect(hasActiveFilters({ rank: 'trending', window: 'week', search: 'x' })).toBe(true);
    expect(hasActiveFilters({ rank: 'trending', window: 'week', category: 'ai' })).toBe(true);
  });
});
