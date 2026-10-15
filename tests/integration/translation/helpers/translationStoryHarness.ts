import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { POST as translateRoute } from '@/app/api/work-items/[id]/translate/route';
import { GET as usageRoute } from '@/app/api/organizations/[orgId]/usage/route';
import { GET as restRead } from '@/app/api/v1/work-items/[key]/route';
import { GET as dispatchRead } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import { TRANSLATE_DEADLINE_MS } from '@/lib/ai/translateClient';
import { db } from '@/lib/db';
import type { TranslateResponseDTO } from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import { buildMcpServer } from '@/lib/mcp/registry';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemTranslationReadService } from '@/lib/services/workItemTranslationReadService';
import { assembleFields } from '@/lib/services/workItemTranslationService';
import { workItemTranslationStoreService } from '@/lib/services/workItemTranslationStoreService';
import { workItemsService } from '@/lib/services/workItemsService';
import { fieldRef } from '@/lib/translation/fieldRefs';
import type { WorkspaceContext } from '@/lib/workspaces';
import { createV1ProjectCaller } from '../../../fixtures/apiV1Fixtures';
import { adminDb } from '../../../helpers/adminDb';
import { truncateAuthTables } from '../../../helpers/db';
import {
  ZH,
  installMotirAi,
  memberOf,
  readerScope,
  resetJobs,
  script,
  seedChineseItem,
  sessionUser,
  translateSubmits,
  type MotirAiSeam,
  type Reader,
} from './translationStoryFixture';

// The story test's harness (Story MOTIR-7735 · MOTIR-8124): the real routes and
// reads the cases drive, and the lifecycle both story files share. The test
// FILES own the `vi.mock`s (they must be hoisted there); everything they reach
// is imported here, after those mocks are in place.

const BASE = 'http://localhost:3000';

export interface Story {
  caller: Awaited<ReturnType<typeof createV1ProjectCaller>>;
  itemId: string;
  key: string;
  refs: string[];
  owner: Reader;
}

/** Install the motir-ai seam once; start every case on an empty tenant and job record. */
export function registerStorySeam(): () => MotirAiSeam {
  let seam: MotirAiSeam;
  beforeAll(async () => {
    seam = await installMotirAi();
  });
  beforeEach(async () => {
    await truncateAuthTables();
    resetJobs(seam);
    sessionUser.current = null;
  });
  afterAll(async () => {
    await truncateAuthTables();
    expect(await adminDb.workItemTranslation.count()).toBe(0);
    vi.unstubAllEnvs();
    await seam.agent.close();
    await db.$disconnect();
    await adminDb.$disconnect();
  });
  return () => seam;
}

/** A fresh tenant holding the Chinese item, its owner reading in German. */
export async function story(): Promise<Story> {
  const caller = await createV1ProjectCaller({ scopes: ['read'] });
  const { item, todoIds } = await seedChineseItem(caller.fixture);
  const refs = [
    fieldRef.title(),
    fieldRef.description(),
    fieldRef.explanation(),
    ...todoIds.flatMap((id) => [fieldRef.todoText(id), fieldRef.todoNotes(id)]),
  ];
  const owner = { ctx: caller.ctx as WorkspaceContext, locale: 'de' as Locale };
  return { caller, itemId: item.id, key: item.identifier, refs, owner };
}

/** Another member of the story's organisation, reading in `locale`. */
export async function reader(s: Story, email: string, locale: Locale): Promise<Reader> {
  return { ctx: await memberOf(s.caller.fixture, email), locale };
}

