import { describe, expect, it, vi } from 'vitest';
import type { RequestTranslationInput, TranslateTenant } from '@/lib/ai/translateClient';
import type { TranslateResult } from '@/lib/ai/translate';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import {
  assembleFields,
  workItemTranslationService,
  type TranslationDoorDeps,
} from '@/lib/services/workItemTranslationService';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { hashFieldText } from '@/lib/translation/fieldRevision';
import { fieldLockKey } from '@/lib/services/translationSingleFlight';

// The translation door's MAPPING (Story MOTIR-7735 · MOTIR-8120) with every seam
// stubbed — no database, no network. The real-database behaviour (locks, the
// store, the access gate, the tenant) is `tests/integration/translation/translationDoor.test.ts`.

const ctx = { userId: 'u1', workspaceId: 'w1' };
const tenant: TranslateTenant = {
  organizationId: 'org-1',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'w1',
  projectId: 'p1',
  projectKey: 'ACME',
};

function item(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi1',
    projectId: 'p1',
    title: 'Den Export bauen',
    descriptionMd: 'Die Beschreibung',
    explanationMd: null,
    languages: { title: 'de', description: 'de', explanation: null },
    ...overrides,
  } as WorkItemDto;
}

const todo = (id: string, text: string, notesMd: string | null): WorkItemTodoDto =>
  ({ id, text, notesMd, textLanguage: 'de', notesLanguage: 'de' }) as WorkItemTodoDto;

function deps(
  answer: TranslateResult | ((i: RequestTranslationInput) => TranslateResult),
  kept: Record<string, string> = {},
  overrides: Partial<TranslationDoorDeps> = {},
) {
  const calls: RequestTranslationInput[] = [];
  const keepCalls: string[] = [];
  const d: TranslationDoorDeps = {
    loadSubject: async () => ({ item: item(), todos: [] }),
    store: {
      getKept: async (_s, fields) =>
        Object.fromEntries(
          fields.filter((f) => kept[f.fieldRef]).map((f) => [f.fieldRef, kept[f.fieldRef]!]),
        ),
      keep: async (_s, field, _l, text) => {
        keepCalls.push(field.fieldRef);
        return { fieldRef: field.fieldRef, translatedText: text };
      },
    },
    requestTranslation: async (input) => {
      calls.push(input);
      return typeof answer === 'function' ? answer(input) : answer;
    },
    withFieldLocks: async (_keys, fn) => fn(),
    resolveTenant: async () => tenant,
    ...overrides,
  };
  return { d, calls, keepCalls };
}

const press = (d: TranslationDoorDeps) =>
  workItemTranslationService.translateWorkItem(
    { workItemId: 'wi1', targetLanguage: 'en', actor: ctx },
    d,
  );

const echo = (i: RequestTranslationInput): TranslateResult => ({
  status: 'ok',
  translations: i.fields.map((f) => ({ fieldRef: f.fieldRef, text: `EN ${f.text}` })),
});

describe('assembleFields', () => {
  it('lists title, description, explanation and each to-do text + notes, in reading order', () => {
    const fields = assembleFields(item(), [
      todo('t1', 'Schritt', 'Notiz'),
      todo('t2', 'Zwei', null),
    ]);
    expect(fields.map((f) => [f.fieldRef, f.text, f.language])).toEqual([
      ['title', 'Den Export bauen', 'de'],
      ['description', 'Die Beschreibung', 'de'],
      ['explanation', '', null],
      ['todo:t1:text', 'Schritt', 'de'],
      ['todo:t1:notes', 'Notiz', 'de'],
      ['todo:t2:text', 'Zwei', 'de'],
      ['todo:t2:notes', '', 'de'],
    ]);
  });
});

