import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestTranslationInput } from '@/lib/ai/translateClient';
import type { TranslateResult } from '@/lib/ai/translate';
import { db } from '@/lib/db';
import {
  defaultTitleDoorDeps,
  defaultTranslationDoorDeps,
  workItemTranslationService,
  translateTitlesForReader,
  type TitleDoorDeps,
} from '@/lib/services/workItemTranslationService';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE MANY-TITLES DOOR (Story MOTIR-7738 · Subtask MOTIR-8829) against a REAL
// database: the real store, the real advisory locks, the real item read and
// browse gate, the real tenant resolution. Only `requestTranslation` — the
// motir-ai call — is a stub, and what these tests count is its CALLS: one call is
// one charge, so "exactly one call" is the no-double-billing assertion here.

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

const depsWith = (client: Stub): TitleDoorDeps => ({
  ...defaultTitleDoorDeps,
  requestTranslation: client,
});

async function enable(fx: WorkItemFixture, on = true) {
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { autoTranslateWorkContent: on },
  });
}

async function seedTitle(fx: WorkItemFixture, title: string, lang: string | null = 'de') {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({ where: { id: item.id }, data: { titleLanguage: lang } });
  return item;
}

const ask = (fx: WorkItemFixture, ids: string[], deps: TitleDoorDeps) =>
  translateTitlesForReader(
    { projectId: fx.projectId, workItemIds: ids, targetLanguage: 'en', actor: fx.ctx },
    deps,
  );

const rowCount = () => adminDb.workItemTranslation.count();

describe('a batch over German titles', () => {
  it('sends them in ONE call under their own refs and keeps each on its own item', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    const b = await seedTitle(fx, 'Den Import bauen');
    const client = stubClient();
    const r = await ask(fx, [a.id, b.id], depsWith(client));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.fields.map((f) => f.fieldRef)).toEqual([
      fieldRef.titleForItem(a.id),
      fieldRef.titleForItem(b.id),
    ]);
    expect(r.enabled).toBe(true);
    expect(r.titles.map((t) => t.status)).toEqual(['ready', 'ready']);
    expect(await rowCount()).toBe(2);
    const rows = await adminDb.workItemTranslation.findMany({ orderBy: { workItemId: 'asc' } });
    expect(rows.every((row) => row.fieldRef === 'title')).toBe(true);
    expect(new Set(rows.map((row) => row.workItemId))).toEqual(new Set([a.id, b.id]));
  });

  it('a second batch makes ZERO calls and answers the same texts', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    const first = await ask(fx, [a.id], depsWith(stubClient()));
    const client = stubClient();
    expect(await ask(fx, [a.id], depsWith(client))).toEqual(first);
    expect(client.calls).toHaveLength(0);
  });

  it('the item-page press is served the batch row free, and the batch the press row', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    await ask(fx, [a.id], depsWith(stubClient()));
    const client = stubClient();
    const press = await workItemTranslationService.translateWorkItem(
      { workItemId: a.id, targetLanguage: 'en', actor: fx.ctx },
      { ...defaultTranslationDoorDeps, requestTranslation: client },
    );
    expect(client.calls).toHaveLength(0);
    expect(press.find((r) => r.fieldRef === 'title')).toMatchObject({ status: 'ready' });
  });

  it('after one title is edited only that title is re-sent', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    const b = await seedTitle(fx, 'Den Import bauen');
    await ask(fx, [a.id, b.id], depsWith(stubClient()));
    await adminDb.workItem.update({ where: { id: a.id }, data: { title: 'Den Abgleich bauen' } });
    const client = stubClient();
    const r = await ask(fx, [a.id, b.id], depsWith(client));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.fields).toEqual([
      { fieldRef: fieldRef.titleForItem(a.id), text: 'Den Abgleich bauen' },
    ]);
    expect(r.titles.every((t) => t.status === 'ready')).toBe(true);
    expect(await rowCount()).toBe(2);
  });

  it('a batch and a press for the same title make ONE call between them', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    await adminDb.workItem.update({
      where: { id: a.id },
      data: { descriptionMd: null, explanationMd: null },
    });
    const slow = stubClient(async (input) => {
      await new Promise((res) => setTimeout(res, 400));
      return {
        status: 'ok',
        translations: input.fields.map((f) => ({ fieldRef: f.fieldRef, text: `EN ${f.text}` })),
      };
    });
    await Promise.all([
      ask(fx, [a.id], depsWith(slow)),
      workItemTranslationService.translateWorkItem(
        { workItemId: a.id, targetLanguage: 'en', actor: fx.ctx },
        { ...defaultTranslationDoorDeps, requestTranslation: slow },
      ),
    ]);
    expect(slow.calls).toHaveLength(1);
    expect(await rowCount()).toBe(1);
  });

  it.each(['no_credit', 'timeout'] as const)('keeps no row when the job answers %s', async (s) => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    const r = await ask(fx, [a.id], depsWith(stubClient(() => ({ status: s }))));
    expect(r.titles[0]).toMatchObject({ status: s });
    expect(await rowCount()).toBe(0);
  });
});

describe('the switch and the gate', () => {
  it('with the switch off answers enabled:false, calls nobody and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const a = await seedTitle(fx, 'Den Export bauen');
    const client = stubClient();
    const r = await ask(fx, [a.id], depsWith(client));
    expect(r).toEqual({ enabled: false, truncated: false, titles: [] });
    expect(client.calls).toHaveLength(0);
    expect(await rowCount()).toBe(0);
  });

  it('turning the switch off stops the very next batch from spending', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const a = await seedTitle(fx, 'Den Export bauen');
    await enable(fx, false);
    const client = stubClient();
    expect((await ask(fx, [a.id], depsWith(client))).enabled).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a project in another workspace before anything is read or sent', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await enable(theirs);
    const client = stubClient();
    await expect(
      translateTitlesForReader(
        {
          projectId: theirs.projectId,
          workItemIds: [],
          targetLanguage: 'en',
          actor: mine.ctx,
        },
        depsWith(client),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(client.calls).toHaveLength(0);
  });

  it('omits ids from another project, another workspace, or that do not exist', async () => {
    const fx = await makeWorkItemFixture();
    await enable(fx);
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'TWO',
    });
    const foreign = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const mineItem = await seedTitle(fx, 'Den Export bauen');
    const sibling = await createTestWorkItem(
      { ...fx, projectId: other.id, projectIdentifier: other.identifier },
      { kind: 'task', title: 'Den Import bauen' },
    );
    await adminDb.workItem.update({ where: { id: sibling.id }, data: { titleLanguage: 'de' } });
    const theirs = await seedTitle(foreign, 'Den Abgleich bauen');
    const client = stubClient();
    const r = await ask(fx, [theirs.id, sibling.id, 'nope', mineItem.id], depsWith(client));
    expect(r.titles.map((t) => t.workItemId)).toEqual([mineItem.id]);
    expect(client.calls[0]!.fields).toHaveLength(1);
  });
});
