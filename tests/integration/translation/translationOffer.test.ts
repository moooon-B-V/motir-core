import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GET as dispatchPromptRoute } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import { GET as getWorkItemRoute } from '@/app/api/v1/work-items/[key]/route';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemTranslationReadService } from '@/lib/services/workItemTranslationReadService';
import { assembleFields } from '@/lib/services/workItemTranslationService';
import { workItemTranslationStoreService } from '@/lib/services/workItemTranslationStoreService';
import { workItemsService } from '@/lib/services/workItemsService';
import { hashFieldText } from '@/lib/translation/fieldRevision';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE PAGE-READ OFFER and the AGENT-FACING READS against a real database (Story
// MOTIR-7735 · Subtask MOTIR-8121).
//
//   1. `kept` is a fact about the CURRENT text: a one-character edit to one
//      field makes the next offer say `kept: false` for it and leaves the
//      untouched fields `kept: true`. Nothing caches a classification.
//   2. Keeping translations changes NOTHING an agent reads. The MCP's
//      `get_work_item`, the REST work-item read and the dispatch prompt return
//      the same payload before and after the kept rows exist, and that payload
//      carries the stored original word for word.

const BASE = 'http://localhost:3000/api/v1';
const TITLE = 'Den Export für alle Kunden bauen';
const DESCRIPTION = 'Die Beschreibung des Exports';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A task whose title and description are recorded German. */
async function seedGermanItem(caller: V1ProjectCaller) {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title: TITLE },
    caller.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { descriptionMd: DESCRIPTION, titleLanguage: 'de', descriptionLanguage: 'de' },
  });
  return item;
}

/** Keep an English translation of every field of the item that has text. */
async function keepEverything(itemId: string, ctx: ServiceContext) {
  const item = await workItemsService.getWorkItem(itemId, ctx);
  const { items: todos } = await workItemTodosService.listTodos(itemId, ctx);
  for (const field of assembleFields(item, todos)) {
    if (!field.text.trim()) continue;
    await workItemTranslationStoreService.keep(
      { id: itemId },
      field,
      'en',
      `[en] ${field.text}`,
      ctx,
    );
  }
}

async function offerFor(itemId: string, ctx: ServiceContext) {
  const workItem = await workItemsService.getWorkItem(itemId, ctx);
  const { items: todos } = await workItemTodosService.listTodos(itemId, ctx);
  return workItemTranslationReadService.getTranslationOffer({
    workItem,
    todos,
    readerLocale: 'en',
    ctx,
  });
}

describe('the offer reads the current text', () => {
  it('a one-character edit flips kept to false for that field only', async () => {
    const caller = await createV1ProjectCaller();
    const item = await seedGermanItem(caller);

    const before = await offerFor(item.id, caller.ctx);
    expect(before.fields.title!.kept).toBe(false);

    await keepEverything(item.id, caller.ctx);
    const kept = await offerFor(item.id, caller.ctx);
    expect(kept.fields.title).toEqual({
      needsTranslation: true,
      kept: true,
      sourceLanguage: 'de',
      revision: hashFieldText(TITLE),
    });
    expect(kept.fields.description!.kept).toBe(true);

    await adminDb.workItem.update({ where: { id: item.id }, data: { title: `${TITLE}!` } });
    const edited = await offerFor(item.id, caller.ctx);
    expect(edited.fields.title).toEqual({
      needsTranslation: true,
      kept: false,
      sourceLanguage: 'de',
      revision: hashFieldText(`${TITLE}!`),
    });
    expect(edited.fields.description!.kept).toBe(true);
    // The revision (MOTIR-8123) moved for the edited field ONLY.
    for (const [ref, f] of Object.entries(edited.fields)) {
      if (ref === 'title') expect(f.revision).not.toBe(kept.fields.title!.revision);
      else expect(f.revision, ref).toBe(kept.fields[ref]!.revision);
    }
  });
});

// ── the agent-facing doors ───────────────────────────────────────────────────

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'translation-offer-agent-reads', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** The three agent-facing reads of one item, as the wire carries them. */
async function agentReads(caller: V1ProjectCaller, client: Client, key: string) {
  const rest = await getWorkItemRoute(
    new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
  expect(rest.status).toBe(200);
  const dispatch = await dispatchPromptRoute(
    new Request(`${BASE}/work-items/${key}/dispatch-prompt`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
  expect(dispatch.status).toBe(200);
  const mcp = (await client.callTool({
    name: 'get_work_item',
    arguments: { key },
  })) as CallToolResult;
  expect(mcp.isError).toBeFalsy();
  return {
    rest: (await rest.json()) as unknown,
    dispatch: (await dispatch.json()) as unknown,
    mcp: mcp.structuredContent as unknown,
  };
}

describe('kept translations reach no agent-facing read', () => {
  it('get_work_item, the REST read and the dispatch prompt are unchanged and carry the original', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const client = await connect(caller.ctx);
    const item = await seedGermanItem(caller);

    const before = await agentReads(caller, client, item.identifier);
    await keepEverything(item.id, caller.ctx);
    expect(await adminDb.workItemTranslation.count()).toBe(2);
    const after = await agentReads(caller, client, item.identifier);

    expect(after).toEqual(before);
    // Each door carries the stored original, word for word.
    for (const door of [after.rest, after.mcp, after.dispatch]) {
      expect(JSON.stringify(door)).toContain(JSON.stringify(TITLE).slice(1, -1));
      expect(JSON.stringify(door)).toContain(JSON.stringify(DESCRIPTION).slice(1, -1));
    }
    expect(JSON.stringify(after)).not.toContain('[en]');
  });
});
