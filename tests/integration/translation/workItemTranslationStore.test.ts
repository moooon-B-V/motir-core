import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemTranslationStoreService as store } from '@/lib/services/workItemTranslationStoreService';
import {
  EmptyTranslationTextError,
  UnsupportedTargetLanguageError,
} from '@/lib/translation/errors';
import { fieldRef, hashFieldText, type TranslatableField } from '@/lib/translation/fieldRevision';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// The kept-translation store (Story MOTIR-7735 · Subtask MOTIR-8114), against a
// real database: the staleness rule, sharing, concurrency, supersession,
// cascade, tenant isolation under the non-bypass role, and the pure helpers.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const title = (text: string): TranslatableField => ({ fieldRef: fieldRef.title(), text });
const description = (text: string): TranslatableField => ({
  fieldRef: fieldRef.description(),
  text,
});

async function itemIn(fx: WorkItemFixture, name = 'Ship the export') {
  return createTestWorkItem(fx, { kind: 'task', title: name });
}

/** The CI database role bypasses RLS; this runs `fn` as the app role, bound. */
async function asAppRole<T>(
  ctx: { userId: string; workspaceId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.project_id', '', true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('the pure helpers', () => {
  it('hashFieldText is deterministic sha256 as 64 lowercase hex characters', () => {
    const a = hashFieldText('Ship the export');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFieldText('Ship the export')).toBe(a);
    expect(hashFieldText('Ship the export!')).not.toBe(a);
    expect(hashFieldText('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('the fieldRef builders return exactly the five forms', () => {
    expect([
      fieldRef.title(),
      fieldRef.description(),
      fieldRef.explanation(),
      fieldRef.todoText('t1'),
      fieldRef.todoNotes('t1'),
    ]).toEqual(['title', 'description', 'explanation', 'todo:t1:text', 'todo:t1:notes']);
  });
});

describe('the staleness rule', () => {
  it('serves a kept translation only for the exact current text of its field', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    await store.keep(item, title('Ship the export'), 'de', 'Den Export ausliefern', fx.ctx);
    await store.keep(item, description('Body text'), 'de', 'Fließtext', fx.ctx);

    expect(
      await store.getKept(item, [title('Ship the export'), description('Body text')], 'de', fx.ctx),
    ).toEqual({ title: 'Den Export ausliefern', description: 'Fließtext' });

    // One character changed in the title: the title is stale, the description is not.
    expect(
      await store.getKept(
        item,
        [title('Ship the export.'), description('Body text')],
        'de',
        fx.ctx,
      ),
    ).toEqual({ description: 'Fließtext' });
  });

  it('a translation for de is not served for fr, nor for another item with identical text', async () => {
    const fx = await makeWorkItemFixture();
    const a = await itemIn(fx, 'Same words');
    const b = await itemIn(fx, 'Same words');
    await store.keep(a, title('Same words'), 'de', 'Gleiche Wörter', fx.ctx);

    expect(await store.getKept(a, [title('Same words')], 'fr', fx.ctx)).toEqual({});
    expect(await store.getKept(b, [title('Same words')], 'de', fx.ctx)).toEqual({});
    expect(await store.getKept(a, [title('Same words')], 'de', fx.ctx)).toEqual({
      title: 'Gleiche Wörter',
    });
  });

  it('two readers in one organisation read the same row; no reader is in the key', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    await store.keep(item, title('Ship the export'), 'ja', 'エクスポートを出荷', fx.ctx);
    const other = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: other.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });

    const second = await store.getKept(item, [title('Ship the export')], 'ja', {
      userId: other.id,
      workspaceId: fx.workspaceId,
    });
    expect(second).toEqual({ title: 'エクスポートを出荷' });
    const rows = await adminDb.workItemTranslation.findMany({ where: { workItemId: item.id } });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).some((k) => /user/i.test(k))).toBe(false);
    expect(rows[0]!.organizationId).toBe(fx.workspace.organizationId);
  });
});

