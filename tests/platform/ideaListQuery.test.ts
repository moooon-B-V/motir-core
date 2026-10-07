import { describe, expect, it } from 'vitest';
import {
  ideaListHref,
  isFilteredView,
  readIdeaListView,
  toIdeaListQuery,
  withIdeaFilter,
} from '@/app/(admin)/admin/ideas/_components/ideaListQuery';

// The Ideas list's URL ↔ filter model (MOTIR-7680, design `platform-admin`
// § Ideas → Data): Active is the default and never written, `all` drops the
// status filter, unknown values are dropped, and any filter change drops the
// cursor.

describe('readIdeaListView', () => {
  it('defaults to Active with no filter', () => {
    expect(readIdeaListView({})).toEqual({ status: 'active' });
  });

  it('reads every filter, trimming and taking the first of a repeated key', () => {
    expect(
      readIdeaListView({
        q: '  returns ',
        status: 'retired',
        kind: 'motir_buys',
        category: 'ecommerce',
        tag: ['smb', 'other'],
        cursor: 'abc',
      }),
    ).toEqual({
      q: 'returns',
      status: 'retired',
      kind: 'motir_buys',
      category: 'ecommerce',
      tag: 'smb',
      cursor: 'abc',
    });
  });

  it('drops a status, kind or category the store does not know, and blank values', () => {
    expect(
      readIdeaListView({ status: 'deleted', kind: 'idea', category: 'space', q: '   ', tag: '' }),
    ).toEqual({ status: 'active' });
  });
});

describe('toIdeaListQuery', () => {
  it('asks for active ideas by default and every status for All', () => {
    expect(toIdeaListQuery({ status: 'active' })).toEqual({ status: 'active' });
    expect(toIdeaListQuery({ status: 'all', kind: 'direction' })).toEqual({ kind: 'direction' });
    expect(
      toIdeaListQuery({ status: 'retired', q: 'x', tag: 't', category: 'pets', cursor: 'c' }),
    ).toEqual({ status: 'retired', q: 'x', tag: 't', category: 'pets', cursor: 'c' });
  });
});

describe('isFilteredView', () => {
  it('is false only for the default view', () => {
    expect(isFilteredView({ status: 'active' })).toBe(false);
    expect(isFilteredView({ status: 'active', cursor: 'c' })).toBe(false);
    expect(isFilteredView({ status: 'all' })).toBe(true);
    expect(isFilteredView({ status: 'active', tag: 'smb' })).toBe(true);
  });
});

describe('ideaListHref and withIdeaFilter', () => {
  it('writes the default view as the bare route', () => {
    expect(ideaListHref({})).toBe('/admin/ideas');
    expect(ideaListHref({ status: 'active' })).toBe('/admin/ideas');
  });

  it('writes every filter and the cursor, never the default status', () => {
    expect(
      ideaListHref({ q: 'a b', status: 'all', kind: 'direction', category: 'pets', tag: 'smb' }),
    ).toBe('/admin/ideas?q=a+b&status=all&kind=direction&category=pets&tag=smb');
    expect(ideaListHref({ status: 'retired', cursor: 'xyz' })).toBe(
      '/admin/ideas?status=retired&cursor=xyz',
    );
  });

  it('changes one filter, drops the cursor, and round-trips through the URL', () => {
    const view = readIdeaListView({ status: 'retired', kind: 'direction', cursor: 'abc' });
    const next = withIdeaFilter(view, 'category', 'ecommerce');
    expect(next).toEqual({ status: 'retired', kind: 'direction', category: 'ecommerce' });
    const href = ideaListHref(next);
    const params = Object.fromEntries(new URL(href, 'https://x.test').searchParams);
    expect(readIdeaListView(params)).toEqual(next);
  });

  it('clears a filter, and resets status to Active when it is cleared', () => {
    const view = readIdeaListView({ status: 'all', tag: 'smb', q: 'x' });
    expect(withIdeaFilter(view, 'tag', undefined)).toEqual({ status: 'all', q: 'x' });
    expect(withIdeaFilter(view, 'q', '')).toEqual({ status: 'all', tag: 'smb' });
    expect(withIdeaFilter(view, 'status', undefined)).toEqual({
      status: 'active',
      tag: 'smb',
      q: 'x',
    });
  });
});
