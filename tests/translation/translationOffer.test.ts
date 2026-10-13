import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { Locale } from '@/lib/i18n/locales';
import { hashFieldText } from '@/lib/translation/fieldRevision';
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
    expect(result.fields).toMatchObject({
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
    expect(result.fields.description).toMatchObject({
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
    expect(result.fields.title).toMatchObject({
      needsTranslation: true,
      kept: false,
      sourceLanguage: null,
    });
    expect(result.fields.description).toMatchObject({
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

// MOTIR-8122: the reader's half both hosts carry — the offer plus whether the
// no-credit message may link to adding credit (owner or admin of the org).
describe('getReaderTranslation', () => {
  const read = (workItem: WorkItemDto, readerLocale: Locale, d: TranslationOfferDeps) =>
    workItemTranslationReadService.getReaderTranslation(
      { workItem, todos: [], readerLocale, ctx },
      d,
    );

  it('asks the billing capability, with the reader’s context, only when something differs', async () => {
    const canManageBilling = vi.fn(async () => true);
    const result = await read(item('zh'), 'en', { ...deps(), canManageBilling });
    expect(result.offer.anyNeedsTranslation).toBe(true);
    expect(result.canAddCredits).toBe(true);
    expect(canManageBilling).toHaveBeenCalledWith(ctx);

    canManageBilling.mockClear();
    const none = await read(item('en', { title: 'Build the export' }), 'en', {
      ...deps(),
      canManageBilling,
    });
    expect(none.offer.anyNeedsTranslation).toBe(false);
    expect(none.canAddCredits).toBe(false);
    expect(canManageBilling).not.toHaveBeenCalled();
  });

  it('a member who cannot manage billing gets no link', async () => {
    const result = await read(item('zh'), 'en', {
      ...deps(),
      canManageBilling: async () => false,
    });
    expect(result.canAddCredits).toBe(false);
  });
});

// MOTIR-8123: each field carries its CURRENT revision — the store's own hash of
// its text, never the text — and an edit moves it for that field alone.
describe('getTranslationOffer — revision', () => {
  it('is hashFieldText of each field’s current text, and moves only for the edited field', async () => {
    const a = await offer(item('zh'), 'en', deps(), [todo('t1', '做这一步', 'zh')]);
    expect(a.fields.title!.revision).toBe(hashFieldText('构建导出功能'));
    expect(a.fields.description!.revision).toBe(hashFieldText('这是描述'));
    expect(a.fields.explanation!.revision).toBe(hashFieldText(''));
    expect(a.fields['todo:t1:text']!.revision).toBe(hashFieldText('做这一步'));
    expect(JSON.stringify(a)).not.toContain('这是描述');

    const b = await offer(item('zh', { descriptionMd: '这是描述!' }), 'en', deps(), [
      todo('t1', '做这一步', 'zh'),
    ]);
    for (const ref of Object.keys(a.fields)) {
      if (ref === 'description') expect(b.fields[ref]!.revision).not.toBe(a.fields[ref]!.revision);
      else expect(b.fields[ref]!.revision, ref).toBe(a.fields[ref]!.revision);
    }
  });
});
