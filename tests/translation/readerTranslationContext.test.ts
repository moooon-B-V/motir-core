import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { hashFieldText } from '@/lib/translation/fieldRevision';
import {
  readerTranslationContextService as svc,
  type ReaderTranslationContextDeps,
} from '@/lib/services/readerTranslationContextService';
import {
  workItemTranslationReadService,
  type TranslationOfferDeps,
} from '@/lib/services/workItemTranslationReadService';

// The reader's translation context (Story MOTIR-7738 · MOTIR-8828) with the
// entitlement, the billing predicate and the offer injected — no database. The
// translation client and the store are wired to fail the test if invoked: this
// card decides, it never spends.

const requestTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/translateClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/translateClient')>()),
  requestTranslation,
}));
const keep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/workItemTranslationStoreService', () => ({
  workItemTranslationStoreService: { getKept: vi.fn(async () => ({})), keep },
}));

const reader = { userId: 'u1', workspaceId: 'w1' };
const on = { autoTranslateWorkContent: true };
const off = { autoTranslateWorkContent: false };

const access = (over: Partial<AiAccessDTO> = {}): AiAccessDTO => ({
  applicable: true,
  organizationId: 'org-1',
  organizationName: 'Org',
  canManageBilling: false,
  hasPaidAiPlan: true,
  balance: 100,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
  ...over,
});

function makeDeps(a: AiAccessDTO = access(), canManage = true) {
  const getAiAccess = vi.fn<ReaderTranslationContextDeps['getAiAccess']>(async () => a);
  const canManageBilling = vi.fn<ReaderTranslationContextDeps['canManageBilling']>(
    async () => canManage,
  );
  const keptStub: TranslationOfferDeps = {
    getKept: vi.fn(async () => ({})),
    canManageBilling: async () => canManage,
  };
  const getReaderTranslation = vi.fn<ReaderTranslationContextDeps['getReaderTranslation']>(
    (input) => workItemTranslationReadService.getReaderTranslation(input, keptStub),
  );
  return { getAiAccess, canManageBilling, getReaderTranslation, keptStub };
}

const en = (id: string, title = `Title ${id}`) => ({ id, title, language: 'en' });

beforeEach(() => {
  requestTranslation.mockClear();
  keep.mockClear();
});

describe('resolveContext', () => {
  it('echoes the switch and the reader locale from the DTO alone, optimistic credit', () => {
    expect(svc.resolveContext({ project: on, reader, readerLocale: 'ko' })).toEqual({
      autoTranslateWorkContent: true,
      targetLanguage: 'ko',
      credit: 'ok',
      canAddCredit: false,
    });
    expect(
      svc.resolveContext({ project: off, reader, readerLocale: 'ko' })!.autoTranslateWorkContent,
    ).toBe(false);
  });

  it('answers null for a Visitor', () => {
    const visitor = { kind: 'visitor' } as VisitorReadContext;
    expect(svc.resolveContext({ project: on, reader: visitor, readerLocale: 'ko' })).toBeNull();
  });
});

