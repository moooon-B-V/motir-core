import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestTranslationInput } from '@/lib/ai/translateClient';
import type { TranslateResult } from '@/lib/ai/translate';
import type { Locale } from '@/lib/i18n/locales';
import { db } from '@/lib/db';
import { withFieldLocks } from '@/lib/services/translationSingleFlight';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import {
  defaultTranslationDoorDeps,
  workItemTranslationService,
  type TranslationDoorDeps,
} from '@/lib/services/workItemTranslationService';
import { workItemTranslationStoreService } from '@/lib/services/workItemTranslationStoreService';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE TRANSLATION DOOR (Story MOTIR-7735 · Subtask MOTIR-8120) against a REAL
// database: the real store, the real advisory locks, the real item reads and
// access gate, the real tenant resolution. Only `requestTranslation` — the
// motir-ai call — is a stub, and what these tests count is its CALLS: one call
// is one charge, so "exactly one call" is the no-double-billing assertion at
// this layer (the ledger itself is the motir-ai story gate's).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Stub = ((input: RequestTranslationInput) => Promise<TranslateResult>) & {
  calls: RequestTranslationInput[];
};

/** A client stub that records every call and answers `[lang] text` per field. */
function stubClient(
  answer: (input: RequestTranslationInput) => Promise<TranslateResult> | TranslateResult = (
    input,
  ) => ({
    status: 'ok',
    translations: input.fields.map((f) => ({
      fieldRef: f.fieldRef,
      text: `[${input.targetLanguage}] ${f.text}`,
    })),
  }),
): Stub {
  const calls: RequestTranslationInput[] = [];
  const fn = (async (input: RequestTranslationInput) => {
    calls.push(input);
    return answer(input);
  }) as Stub;
  fn.calls = calls;
  return fn;
}

/** The real deps with the client replaced. */
function depsWith(client: Stub): TranslationDoorDeps {
  return { ...defaultTranslationDoorDeps, requestTranslation: client };
}

interface SeedOptions {
  title?: string;
  description?: string | null;
  explanation?: string | null;
  lang?: Locale | null;
  todo?: { text: string; notes: string | null } | null;
}

/** An item whose fields all carry `lang` as their recorded language. */
async function seed(fx: WorkItemFixture, o: SeedOptions = {}) {
  const lang = o.lang === undefined ? 'de' : o.lang;
  const item = await createTestWorkItem(fx, { kind: 'task', title: o.title ?? 'Den Export bauen' });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      descriptionMd: o.description === undefined ? 'Die Beschreibung' : o.description,
      explanationMd: o.explanation === undefined ? 'Die Erklärung' : o.explanation,
      titleLanguage: lang,
      descriptionLanguage: lang,
      explanationLanguage: lang,
    },
  });
  const todo = o.todo === undefined ? { text: 'Den Schritt tun', notes: 'Die Notizen' } : o.todo;
  let todoId: string | null = null;
  if (todo) {
    const res = await workItemTodosService.addTodo(
      item.id,
      {
        text: todo.text,
        notesMd: todo.notes,
        ...(lang ? { languages: { text: lang, notes: lang } } : {}),
      },
      fx.ctx,
    );
    todoId = res.todo.id;
    if (!lang) {
      await adminDb.workItemTodo.update({
        where: { id: todoId },
        data: { textLanguage: null, notesLanguage: null },
      });
    }
  }
  return { item, todoId };
}

const press = (
  workItemId: string,
  actor: ServiceContext,
  deps: TranslationDoorDeps,
  targetLanguage: Locale = 'en',
) => workItemTranslationService.translateWorkItem({ workItemId, targetLanguage, actor }, deps);

const rowCount = () => adminDb.workItemTranslation.count();

describe('a press on an item with nothing kept', () => {
  it('sends all five differing fields in ONE call, keeps five rows, returns five ready', async () => {
    const fx = await makeWorkItemFixture();
    const { item, todoId } = await seed(fx);
    const client = stubClient();
    const results = await press(item.id, fx.ctx, depsWith(client));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.fields.map((f) => f.fieldRef)).toEqual([
      'title',
      'description',
      'explanation',
      `todo:${todoId}:text`,
      `todo:${todoId}:notes`,
    ]);
    expect(await rowCount()).toBe(5);
    expect(results).toEqual([
      { fieldRef: 'title', status: 'ready', text: '[en] Den Export bauen' },
      { fieldRef: 'description', status: 'ready', text: '[en] Die Beschreibung' },
      { fieldRef: 'explanation', status: 'ready', text: '[en] Die Erklärung' },
      { fieldRef: `todo:${todoId}:text`, status: 'ready', text: '[en] Den Schritt tun' },
      { fieldRef: `todo:${todoId}:notes`, status: 'ready', text: '[en] Die Notizen' },
    ]);
  });

  it('a second press for the same text and language makes ZERO calls and returns the same texts', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx);
    const first = await press(item.id, fx.ctx, depsWith(stubClient()));
    const client = stubClient();
    expect(await press(item.id, fx.ctx, depsWith(client))).toEqual(first);
    expect(client.calls).toHaveLength(0);
  });
});

