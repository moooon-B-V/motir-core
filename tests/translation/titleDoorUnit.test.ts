import { describe, expect, it } from 'vitest';
import type { RequestTranslationInput, TranslateTenant } from '@/lib/ai/translateClient';
import type { TranslateResult } from '@/lib/ai/translate';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  isAutoTranslateOn,
  TITLE_TRANSLATION_MAX_ITEMS,
  translateTitlesForReader,
  type TitleDoorDeps,
  type TitleSubject,
} from '@/lib/services/workItemTranslationService';
import { fieldLockKey } from '@/lib/services/translationSingleFlight';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { hashFieldText } from '@/lib/translation/fieldRevision';

// The many-titles door's MAPPING (Story MOTIR-7738 · MOTIR-8829) with every seam
// stubbed and no database. The real store, locks and gate are
// `tests/integration/translation/titleTranslationDoor.test.ts`.

const ctx = { userId: 'u1', workspaceId: 'w1' };
const tenant: TranslateTenant = {
  organizationId: 'org-1',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'w1',
  projectId: 'p1',
  projectKey: 'ACME',
};

const german = (id: string, title = `Titel ${id}`): TitleSubject => ({
  workItemId: id,
  title,
  language: 'de',
});

const echo = (i: RequestTranslationInput): TranslateResult => ({
  status: 'ok',
  translations: i.fields.map((f) => ({ fieldRef: f.fieldRef, text: `EN ${f.text}` })),
});

function build(
  subjects: TitleSubject[],
  answer: TranslateResult | ((i: RequestTranslationInput) => TranslateResult) = echo,
  kept: Record<string, string> = {},
  overrides: Partial<TitleDoorDeps> = {},
) {
  const calls: Record<string, unknown[]> = {
    project: [],
    browse: [],
    subjects: [],
    kept: [],
    keep: [],
    locks: [],
    tenant: [],
    send: [],
  };
  const sent: RequestTranslationInput[] = [];
  const d: TitleDoorDeps = {
    loadProject: async (id) => {
      calls.project!.push(id);
      return { id, workspaceId: 'w1', autoTranslateWorkContent: true } as never;
    },
    assertCanBrowse: async (id) => {
      calls.browse!.push(id);
    },
    isAutoTranslateOn,
    loadSubjects: async (_p, ids) => {
      calls.subjects!.push(ids);
      return subjects.filter((s) => ids.includes(s.workItemId));
    },
    store: {
      getKeptForTitles: async (_p, titles) => {
        calls.kept!.push(titles.map((t) => t.workItemId));
        return Object.fromEntries(
          titles.filter((t) => kept[t.workItemId]).map((t) => [t.workItemId, kept[t.workItemId]!]),
        );
      },
      keep: async (subject, field, _l, text) => {
        calls.keep!.push([subject.id, field.fieldRef]);
        return { fieldRef: field.fieldRef, translatedText: text };
      },
    },
    requestTranslation: async (input) => {
      sent.push(input);
      calls.send!.push(input.fields.length);
      return typeof answer === 'function' ? answer(input) : answer;
    },
    withFieldLocks: async (keys, fn) => {
      calls.locks!.push(keys);
      return fn();
    },
    resolveTenant: async () => {
      calls.tenant!.push(1);
      return tenant;
    },
    ...overrides,
  };
  return { d, calls, sent };
}

const run = (d: TitleDoorDeps, ids: string[], target: 'en' | 'de' = 'en') =>
  translateTitlesForReader(
    { projectId: 'p1', workItemIds: ids, targetLanguage: target, actor: ctx },
    d,
  );

