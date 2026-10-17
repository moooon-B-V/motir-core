import { describe, expect, it, vi } from 'vitest';
import {
  requestTitleTranslations,
  TitleTranslationRequestError,
} from '@/components/workItems/titleTranslation/titleTranslationClient';
import { TITLE_TRANSLATION_MAX_ITEMS } from '@/lib/translation/titleBound';

// The browser's one call to the many-titles door (Story MOTIR-7738 · MOTIR-8833).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `id-${from + i}`);

describe('requestTitleTranslations', () => {
  it('posts only the ids to the project route', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ targetLanguage: 'ko', enabled: true, truncated: false, titles: [] }),
    );
    await requestTitleTranslations('MOTIR', ['a', 'b', 'a'], fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/translate-titles');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ workItemIds: ['a', 'b'] });
  });

  it('asks again for the rest while the answer is truncated, and merges the answers', async () => {
    const all = ids(TITLE_TRANSLATION_MAX_ITEMS + 5);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const asked = (JSON.parse(init.body as string) as { workItemIds: string[] }).workItemIds;
      const answered = asked.slice(0, TITLE_TRANSLATION_MAX_ITEMS);
      return json({
        targetLanguage: 'ko',
        enabled: true,
        truncated: asked.length > TITLE_TRANSLATION_MAX_ITEMS,
        titles: answered.map((id) => ({
          workItemId: id,
          fieldRef: `${id}:title`,
          status: 'ready',
          text: `t-${id}`,
          sourceLanguage: 'en',
        })),
      });
    });
    const merged = await requestTitleTranslations(
      'MOTIR',
      all,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(second.workItemIds).toEqual(all.slice(TITLE_TRANSLATION_MAX_ITEMS));
    expect(merged.truncated).toBe(false);
    expect(merged.titles).toHaveLength(all.length);
  });

  it('stops asking once an entry says there is no credit', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        targetLanguage: 'ko',
        enabled: true,
        truncated: true,
        titles: [{ workItemId: 'id-0', fieldRef: 'x', status: 'no_credit' }],
      }),
    );
    const merged = await requestTitleTranslations(
      'MOTIR',
      ids(TITLE_TRANSLATION_MAX_ITEMS + 5),
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(merged.titles[0].status).toBe('no_credit');
  });

  it('returns a switched-off answer as nothing, without further requests', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ targetLanguage: 'ko', enabled: false, truncated: false, titles: [] }),
    );
    const merged = await requestTitleTranslations(
      'MOTIR',
      ['a'],
      fetchImpl as unknown as typeof fetch,
    );
    expect(merged.enabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error carrying the status when the route refuses', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 'FORBIDDEN' }, 403));
    await expect(
      requestTitleTranslations('MOTIR', ['a'], fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 403, name: 'Error' });
    await expect(
      requestTitleTranslations('MOTIR', ['a'], fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(TitleTranslationRequestError);
  });

  it('makes no request for no ids', async () => {
    const fetchImpl = vi.fn();
    const r = await requestTitleTranslations('MOTIR', [], fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.titles).toEqual([]);
  });
});
