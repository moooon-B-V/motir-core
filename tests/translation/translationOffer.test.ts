import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { Locale } from '@/lib/i18n/locales';
import {
  workItemTranslationReadService,
  type TranslationOfferDeps,
} from '@/lib/services/workItemTranslationReadService';

// THE PAGE-READ OFFER (Story MOTIR-7735 · Subtask MOTIR-8121) with the store
// stubbed through `deps` — no database, no network. The detector and the
// motir-ai client are wrapped in spies so the cases can say what was NOT called.
// The real-store case (`kept` flipping on an edit) is
// `tests/integration/translation/translationOffer.test.ts`.

const detect = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/translation/detectLanguage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/translation/detectLanguage')>();
  return {
    ...actual,
    detectLocale: (text: string) => {
      detect.calls.push(text);
      return actual.detectLocale(text);
    },
  };
});
const requestTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/translateClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/translateClient')>()),
  requestTranslation,
}));

const ctx = { userId: 'u1', workspaceId: 'w1' };

function item(lang: Locale | null, overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi1',
    projectId: 'p1',
    title: '构建导出功能',
    descriptionMd: '这是描述',
    explanationMd: null,
    languages: { title: lang, description: lang, explanation: lang },
    ...overrides,
  } as WorkItemDto;
}

const todo = (id: string, text: string, lang: Locale | null): WorkItemTodoDto =>
  ({ id, text, notesMd: null, textLanguage: lang, notesLanguage: lang }) as WorkItemTodoDto;

function deps(kept: Record<string, string> = {}) {
  const getKept = vi.fn<TranslationOfferDeps['getKept']>(async (_s, fields) =>
    Object.fromEntries(
      fields.filter((f) => kept[f.fieldRef]).map((f) => [f.fieldRef, kept[f.fieldRef]!]),
    ),
  );
  return { getKept };
}

const offer = (
  workItem: WorkItemDto,
  readerLocale: Locale,
  d: TranslationOfferDeps,
  todos: WorkItemTodoDto[] = [],
) => workItemTranslationReadService.getTranslationOffer({ workItem, todos, readerLocale, ctx }, d);

beforeEach(() => {
  detect.calls.length = 0;
  requestTranslation.mockReset();
});

describe('getTranslationOffer', () => {
  it('a German reader of a zh-recorded item: every non-empty field needs translating', async () => {
    const d = deps();
    const result = await offer(item('zh'), 'de', d, [todo('t1', '做这一步', 'zh')]);
    expect(result.targetLanguage).toBe('de');
    expect(result.anyNeedsTranslation).toBe(true);
    expect(result.fields).toEqual({
      title: { needsTranslation: true, kept: false, sourceLanguage: 'zh' },
      description: { needsTranslation: true, kept: false, sourceLanguage: 'zh' },
      explanation: { needsTranslation: false, kept: false, sourceLanguage: null },
      'todo:t1:text': { needsTranslation: true, kept: false, sourceLanguage: 'zh' },
      'todo:t1:notes': { needsTranslation: false, kept: false, sourceLanguage: null },
    });
    expect(d.getKept).toHaveBeenCalledTimes(1);
    expect(d.getKept.mock.calls[0]![1].map((f) => f.fieldRef)).toEqual([
      'title',
      'description',
      'todo:t1:text',
    ]);
    expect(d.getKept.mock.calls[0]![2]).toBe('de');
  });

  it('an English reader of an en-recorded item: nothing needs translating, no detector, no store', async () => {
    const d = deps();
    const result = await offer(
      item('en', { title: 'Build the export', descriptionMd: 'The description' }),
      'en',
      d,
      [todo('t1', 'Do the step', 'en')],
    );
    expect(result.anyNeedsTranslation).toBe(false);
    expect(Object.values(result.fields).every((f) => !f.needsTranslation && !f.kept)).toBe(true);
    expect(detect.calls).toEqual([]);
    expect(d.getKept).not.toHaveBeenCalled();
  });

  it('a mix: only the fields not in the reader’s language are flagged', async () => {
    const result = await offer(
      item('en', {
        title: 'Build the export',
        descriptionMd: 'Die Beschreibung',
        languages: { title: 'en', description: 'de', explanation: null },
      }),
      'en',
      deps(),
    );
    expect(result.anyNeedsTranslation).toBe(true);
    expect(result.fields.title!.needsTranslation).toBe(false);
    expect(result.fields.description).toEqual({
      needsTranslation: true,
      kept: false,
      sourceLanguage: 'de',
    });
  });

  it('an unrecorded field is classified by the local detector; an undecidable one is flagged', async () => {
    const result = await offer(
      item(null, {
        title: 'Xq zz',
        descriptionMd:
          'Wir müssen den Export für alle Kunden bis Freitag fertig bauen und danach testen',
      }),
      'en',
      deps(),
    );
    expect(detect.calls).toContain('Xq zz');
    expect(result.fields.title).toEqual({
      needsTranslation: true,
      kept: false,
      sourceLanguage: null,
    });
    expect(result.fields.description).toEqual({
      needsTranslation: true,
      kept: false,
      sourceLanguage: 'de',
    });
  });

  it('a field with a kept translation for the reader is marked kept', async () => {
    const result = await offer(item('zh'), 'de', deps({ title: 'Den Export bauen' }));
    expect(result.fields.title!.kept).toBe(true);
    expect(result.fields.description!.kept).toBe(false);
  });

  it('builds the offer with no call to motir-ai', async () => {
    await offer(item('zh'), 'de', deps());
    await offer(item(null, { title: 'Xq zz' }), 'en', deps());
    expect(requestTranslation).not.toHaveBeenCalled();
  });

  it('carries only flags and languages — no translated or original text', async () => {
    const result = await offer(item('zh'), 'de', deps({ title: 'Den Export bauen' }));
    const raw = JSON.stringify(result);
    expect(raw).not.toContain('Den Export bauen');
    expect(raw).not.toContain('构建导出功能');
  });
});