describe('what is sent', () => {
  it("fields RECORDED in the reader's language are neither sent nor returned", async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx, { todo: null });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { titleLanguage: 'en', explanationLanguage: 'en' },
    });
    const client = stubClient();
    const results = await press(item.id, fx.ctx, depsWith(client));
    expect(client.calls[0]!.fields.map((f) => f.fieldRef)).toEqual(['description']);
    expect(results.map((r) => r.fieldRef)).toEqual(['description']);
  });

  it('a recorded language equal to the target wins over the detector', async () => {
    const fx = await makeWorkItemFixture();
    // German prose, recorded as English: never sent.
    const { item } = await seed(fx, {
      title: 'Wir müssen den Export für alle Kunden bis Freitag fertig bauen',
      description: null,
      explanation: null,
      todo: null,
      lang: 'en',
    });
    const client = stubClient();
    expect(await press(item.id, fx.ctx, depsWith(client))).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('an unrecorded field the detector cannot place IS sent', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx, {
      title: 'Xq zz',
      description: null,
      explanation: null,
      todo: null,
      lang: null,
    });
    const client = stubClient();
    await press(item.id, fx.ctx, depsWith(client));
    expect(client.calls[0]!.fields).toEqual([{ fieldRef: 'title', text: 'Xq zz' }]);
  });

  it('empty and whitespace-only fields are never sent', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx, {
      description: '   \n\t',
      explanation: null,
      todo: { text: 'Den Schritt tun', notes: '  ' },
    });
    const client = stubClient();
    const results = await press(item.id, fx.ctx, depsWith(client));
    const sent = client.calls[0]!.fields.map((f) => f.fieldRef);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe('title');
    expect(sent[1]).toMatch(/^todo:.+:text$/);
    expect(results).toHaveLength(2);
  });

  it('after one field changes, only that field is sent and its old translation is gone', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx);
    await press(item.id, fx.ctx, depsWith(stubClient()));
    await adminDb.workItem.update({ where: { id: item.id }, data: { title: 'Den Import bauen' } });

    const client = stubClient();
    const results = await press(item.id, fx.ctx, depsWith(client));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.fields).toEqual([{ fieldRef: 'title', text: 'Den Import bauen' }]);
    expect(results[0]).toEqual({
      fieldRef: 'title',
      status: 'ready',
      text: '[en] Den Import bauen',
    });
    expect(results.find((r) => r.status === 'ready' && r.text.includes('Export'))).toBeUndefined();
    expect(results.slice(1).every((r) => r.status === 'ready')).toBe(true);
    // The superseded title row was removed; still one row per field.
    expect(await rowCount()).toBe(5);
  });
});

