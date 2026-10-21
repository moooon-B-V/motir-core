import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchLinkablePages } from '@/lib/pages/pageLinkSearch';

// The Link page picker's browser fetcher (MOTIR-9204): it REJECTS on a non-OK
// response so a failed search can never read as "no pages match".

afterEach(() => vi.unstubAllGlobals());

describe('searchLinkablePages', () => {
  it('resolves the DTO on 200, sending the project, query and cursor', async () => {
    const dto = { items: [], nextCursor: null };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(dto), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchLinkablePages('proj 1', 'road map', 'cur')).toEqual(dto);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url, 'http://x').searchParams.get('projectId')).toBe('proj 1');
    expect(new URL(url, 'http://x').searchParams.get('q')).toBe('road map');
    expect(new URL(url, 'http://x').searchParams.get('cursor')).toBe('cur');
  });

  it('omits the cursor on a first page', async () => {
    const fetchMock = vi.fn(async () => new Response('{"items":[],"nextCursor":null}'));
    vi.stubGlobal('fetch', fetchMock);
    await searchLinkablePages('p', 'road');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url, 'http://x').searchParams.has('cursor')).toBe(false);
  });

  it('rejects on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    await expect(searchLinkablePages('p', 'road')).rejects.toThrow('HTTP 403');
  });
});
