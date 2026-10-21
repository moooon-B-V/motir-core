import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkPageToWorkItem, unlinkPageFromWorkItem } from '@/lib/workItems/pageLinksClient';

// The hand link's two write calls (Story MOTIR-7567 · MOTIR-9199): what each
// sends, and how a refusal is read — by the body's `code` when it carries one
// and by the status family when it does not.

afterEach(() => vi.unstubAllGlobals());

const answer = (res: Response) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res),
  );

describe('linkPageToWorkItem', () => {
  it('posts the pair and answers ok', async () => {
    const fn = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fn);
    expect(await linkPageToWorkItem('wi_1', 'pg_1')).toEqual({ ok: true, status: 200 });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/work-items/wi_1/pages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ pageId: 'pg_1' });
  });

  it('reads the code from a JSON refusal', async () => {
    answer(Response.json({ code: 'PAGE_LINK_ALREADY_LINKED' }, { status: 409 }));
    expect(await linkPageToWorkItem('wi_1', 'pg_1')).toEqual({
      ok: false,
      status: 409,
      code: 'PAGE_LINK_ALREADY_LINKED',
    });
  });

  it('has no code when the body carries none, or is not JSON at all', async () => {
    answer(Response.json({ error: 'x' }, { status: 403 }));
    expect(await linkPageToWorkItem('wi_1', 'pg_1')).toEqual({
      ok: false,
      status: 403,
      code: null,
    });
    answer(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await linkPageToWorkItem('wi_1', 'pg_1')).toEqual({
      ok: false,
      status: 502,
      code: null,
    });
  });

  it('rejects when the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await expect(linkPageToWorkItem('wi_1', 'pg_1')).rejects.toThrow('offline');
  });
});

describe('unlinkPageFromWorkItem', () => {
  it('deletes the pair, encoding both ids, and answers ok on 204', async () => {
    const fn = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fn);
    expect(await unlinkPageFromWorkItem('wi/1', 'pg 1')).toEqual({ ok: true, status: 204 });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/work-items/wi%2F1/pages/pg%201');
    expect(init.method).toBe('DELETE');
  });

  it('reads a refusal the same way', async () => {
    answer(Response.json({ code: 'PAGE_LINK_NOT_FOUND' }, { status: 404 }));
    expect(await unlinkPageFromWorkItem('wi_1', 'pg_1')).toEqual({
      ok: false,
      status: 404,
      code: 'PAGE_LINK_NOT_FOUND',
    });
  });
});