describe('writes', () => {
  it('two concurrent keeps for one key leave one row and both return its text', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    const [x, y] = await Promise.all([
      store.keep(item, title('Ship the export'), 'fr', 'Livrer l’export (A)', fx.ctx),
      store.keep(item, title('Ship the export'), 'fr', 'Livrer l’export (B)', fx.ctx),
    ]);
    const rows = await adminDb.workItemTranslation.findMany({ where: { workItemId: item.id } });
    expect(rows).toHaveLength(1);
    expect(x.translatedText).toBe(rows[0]!.translatedText);
    expect(y.translatedText).toBe(rows[0]!.translatedText);
  });

  it('keeping a new revision removes only that field’s other revisions in that language', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    await store.keep(item, title('v1'), 'de', 'v1-de', fx.ctx);
    await store.keep(item, title('v1'), 'fr', 'v1-fr', fx.ctx);
    await store.keep(item, description('body'), 'de', 'body-de', fx.ctx);

    await store.keep(item, title('v2'), 'de', 'v2-de', fx.ctx);

    const rows = await adminDb.workItemTranslation.findMany({
      where: { workItemId: item.id },
      orderBy: [{ fieldRef: 'asc' }, { targetLanguage: 'asc' }],
    });
    expect(rows.map((r) => [r.fieldRef, r.targetLanguage, r.translatedText])).toEqual([
      ['description', 'de', 'body-de'],
      ['title', 'de', 'v2-de'],
      ['title', 'fr', 'v1-fr'],
    ]);
  });

  it('empty and whitespace-only text is neither stored nor returned', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    await expect(store.keep(item, description('   \n'), 'de', 'x', fx.ctx)).rejects.toBeInstanceOf(
      EmptyTranslationTextError,
    );
    await expect(store.keep(item, title('Real'), 'de', '  ', fx.ctx)).rejects.toBeInstanceOf(
      EmptyTranslationTextError,
    );
    expect(await adminDb.workItemTranslation.count()).toBe(0);
    expect(await store.getKept(item, [description(''), title(' ')], 'de', fx.ctx)).toEqual({});
  });

  it('refuses a target language outside the eleven locales', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    await expect(store.keep(item, title('Real'), 'sv', 'Riktig', fx.ctx)).rejects.toBeInstanceOf(
      UnsupportedTargetLanguageError,
    );
    await expect(store.getKept(item, [title('Real')], 'DE', fx.ctx)).rejects.toBeInstanceOf(
      UnsupportedTargetLanguageError,
    );
  });
});

describe('cascade', () => {
  it('a deleted to-do’s rows are unreachable, and deleting the item removes every row', async () => {
    const fx = await makeWorkItemFixture();
    const item = await itemIn(fx);
    const todo = await adminDb.workItemTodo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        text: 'Write tests',
        position: 'a0',
      },
    });
    const todoText: TranslatableField = { fieldRef: fieldRef.todoText(todo.id), text: todo.text };
    await store.keep(item, todoText, 'de', 'Tests schreiben', fx.ctx);
    await store.keep(item, title('Ship the export'), 'de', 'Den Export ausliefern', fx.ctx);

    await adminDb.workItemTodo.delete({ where: { id: todo.id } });
    // The page no longer carries the to-do, so nothing asks for — or serves — it.
    expect(await store.getKept(item, [title('Ship the export')], 'de', fx.ctx)).toEqual({
      title: 'Den Export ausliefern',
    });

    await adminDb.workItem.delete({ where: { id: item.id } });
    expect(await adminDb.workItemTranslation.count()).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('the service does not find another workspace’s item', async () => {
    const a = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Org B', identifier: 'BBB' });
    const item = await itemIn(a);
    await store.keep(item, title('Ship the export'), 'de', 'Den Export ausliefern', a.ctx);
    await expect(
      store.getKept(item, [title('Ship the export')], 'de', b.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      store.keep(item, title('Ship the export'), 'de', 'Gestohlen', b.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('under the app role, organisation B can neither read nor write A’s rows', async () => {
    const a = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Org B', identifier: 'BBB' });
    expect(a.workspace.organizationId).not.toBe(b.workspace.organizationId);
    const item = await itemIn(a);
    await store.keep(item, title('Ship the export'), 'de', 'Den Export ausliefern', a.ctx);

    const seenByA = await asAppRole(a.ctx, (tx) => tx.workItemTranslation.findMany());
    expect(seenByA).toHaveLength(1);
    const seenByB = await asAppRole(b.ctx, (tx) => tx.workItemTranslation.findMany());
    expect(seenByB).toEqual([]);

    await expect(
      asAppRole(b.ctx, (tx) =>
        tx.workItemTranslation.create({
          data: {
            organizationId: a.workspace.organizationId,
            workspaceId: a.workspaceId,
            workItemId: item.id,
            fieldRef: 'title',
            sourceHash: hashFieldText('Ship the export'),
            targetLanguage: 'fr',
            translatedText: 'Volé',
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const updated = await asAppRole(b.ctx, (tx) =>
      tx.workItemTranslation.updateMany({ data: { translatedText: 'Volé' } }),
    );
    expect(updated.count).toBe(0);
  });
});
