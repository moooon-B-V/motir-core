import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// `search_work_items_semantic` (Story MOTIR-3098 · Subtask MOTIR-3101) over real
// Postgres + real pgvector — the HAS-THIS-SHIPPED gate an agent can answer.
//
// ⚠️ ONE SEAM IS STUBBED, and it is the same one `semanticSearchStoryGate.test.ts`
// stubs for the same reason: `embedTexts` is the motir-ai boundary, there is no
// gateway in tests, and `docs/decisions/plan-tree-embeddings.md` §6.2 says this
// repo stores vectors and does not produce them — so the provider call is the
// only place a vector can enter. Postgres, pgvector, the ranking, the RLS
// policies, the service and the MCP transport are all real.
//
// The assertions, in order of what would hurt most if it broke:
//  1. THE FOUR OUTCOMES STAY APART. `ranked` / `nothing-similar` / `not-indexed`
//     / `unavailable` are four different things an empty `results` array can
//     mean, and an agent that reads the wrong one re-creates MOTIR-3079 — a
//     capability rebuilt because the search that should have found it could not.
//     This is the file's most explicit assertion and it is asserted on the
//     PAYLOAD, not on prose.
//  2. §2 — KEYS, TITLES AND SCORES, NEVER PROSE. Asserted on the SHAPE (the
//     absence of the body keys), because the invariant is structural: a
//     substring check over the rendered text would pass against a payload that
//     carried `descriptionMd` in a field nobody rendered.
//  3. TENANCY. Another workspace's key is a plain not-found, and the refusal
//     lands BEFORE the embed so a caller who may not browse cannot spend the
//     deployment's gateway budget.
//  4. THE ARGUMENT SHAPE IS AMENDMENT 2's. Text in; no `model`, no
//     `queryEmbedding`. Option A's arguments are absent BY DECISION, and a
//     later widening should have to delete an assertion.

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  embedTexts: vi.fn(),
}));

