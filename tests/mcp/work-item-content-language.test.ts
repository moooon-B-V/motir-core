import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7731 · MOTIR-8098 — the MCP doors for content language, over the
// in-memory transport so the input schema (a code outside the eleven is a
// refusal) and the declared output schema both run. `create_work_item` /
// `update_work_item` / the to-do tools accept `language` / `languages`, and
// `get_work_item` / `list_work_item_todos` return each field's recorded
// language — `null`, never `en`, when none was recorded. Real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function call(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'content-language-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function ok<T>(res: CallToolResult): T {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as T;
}

async function fixtureIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
  return fx;
}

type Languages = { title: string | null; description: string | null; explanation: string | null };
type WriteResult = { identifier: string; languages: Languages };

async function languagesVia(ctx: ServiceContext, key: string): Promise<Languages> {
  return ok<{ item: { languages: Languages } }>(await call(ctx, 'get_work_item', { key })).item
    .languages;
}

describe('create_work_item / update_work_item / get_work_item', () => {
  it('records an explicit language, and the org language when none is named', async () => {
    const fx = await fixtureIn('ja');
    const explicit = ok<WriteResult>(
      await call(fx.ctx, 'create_work_item', {
        projectKey: 'PROD',
        kind: 'task',
        title: '제목',
        descriptionMd: '본문',
        language: 'ko',
      }),
    );
    expect(explicit.languages).toEqual({ title: 'ko', description: 'ko', explanation: null });
    expect(await languagesVia(fx.ctx, explicit.identifier)).toEqual(explicit.languages);

    const defaulted = ok<WriteResult>(
      await call(fx.ctx, 'create_work_item', {
        projectKey: 'PROD',
        kind: 'task',
        title: 'タイトル',
        descriptionMd: '本文',
      }),
    );
    expect(await languagesVia(fx.ctx, defaulted.identifier)).toEqual({
      title: 'ja',
      description: 'ja',
      explanation: null,
    });
  });

  it('re-records only the field an update edits', async () => {
    const fx = await fixtureIn('ja');
    const { identifier } = ok<WriteResult>(
      await call(fx.ctx, 'create_work_item', { projectKey: 'PROD', kind: 'task', title: 'T' }),
    );
    const updated = ok<WriteResult>(
      await call(fx.ctx, 'update_work_item', {
        key: identifier,
        explanationMd: '왜',
        languages: { explanation: 'ko' },
      }),
    );
    expect(updated.languages).toEqual({ title: 'ja', description: null, explanation: 'ko' });
    expect(await languagesVia(fx.ctx, identifier)).toEqual(updated.languages);
  });

  it('refuses a language alone as an empty patch, and changes nothing', async () => {
    const fx = await fixtureIn('ja');
    const { identifier } = ok<WriteResult>(
      await call(fx.ctx, 'create_work_item', { projectKey: 'PROD', kind: 'task', title: 'T' }),
    );
    const res = await call(fx.ctx, 'update_work_item', { key: identifier, language: 'ko' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('NO_FIELDS_TO_PATCH');
    expect((await languagesVia(fx.ctx, identifier)).title).toBe('ja');
  });

  it('refuses a code outside the eleven and writes nothing', async () => {
    const fx = await fixtureIn('ja');
    const res = await call(fx.ctx, 'create_work_item', {
      projectKey: 'PROD',
      kind: 'task',
      title: 'Svenska',
      language: 'sv',
    });
    expect(res.isError).toBe(true);
    expect(await adminDb.workItem.count({ where: { title: 'Svenska' } })).toBe(0);
  });

  it('reads null — never en — on a row written before content languages', async () => {
    const fx = await fixtureIn('ja');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Old' });
    expect(await languagesVia(fx.ctx, item.identifier)).toEqual({
      title: null,
      description: null,
      explanation: null,
    });
  });
});

describe('the to-do tools', () => {
  type Todo = { id: string; textLanguage: string | null; notesLanguage: string | null };

  it('accept a language, and list each step’s recorded language or null', async () => {
    const fx = await fixtureIn('ja');
    const { identifier: key } = ok<WriteResult>(
      await call(fx.ctx, 'create_work_item', { projectKey: 'PROD', kind: 'task', title: 'T' }),
    );
    const added = ok<{ todo: Todo }>(
      await call(fx.ctx, 'add_work_item_todo', {
        key,
        text: 'Étiqueter',
        notesMd: 'Notes',
        language: 'fr',
      }),
    ).todo;
    expect([added.textLanguage, added.notesLanguage]).toEqual(['fr', 'fr']);
    const second = ok<{ todo: Todo }>(
      await call(fx.ctx, 'add_work_item_todo', { key, text: 'タグ' }),
    ).todo;
    expect([second.textLanguage, second.notesLanguage]).toEqual(['ja', null]);

    const edited = ok<{ todo: Todo }>(
      await call(fx.ctx, 'update_work_item_todo', {
        key,
        todoId: added.id,
        notesMd: 'Notizen',
        languages: { notes: 'de' },
      }),
    ).todo;
    expect([edited.textLanguage, edited.notesLanguage]).toEqual(['fr', 'de']);

    // A step written before content languages reads null on both.
    await adminDb.workItemTodo.update({
      where: { id: second.id },
      data: { textLanguage: null },
    });
    const list = ok<{ items: Todo[] }>(await call(fx.ctx, 'list_work_item_todos', { key }));
    expect(list.items.map((t) => [t.textLanguage, t.notesLanguage])).toEqual([
      ['fr', 'de'],
      [null, null],
    ]);
  });
});