describe('resolveForTitles', () => {
  it('switch off: false, empty verdicts, no entitlement read', async () => {
    const d = makeDeps();
    const out = await svc.resolveForTitles(
      { project: off, reader, readerLocale: 'ko', titles: [en('a')] },
      d,
    );
    expect(out!.context.autoTranslateWorkContent).toBe(false);
    expect(out!.verdicts).toEqual({});
    expect(d.getAiAccess).not.toHaveBeenCalled();
    expect(d.canManageBilling).not.toHaveBeenCalled();
  });

  it('switch on, ko reader over en titles: every id has a verdict with the title revision', async () => {
    const d = makeDeps();
    const out = await svc.resolveForTitles(
      { project: on, reader, readerLocale: 'ko', titles: [en('a'), en('b')] },
      d,
    );
    expect(Object.keys(out!.verdicts)).toEqual(['a', 'b']);
    for (const id of ['a', 'b']) {
      expect(out!.verdicts[id]).toMatchObject({
        needsTranslation: true,
        sourceLanguage: 'en',
        revision: hashFieldText(`Title ${id}`),
      });
    }
    expect(d.getAiAccess).toHaveBeenCalledTimes(1);
  });

  it('nothing needs translating: credit ok and no entitlement read', async () => {
    const d = makeDeps(access({ hasPaidAiPlan: false }));
    const out = await svc.resolveForTitles(
      {
        project: on,
        reader,
        readerLocale: 'ko',
        titles: [{ id: 'a', title: '안녕', language: 'ko' }],
      },
      d,
    );
    expect(out!.verdicts.a).toMatchObject({ needsTranslation: false, sourceLanguage: null });
    expect(out!.context.credit).toBe('ok');
    expect(d.getAiAccess).not.toHaveBeenCalled();
  });

  it('N titles cost at most one entitlement call; manageBilling only when no_credit', async () => {
    const ok = makeDeps();
    await svc.resolveForTitles(
      { project: on, reader, readerLocale: 'ko', titles: [en('a'), en('b'), en('c')] },
      ok,
    );
    expect(ok.getAiAccess).toHaveBeenCalledTimes(1);
    expect(ok.canManageBilling).not.toHaveBeenCalled();

    const broke = makeDeps(access({ balance: 0 }), true);
    const out = await svc.resolveForTitles(
      { project: on, reader, readerLocale: 'ko', titles: [en('a'), en('b'), en('c')] },
      broke,
    );
    expect(broke.getAiAccess).toHaveBeenCalledTimes(1);
    expect(broke.canManageBilling).toHaveBeenCalledTimes(1);
    expect(out!.context).toMatchObject({ credit: 'no_credit', canAddCredit: true });
  });

  it('a Visitor gets null with no entitlement read', async () => {
    const d = makeDeps();
    const visitor = { kind: 'visitor' } as VisitorReadContext;
    const out = await svc.resolveForTitles(
      { project: on, reader: visitor, readerLocale: 'ko', titles: [en('a')] },
      d,
    );
    expect(out).toBeNull();
    expect(d.getAiAccess).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not applicable (self-host / meta)',
      access({ applicable: false, hasPaidAiPlan: false, balance: 0 }),
      'ok',
    ],
    ['applicable, no paid plan', access({ hasPaidAiPlan: false }), 'no_credit'],
    ['applicable, balance 0', access({ balance: 0 }), 'no_credit'],
    ['applicable, negative balance', access({ balance: -3 }), 'no_credit'],
    ['applicable, paid, positive balance', access(), 'ok'],
  ] as const)('credit verdict: %s → %s', async (_name, a, expected) => {
    const out = await svc.resolveForTitles(
      { project: on, reader, readerLocale: 'ko', titles: [en('a')] },
      makeDeps(a),
    );
    expect(out!.context.credit).toBe(expected);
  });

  it('never spends: no translation request and no kept row on any path', async () => {
    await svc.resolveForTitles(
      { project: on, reader, readerLocale: 'ko', titles: [en('a')] },
      makeDeps(access({ balance: 0 })),
    );
    expect(requestTranslation).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('resolveForItem', () => {
  const item = {
    id: 'wi1',
    projectId: 'p1',
    title: 'Build the export feature',
    descriptionMd: null,
    explanationMd: null,
    languages: { title: 'en', description: null, explanation: null },
  } as WorkItemDto;
  const todos: WorkItemTodoDto[] = [];

  it('returns the SAME offer the shipped read service produces', async () => {
    const d = makeDeps();
    const out = await svc.resolveForItem(
      { project: on, reader, readerLocale: 'ko', workItem: item, todos },
      d,
    );
    const direct = await workItemTranslationReadService.getReaderTranslation(
      { workItem: item, todos, readerLocale: 'ko', ctx: reader },
      d.keptStub,
    );
    expect(out!.offer).toEqual(direct.offer);
    expect(out!.offer.anyNeedsTranslation).toBe(true);
  });

  it('switch on with no credit: takes canAddCredits from the offer, never calls manageBilling itself', async () => {
    const d = makeDeps(access({ hasPaidAiPlan: false }), true);
    const out = await svc.resolveForItem(
      { project: on, reader, readerLocale: 'ko', workItem: item, todos },
      d,
    );
    expect(out!.context).toMatchObject({ credit: 'no_credit', canAddCredit: true });
    expect(d.canManageBilling).not.toHaveBeenCalled();
  });

  it('switch off: the offer is still produced (the press is ungated), no entitlement read', async () => {
    const d = makeDeps();
    const out = await svc.resolveForItem(
      { project: off, reader, readerLocale: 'ko', workItem: item, todos },
      d,
    );
    expect(out!.offer.anyNeedsTranslation).toBe(true);
    expect(out!.context.credit).toBe('ok');
    expect(d.getAiAccess).not.toHaveBeenCalled();
  });

  it('already in the reader language: no entitlement read', async () => {
    const d = makeDeps(access({ hasPaidAiPlan: false }));
    const out = await svc.resolveForItem(
      { project: on, reader, readerLocale: 'en', workItem: item, todos },
      d,
    );
    expect(out!.offer.anyNeedsTranslation).toBe(false);
    expect(d.getAiAccess).not.toHaveBeenCalled();
  });

  it('a Visitor gets null and the offer is never read', async () => {
    const d = makeDeps();
    const visitor = { kind: 'visitor' } as VisitorReadContext;
    const out = await svc.resolveForItem(
      { project: on, reader: visitor, readerLocale: 'ko', workItem: item, todos },
      d,
    );
    expect(out).toBeNull();
    expect(d.getReaderTranslation).not.toHaveBeenCalled();
    expect(requestTranslation).not.toHaveBeenCalled();
  });
});