import { db } from '@/lib/db';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME } from '@/lib/mcp/tools/searchWorkItemsSemantic';
import { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';
import type { SemanticSearchResponse } from '@/lib/dto/ai';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const MODEL = 'text-embedding-3-small';
const TARGET_TITLE = 'Board columns remember their collapsed state';
const TARGET_BODY =
  'The board persists each column’s collapsed/expanded state per user so it survives a reload. ' +
  'THIS PROSE MUST NEVER CROSS THE BOUNDARY — ADR §2 forbids the surface to carry a body.';
const DECOY_TITLE = 'Rotate the signing key on a schedule';
const QUERY = 'persist UI preferences';

/** A unit vector along one axis — every distance below is then arithmetic. */
function oneHot(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

let seq = 0;

/** Seed a work item and (optionally) its vector directly — the pinned-ranking
 *  pattern `similarWorkItemsRoute.test.ts` established, for the same reason:
 *  the expected order must be arithmetic, not a property of a live model. */
async function seedItem(input: {
  fx: WorkItemFixture;
  title: string;
  descriptionMd?: string | null;
  embedding?: number[];
}): Promise<string> {
  seq += 1;
  const id = `sem-${seq.toString().padStart(5, '0')}`;
  await adminDb.$executeRawUnsafe(
    `INSERT INTO "work_item"
       ("id","workspaceId","projectId","kind","key","identifier","title","descriptionMd",
        "reporterId","position","status","priority","createdAt","updatedAt")
     VALUES ($1,$2,$3,'task',$4,$5,$6,$7,$8,$9,'todo','medium',now(),now())`,
    id,
    input.fx.workspaceId,
    input.fx.projectId,
    seq,
    `${input.fx.projectIdentifier}-${seq}`,
    input.title,
    input.descriptionMd ?? null,
    input.fx.ownerId,
    `a${seq.toString().padStart(5, '0')}`,
  );
  if (input.embedding) {
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item_embedding"
         ("work_item_id","workspace_id","project_id","model","dimensions","content_hash",
          "embedded_at","embedding")
       VALUES ($1,$2,$3,$4,${EMBEDDING_DIMENSIONS},$5,now(),$6::vector)`,
      id,
      input.fx.workspaceId,
      input.fx.projectId,
      MODEL,
      `hash-${id}`,
      `[${input.embedding.join(',')}]`,
    );
  }
  return id;
}

async function callSemantic(
  ctx: ServiceContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'semantic-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function payloadOf(res: CallToolResult): SemanticSearchResponse {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as unknown as SemanticSearchResponse;
}

function textOf(res: CallToolResult): string {
  return (res.content as { type: string; text: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_embedding", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    embeddings: input.map(() => oneHot(0)),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('search_work_items_semantic — the has-this-shipped gate', () => {
  it('RANKS by meaning and carries keys, titles and scores — and NO prose (ADR §2)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    await seedItem({
      fx,
      title: TARGET_TITLE,
      descriptionMd: TARGET_BODY,
      embedding: oneHot(0),
    });
    await seedItem({ fx, title: DECOY_TITLE, embedding: oneHot(1) });

    const res = await callSemantic(fx.ctx, { projectKey: 'ACME', query: QUERY });
    const payload = payloadOf(res);

    expect(payload.outcome).toBe('ranked');
    expect(payload.model).toBe(MODEL);
    expect(payload.results[0]?.title).toBe(TARGET_TITLE);
    expect(payload.results[0]?.score).toBeCloseTo(1, 5);
    expect(payload.coverage).toEqual({ embedded: 2, total: 2 });

    // §2 asserted on the SHAPE. `toHaveProperty` on a key nobody rendered is what
    // a substring check over the text block would have missed.
    for (const row of payload.results) {
      expect(Object.keys(row).sort()).toEqual(['key', 'score', 'title']);
    }
    // …and belt-and-braces on the wire, since the body was seeded on purpose.
    expect(JSON.stringify(payload)).not.toContain('MUST NEVER CROSS THE BOUNDARY');
    expect(textOf(res)).not.toContain('MUST NEVER CROSS THE BOUNDARY');
  });

  it('"nothing similar" and "could not tell" are DIFFERENT states in the payload', async () => {
    // (a) INDEXED, and nothing is close — a real answer.
    const indexed = await makeWorkItemFixture({ name: 'Indexed', identifier: 'AAA' });
    await seedItem({ fx: indexed, title: DECOY_TITLE, embedding: oneHot(1) });
    const answered = payloadOf(
      await callSemantic(indexed.ctx, { projectKey: 'AAA', query: QUERY, minScore: 0.5 }),
    );

    expect(answered.outcome).toBe('nothing-similar');
    expect(answered.results).toEqual([]);
    expect(answered.coverage).toEqual({ embedded: 1, total: 1 });

    // (b) NOT indexed — the same empty array, and it means the opposite.
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BBB' });
    await seedItem({ fx: bare, title: TARGET_TITLE });
    const unanswerable = payloadOf(
      await callSemantic(bare.ctx, { projectKey: 'BBB', query: QUERY }),
    );

    expect(unanswerable.outcome).toBe('not-indexed');
    expect(unanswerable.results).toEqual([]);
    expect(unanswerable.coverage).toEqual({ embedded: 0, total: 1 });

    // The discriminator is the point: two identical result sets, two verdicts.
    expect(answered.results).toEqual(unanswerable.results);
    expect(answered.outcome).not.toBe(unanswerable.outcome);
    expect(unanswerable.message).toMatch(/NOT evidence/);
  });

  it('an UNREACHABLE embedding backend is a readable non-answer, never an empty ranking', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    await seedItem({ fx, title: TARGET_TITLE, embedding: oneHot(0) });
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const res = await callSemantic(fx.ctx, { projectKey: 'ACME', query: QUERY });
    const payload = payloadOf(res);

    // A SUCCESS result — §6.1's "degradation is a 200, never a 5xx" — that still
    // says the search did not happen.
    expect(res.isError).toBeFalsy();
    expect(payload.outcome).toBe('unavailable');
    expect(payload.results).toEqual([]);
    // `coverage` is null, not `{ embedded: 0, total: 0 }`: nothing was counted,
    // and reporting zeroes would be indistinguishable from a degraded read.
    expect(payload.coverage).toBeNull();
    expect(payload.model).toBeNull();
    expect(payload.message).toMatch(/NOT evidence/);
    expect(textOf(res)).toMatch(/search_work_items/);
  });

  it('an UNCONFIGURED deployment (no AI backend) is the same non-answer, without a call', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    vi.stubEnv('MOTIR_AI_URL', '');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');

    const payload = payloadOf(await callSemantic(fx.ctx, { projectKey: 'ACME', query: QUERY }));

    expect(payload.outcome).toBe('unavailable');
    // Open-core with no AI backend must not even attempt the call.
    expect(vi.mocked(embedTexts)).not.toHaveBeenCalled();
  });

  it("another workspace's key is NOT-FOUND — and the refusal lands BEFORE the embed", async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'ACME' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'ZZZ' });
    await seedItem({ fx: theirs, title: TARGET_TITLE, embedding: oneHot(0) });

    const res = await callSemantic(mine.ctx, { projectKey: 'ZZZ', query: QUERY });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/NOT_FOUND/);
    expect(textOf(res)).not.toContain(TARGET_TITLE);
    expect(res.structuredContent).toBeUndefined();
    // The gate is BEFORE the spend: a caller who may not browse the project must
    // not be able to draw down the deployment's gateway budget on a refusal.
    expect(vi.mocked(embedTexts)).not.toHaveBeenCalled();
  });

  it('takes TEXT and refuses Option A’s arguments — no model, no vector (Amendment 2)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const server = buildMcpServer(() => fx.ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'semantic-schema', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME,
      );
      const props = Object.keys(
        (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      // The published contract. Widening it back to Option A should have to
      // delete this line, with the amendment in front of whoever does.
      expect(props).toEqual(['limit', 'minScore', 'projectKey', 'query']);
      expect(tool?.description).toMatch(/COSTS AN AI CALL/);
    } finally {
      await client.close();
    }
  });

  it('is registered beside — never over — the substring search, and gated on project:browse', () => {
    expect(MCP_TOOL_NAMES).toContain(SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain('search_work_items');
    expect(TOOL_PERMISSIONS[SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME]).toBe('project:browse');
  });
});