describe('single flight', () => {
  it('two concurrent presses make ONE call between them and both return the same texts', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx);
    const slow = stubClient(async (input) => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        status: 'ok',
        translations: input.fields.map((f) => ({ fieldRef: f.fieldRef, text: `EN ${f.text}` })),
      };
    });
    const [a, b] = await Promise.all([
      press(item.id, fx.ctx, depsWith(slow)),
      press(item.id, fx.ctx, depsWith(slow)),
    ]);
    expect(slow.calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.every((r) => r.status === 'ready')).toBe(true);
    expect(await rowCount()).toBe(5);
  });

  it('overlapping but different field sets send each field revision once and do not deadlock', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx, { explanation: null, todo: null });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = stubClient(async (input) => {
      if (client.calls.length === 1) await gate;
      return {
        status: 'ok',
        translations: input.fields.map((f) => ({ fieldRef: f.fieldRef, text: `EN ${f.text}` })),
      };
    });
    const first = press(item.id, fx.ctx, depsWith(client));
    await expect.poll(() => client.calls.length).toBe(1);
    // While the first press holds {title, description@v1}, the description is edited:
    // the second press's set is {title, description@v2} — overlapping on the title.
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { descriptionMd: 'Die neue Beschreibung' },
    });
    const second = press(item.id, fx.ctx, depsWith(client));
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
          )[0]!.n,
      )
      .toBeGreaterThan(BigInt(0));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(client.calls.map((c) => c.fields.map((f) => f.text))).toEqual([
      ['Den Export bauen', 'Die Beschreibung'],
      ['Die neue Beschreibung'],
    ]);
    expect(a.map((r) => r.status)).toEqual(['ready', 'ready']);
    expect(b).toEqual([
      { fieldRef: 'title', status: 'ready', text: 'EN Den Export bauen' },
      { fieldRef: 'description', status: 'ready', text: 'EN Die neue Beschreibung' },
    ]);
  });

  it('withFieldLocks takes keys in sorted order: crossed key lists never deadlock', async () => {
    const fx = await makeWorkItemFixture();
    const order: string[] = [];
    const run = (name: string, keys: string[]) =>
      withFieldLocks(
        keys,
        async () => {
          order.push(`${name}:in`);
          await new Promise((r) => setTimeout(r, 150));
          order.push(`${name}:out`);
        },
        fx.ctx,
      );
    await Promise.all([run('a', ['k1', 'k2', 'k3']), run('b', ['k3', 'k2', 'k4'])]);
    // Serialised — one ran wholly before the other.
    expect([order.slice(0, 2), order.slice(2)].map((p) => p[0]!.split(':')[0])).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
    expect(order[0]!.split(':')[0]).toBe(order[1]!.split(':')[0]);
  });

  it('a wait past the bound throws FieldLockTimeoutError and never runs fn', async () => {
    const fx = await makeWorkItemFixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withFieldLocks(['k'], () => gate, fx.ctx);
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`
          )[0]!.n,
      )
      .toBeGreaterThan(BigInt(0));
    let ran = false;
    await expect(
      withFieldLocks(
        ['k'],
        async () => {
          ran = true;
        },
        fx.ctx,
        { waitMs: 200 },
      ),
    ).rejects.toBeInstanceOf(FieldLockTimeoutError);
    expect(ran).toBe(false);
    release();
    await holder;
  });
});

describe('a fresh attempt that fails', () => {
  it.each([
    ['no_credit', { status: 'no_credit' } as const, { status: 'no_credit' }],
    [
      'failed',
      { status: 'failed', reason: 'job_failed' } as const,
      { status: 'failed', reason: 'job_failed' },
    ],
    ['timeout', { status: 'timeout' } as const, { status: 'timeout' }],
  ])(
    '%s keeps nothing, marks each sent field, still serves kept ones, releases the lock',
    async (_l, answer, expected) => {
      const fx = await makeWorkItemFixture();
      const { item } = await seed(fx, { explanation: null, todo: null });
      // The title is already kept; only the description is fresh.
      await workItemTranslationStoreService.keep(
        { id: item.id },
        { fieldRef: 'title', text: 'Den Export bauen' },
        'en',
        'Build the export',
        fx.ctx,
      );
      const client = stubClient(() => answer);
      const results = await press(item.id, fx.ctx, depsWith(client));
      expect(results).toEqual([
        { fieldRef: 'title', status: 'ready', text: 'Build the export' },
        { fieldRef: 'description', ...expected },
      ]);
      expect(client.calls[0]!.fields.map((f) => f.fieldRef)).toEqual(['description']);
      expect(await rowCount()).toBe(1);

      // The lock was released: a following press proceeds and succeeds.
      const ok = stubClient();
      const retry = await press(item.id, fx.ctx, depsWith(ok));
      expect(ok.calls).toHaveLength(1);
      expect(retry[1]).toEqual({
        fieldRef: 'description',
        status: 'ready',
        text: '[en] Die Beschreibung',
      });
    },
  );

  it('a failed attempt then a successful retry keeps ONE row per field from ONE successful call', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx);
    await press(
      item.id,
      fx.ctx,
      depsWith(stubClient(() => ({ status: 'failed', reason: 'unavailable' }))),
    );
    expect(await rowCount()).toBe(0);
    const ok = stubClient();
    await press(item.id, fx.ctx, depsWith(ok));
    expect(ok.calls).toHaveLength(1);
    expect(await rowCount()).toBe(5);
  });
});

describe('who pays, and who may press', () => {
  it("the tenant is the organisation owning the project; a caller's organisation id is ignored", async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx, { todo: null });
    const client = stubClient();
    const actor = { ...fx.ctx, organizationId: 'org-from-the-request' } as ServiceContext;
    await press(item.id, actor, depsWith(client));
    expect(client.calls[0]!.tenant).toMatchObject({
      organizationId: fx.workspace.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
    expect(client.calls[0]!.actor).toEqual({ userId: fx.ownerId });
  });

  it('a caller who cannot open the item gets not-found and nothing is sent', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await seed(fx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const stranger = await createTestUser();
    const client = stubClient();
    await expect(press(item.id, other.ctx, depsWith(client))).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
    await expect(
      press(item.id, { userId: stranger.id, workspaceId: fx.workspaceId }, depsWith(client)),
    ).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });
});