describe('translateWorkItem — mapping', () => {
  it('ok: keeps each sent field and returns them ready, in reading order', async () => {
    const { d, keepCalls } = deps(echo);
    expect(await press(d)).toEqual([
      { fieldRef: 'title', status: 'ready', text: 'EN Den Export bauen' },
      { fieldRef: 'description', status: 'ready', text: 'EN Die Beschreibung' },
    ]);
    expect(keepCalls).toEqual(['title', 'description']);
  });

  it('kept fields are served without a lock, a tenant read or a call', async () => {
    const withFieldLocks = vi.fn();
    const resolveTenant = vi.fn();
    const { d, calls } = deps(
      echo,
      { title: 'T', description: 'D' },
      { withFieldLocks, resolveTenant },
    );
    expect((await press(d)).map((r) => r.status)).toEqual(['ready', 'ready']);
    expect(calls).toHaveLength(0);
    expect(withFieldLocks).not.toHaveBeenCalled();
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'no_credit' } as const, { status: 'no_credit' }],
    [{ status: 'timeout' } as const, { status: 'timeout' }],
    [
      { status: 'failed', reason: 'invalid_reply' } as const,
      { status: 'failed', reason: 'invalid_reply' },
    ],
  ])('%o keeps nothing and marks each sent field', async (answer, expected) => {
    const { d, keepCalls } = deps(answer, { title: 'Kept' });
    expect(await press(d)).toEqual([
      { fieldRef: 'title', status: 'ready', text: 'Kept' },
      { fieldRef: 'description', ...expected },
    ]);
    expect(keepCalls).toEqual([]);
  });

  it('a lock wait that times out answers timeout for the fields, and sends nothing', async () => {
    const { d, calls } = deps(
      echo,
      {},
      {
        withFieldLocks: async () => {
          throw new FieldLockTimeoutError(2);
        },
      },
    );
    expect(await press(d)).toEqual([
      { fieldRef: 'title', status: 'timeout' },
      { fieldRef: 'description', status: 'timeout' },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('a field kept by a concurrent press while waiting is served, not sent', async () => {
    const kept: Record<string, string> = {};
    const { d, calls } = deps(echo, kept, {
      withFieldLocks: async (_k, fn) => {
        kept['title'] = 'Kept by the other press';
        return fn();
      },
    });
    const results = await press(d);
    expect(calls[0]!.fields.map((f) => f.fieldRef)).toEqual(['description']);
    expect(results[0]).toEqual({
      fieldRef: 'title',
      status: 'ready',
      text: 'Kept by the other press',
    });
  });

  it('locks one key per missing field, keyed on org, item, field, text hash and language', async () => {
    const withFieldLocks = vi.fn(async (_k: readonly string[], fn: () => Promise<unknown>) => fn());
    const { d } = deps(echo, {}, { withFieldLocks: withFieldLocks as never });
    await press(d);
    expect(withFieldLocks.mock.calls[0]![0]).toEqual([
      fieldLockKey({
        organizationId: 'org-1',
        workItemId: 'wi1',
        fieldRef: 'title',
        sourceHash: hashFieldText('Den Export bauen'),
        targetLanguage: 'en',
      }),
      fieldLockKey({
        organizationId: 'org-1',
        workItemId: 'wi1',
        fieldRef: 'description',
        sourceHash: hashFieldText('Die Beschreibung'),
        targetLanguage: 'en',
      }),
    ]);
  });

  it('an item with nothing to translate returns [] and touches nothing', async () => {
    const getKept = vi.fn();
    const { d, calls } = deps(
      echo,
      {},
      {
        loadSubject: async () => ({
          item: item({ languages: { title: 'en', description: 'en', explanation: null } }),
          todos: [],
        }),
      },
    );
    d.store = { ...d.store, getKept };
    expect(await press(d)).toEqual([]);
    expect(getKept).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('the fieldLockKey changes with the text revision', () => {
    const base = {
      organizationId: 'o',
      workItemId: 'w',
      fieldRef: 'title',
      targetLanguage: 'en' as const,
    };
    expect(fieldLockKey({ ...base, sourceHash: 'a' })).not.toBe(
      fieldLockKey({ ...base, sourceHash: 'b' }),
    );
  });

  it('more fields than one job carries go out as several jobs, each within motir-ai limits', async () => {
    const todos = Array.from({ length: 20 }, (_, i) => todo(`t${i}`, `Schritt ${i}`, `Notiz ${i}`));
    const { d, calls } = deps(echo, {}, { loadSubject: async () => ({ item: item(), todos }) });
    const results = await press(d);
    // 2 item fields + 40 to-do fields = 42 → 32 + 10.
    expect(calls.map((c) => c.fields.length)).toEqual([32, 10]);
    expect(results).toHaveLength(42);
    expect(results.every((r) => r.status === 'ready')).toBe(true);
    expect(results.map((r) => r.fieldRef)).toEqual(
      assembleFields(item(), todos)
        .filter((f) => f.text)
        .map((f) => f.fieldRef),
    );
  });

  it('a field too long for any job is failed unsent; the rest still translate', async () => {
    const { d, calls } = deps(
      echo,
      {},
      {
        loadSubject: async () => ({ item: item({ descriptionMd: 'Ä'.repeat(40_001) }), todos: [] }),
      },
    );
    expect(await press(d)).toEqual([
      { fieldRef: 'title', status: 'ready', text: 'EN Den Export bauen' },
      { fieldRef: 'description', status: 'failed', reason: 'rejected' },
    ]);
    expect(calls.map((c) => c.fields.map((f) => f.fieldRef))).toEqual([['title']]);
  });

  it('one batch failing leaves the other batch translated', async () => {
    const todos = Array.from({ length: 20 }, (_, i) => todo(`t${i}`, `Schritt ${i}`, `Notiz ${i}`));
    let n = 0;
    const { d, keepCalls } = deps(
      (i) => (n++ === 0 ? echo(i) : { status: 'failed', reason: 'job_failed' }),
      {},
      { loadSubject: async () => ({ item: item(), todos }) },
    );
    const results = await press(d);
    expect(results.filter((r) => r.status === 'ready')).toHaveLength(32);
    expect(results.filter((r) => r.status === 'failed')).toHaveLength(10);
    expect(keepCalls).toHaveLength(32);
  });
});