describe('translateTitlesForReader', () => {
  it('answers one ready entry per title that needs translating, in the order asked', async () => {
    const { d } = build([german('a'), german('b'), german('c')]);
    const r = await run(d, ['c', 'a', 'b']);
    expect(r.enabled).toBe(true);
    expect(r.titles.map((t) => t.workItemId)).toEqual(['c', 'a', 'b']);
    expect(r.titles[0]).toMatchObject({
      status: 'ready',
      text: 'EN Titel c',
      sourceLanguage: 'de',
      fieldRef: fieldRef.titleForItem('c'),
    });
  });

  it('is absent for a title already in the reader language and for an empty one', async () => {
    const { d, calls } = build([
      { workItemId: 'en1', title: 'Build the export', language: 'en' },
      { workItemId: 'blank', title: '   ', language: 'de' },
      german('de1'),
    ]);
    const r = await run(d, ['en1', 'blank', 'de1']);
    expect(r.titles.map((t) => t.workItemId)).toEqual(['de1']);
    expect(calls.send).toEqual([1]);
  });

  it('with the switch off answers enabled:false and touches no seam beyond the gate', async () => {
    const { d, calls } = build(
      [german('a')],
      echo,
      {},
      {
        loadProject: async (id) =>
          ({ id, workspaceId: 'w1', autoTranslateWorkContent: false }) as never,
      },
    );
    const r = await run(d, ['a']);
    expect(r).toEqual({ enabled: false, truncated: false, titles: [] });
    expect(calls.subjects).toEqual([]);
    expect(calls.kept).toEqual([]);
    expect(calls.locks).toEqual([]);
    expect(calls.tenant).toEqual([]);
    expect(calls.send).toEqual([]);
  });

  it('runs the browse gate before reading any title, and refuses a foreign project', async () => {
    const { d, calls } = build(
      [german('a')],
      echo,
      {},
      {
        assertCanBrowse: async () => {
          throw new Error('denied');
        },
      },
    );
    await expect(run(d, ['a'])).rejects.toThrow('denied');
    expect(calls.subjects).toEqual([]);

    const other = build(
      [german('a')],
      echo,
      {},
      {
        loadProject: async (id) =>
          ({ id, workspaceId: 'w2', autoTranslateWorkContent: true }) as never,
      },
    );
    await expect(run(other.d, ['a'])).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(other.calls.browse).toEqual([]);
  });

  it('sends each title under its own ref, once per job, and keeps it on its own item', async () => {
    const { d, sent, calls } = build([german('a'), german('b')]);
    await run(d, ['a', 'b']);
    expect(sent).toHaveLength(1);
    const refs = sent[0]!.fields.map((f) => f.fieldRef);
    expect(refs).toEqual([fieldRef.titleForItem('a'), fieldRef.titleForItem('b')]);
    expect(new Set(refs).size).toBe(refs.length);
    expect(calls.keep).toEqual([
      ['a', 'title'],
      ['b', 'title'],
    ]);
  });

  it('sends titles only, never anything else the item holds', async () => {
    const { d, sent } = build([german('a')]);
    await run(d, ['a']);
    expect(sent[0]!.fields).toEqual([{ fieldRef: fieldRef.titleForItem('a'), text: 'Titel a' }]);
  });

  it('serves kept titles from one lookup and calls nothing else when all are kept', async () => {
    const { d, calls } = build([german('a'), german('b')], echo, { a: 'A!', b: 'B!' });
    const r = await run(d, ['a', 'b']);
    expect(r.titles.map((t) => t.text)).toEqual(['A!', 'B!']);
    expect(calls.kept).toHaveLength(1);
    expect(calls.tenant).toEqual([]);
    expect(calls.locks).toEqual([]);
    expect(calls.send).toEqual([]);
  });

  it('sends only what is missing and serves the kept sibling free', async () => {
    const { d, sent } = build([german('a'), german('b')], echo, { a: 'A!' });
    const r = await run(d, ['a', 'b']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.fields.map((f) => f.fieldRef)).toEqual([fieldRef.titleForItem('b')]);
    expect(r.titles.map((t) => t.text)).toEqual(['A!', 'EN Titel b']);
  });

  it("takes the press's lock key for each missing title", async () => {
    const { d, calls } = build([german('a')]);
    await run(d, ['a']);
    expect(calls.locks[0]).toEqual([
      fieldLockKey({
        organizationId: 'org-1',
        workItemId: 'a',
        fieldRef: 'title',
        sourceHash: hashFieldText('Titel a'),
        targetLanguage: 'en',
      }),
    ]);
  });

  it('splits an over-long batch into the fewest jobs and fails a title too long for any', async () => {
    const many = Array.from({ length: 70 }, (_v, i) => german(`i${i}`));
    const { d, calls } = build([...many, german('big', 'x'.repeat(50_000))]);
    const r = await run(d, [...many.map((m) => m.workItemId), 'big']);
    const sizes = (calls.send as number[]).slice().sort((a, b) => b - a);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(70);
    expect(sizes.every((n) => n <= 32)).toBe(true);
    expect(r.titles.find((t) => t.workItemId === 'big')).toMatchObject({ status: 'failed' });
  });

  it.each(['no_credit', 'failed', 'timeout'] as const)(
    'keeps nothing and reports %s for every title of the job',
    async (status) => {
      const answer: TranslateResult =
        status === 'failed' ? { status: 'failed', reason: 'job_failed' } : { status };
      const { d, calls } = build([german('a'), german('b')], answer);
      const r = await run(d, ['a', 'b']);
      expect(r.titles.map((t) => t.status)).toEqual([status, status]);
      expect(calls.keep).toEqual([]);
    },
  );

  it('answers timeout for every title and sends nothing when the lock wait times out', async () => {
    const { d, calls } = build(
      [german('a'), german('b')],
      echo,
      {},
      {
        withFieldLocks: async () => {
          throw new FieldLockTimeoutError(2);
        },
      },
    );
    const r = await run(d, ['a', 'b']);
    expect(r.titles.map((t) => t.status)).toEqual(['timeout', 'timeout']);
    expect(calls.send).toEqual([]);
  });

  it('bounds the request, keeps the order and collapses repeats', async () => {
    const ids = Array.from({ length: TITLE_TRANSLATION_MAX_ITEMS + 5 }, (_v, i) => `i${i}`);
    const { d, calls } = build(
      ids.map((id) => german(id)),
      echo,
      Object.fromEntries(ids.map((i) => [i, 'x'])),
    );
    const r = await run(d, ['i0', 'i0', ...ids.slice(1)]);
    expect(r.truncated).toBe(true);
    expect(r.titles).toHaveLength(TITLE_TRANSLATION_MAX_ITEMS);
    expect(r.titles[0]!.workItemId).toBe('i0');
    expect((calls.subjects[0] as string[]).length).toBe(TITLE_TRANSLATION_MAX_ITEMS);
  });

  it('omits an id the reader may not answer', async () => {
    const { d } = build([german('a')]);
    const r = await run(d, ['ghost', 'a']);
    expect(r.titles.map((t) => t.workItemId)).toEqual(['a']);
  });
});