/** One press, by `reader`, through the real route. */
export async function press(reader: Reader, itemId: string, body?: unknown, query = '') {
  return readerScope.run(reader, async () => {
    const res = await translateRoute(
      new Request(`${BASE}/api/work-items/${itemId}/translate${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: itemId }) },
    );
    return { status: res.status, body: (await res.json()) as TranslateResponseDTO };
  });
}

/** `[de] 标题`-style texts, as the mock's default success echoes them. */
export const echoed = (lang: string, text: string) => `[${lang}] ${text}`;

/** The item's seven source texts, in the order of {@link Story.refs}. */
export const SOURCE_TEXTS: readonly string[] = [
  ZH.title,
  ZH.description,
  ZH.explanation,
  ...ZH.todos.flatMap((t) => [t.text, t.notes]),
];

export const ready = (refs: string[], lang: string, texts: readonly string[] = SOURCE_TEXTS) =>
  refs.map((ref, i) => ({ fieldRef: ref, status: 'ready', text: echoed(lang, texts[i]!) }));

export const statuses = (body: TranslateResponseDTO) =>
  Object.fromEntries(body.fields.map((f) => [f.fieldRef, f.status]));

export const rows = (where: { targetLanguage?: string; fieldRef?: string } = {}) =>
  adminDb.workItemTranslation.findMany({ where, orderBy: { fieldRef: 'asc' } });

/** The page offer `reader` would be served. */
export async function offerFor(reader: Reader, itemId: string) {
  const workItem = await workItemsService.getWorkItem(itemId, reader.ctx);
  const { items: todos } = await workItemTodosService.listTodos(itemId, reader.ctx);
  return workItemTranslationReadService.getTranslationOffer({
    workItem,
    todos,
    readerLocale: reader.locale,
    ctx: reader.ctx,
  });
}

/** Keep a German translation of `refs` directly in the store, as an earlier press would have. */
export async function keepGerman(s: Story, refs: string[]): Promise<void> {
  const item = await workItemsService.getWorkItem(s.itemId, s.caller.ctx);
  const { items: todos } = await workItemTodosService.listTodos(s.itemId, s.caller.ctx);
  for (const f of assembleFields(item, todos).filter((x) => refs.includes(x.fieldRef))) {
    await workItemTranslationStoreService.keep(
      { id: s.itemId },
      f,
      'de',
      echoed('de', f.text),
      s.caller.ctx,
    );
  }
}

export const EDITED = '导出需要包含所有字段，按日期和客户排序。';

/** Edit the description through the normal item update path. */
export async function editDescription(s: Story): Promise<void> {
  await workItemsService.updateWorkItem(s.itemId, { descriptionMd: EDITED }, s.caller.ctx);
}

// ── holding a job open ───────────────────────────────────────────────────────

/** Resolves on the next `translate` submit — after the mock has recorded it. */
export function nextSubmit(seam: MotirAiSeam): Promise<void> {
  const seen = translateSubmits(seam).length;
  return vi.waitFor(
    () => {
      if (translateSubmits(seam).length <= seen) throw new Error('no translate submit yet');
    },
    { timeout: 20_000, interval: 20 },
  );
}

/** How many backends are waiting on an advisory lock right now. */
export async function lockWaiters(): Promise<number> {
  const r = await adminDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
  return Number(r[0]!.n);
}

/** Let the held job (the mock's `running`) settle as a success. */
export function release(seam: MotirAiSeam): void {
  script(seam, [{ status: 'succeeded' }]);
}

/**
 * A press whose job never settles, with the clock moved past the door's 45 s
 * deadline the moment the job is submitted — no 45 s wait, and only the one
 * transaction open then (the lock's, whose own limit is longer) sees the jump.
 */
export async function pressPastTheDeadline(seam: MotirAiSeam, r: Reader, itemId: string) {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  try {
    const submitted = nextSubmit(seam);
    const res = press(r, itemId);
    await submitted;
    offset = TRANSLATE_DEADLINE_MS + 1_000;
    return await res;
  } finally {
    clock.mockRestore();
  }
}

// ── the usage route and the agent-facing reads ───────────────────────────────

/** `GET /api/organizations/[orgId]/usage` as the organisation's owner. */
export async function usageJson(s: Story) {
  const owner = s.caller.fixture.owner;
  sessionUser.current = { id: owner.id, email: owner.email };
  const orgId = s.caller.fixture.workspace.organizationId;
  const res = await usageRoute(new Request(`${BASE}/api/organizations/${orgId}/usage`), {
    params: Promise.resolve({ orgId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { totalSpend: number; translation: unknown };
}

export async function mcpClient(s: Story): Promise<Client> {
  const server = buildMcpServer(() => s.caller.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'translation-story-agent', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** The three agent-facing reads, serialised as the wire carries them. */
export async function agentReads(s: Story, client: Client) {
  const init = { headers: s.caller.headers };
  const params = () => ({ params: Promise.resolve({ key: s.key }) });
  const rest = await restRead(new Request(`${BASE}/api/v1/work-items/${s.key}`, init), params());
  const dispatch = await dispatchRead(
    new Request(`${BASE}/api/v1/work-items/${s.key}/dispatch-prompt`, init),
    params(),
  );
  const mcp = (await client.callTool({
    name: 'get_work_item',
    arguments: { key: s.key },
  })) as CallToolResult;
  expect([rest.status, dispatch.status, mcp.isError ?? false]).toEqual([200, 200, false]);
  return {
    rest: JSON.stringify(await rest.json()),
    dispatch: JSON.stringify(await dispatch.json()),
    mcp: JSON.stringify(mcp.structuredContent),
  };
}
