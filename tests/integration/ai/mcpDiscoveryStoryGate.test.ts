import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// THE STORY-LEVEL GATE for Story MOTIR-3098 (Subtask MOTIR-3102) — *an agent can
// find what ALREADY EXISTS*, asserted over the ASSEMBLED story rather than over
// either tool alone.
//
// ⚠️ WHY THIS IS NOT A COPY OF THE TWO SUBTASK SUITES BESIDE IT. `skeleton.test.ts`
// and `search-work-items-semantic.test.ts` each prove ONE tool against a seeded
// fixture, which is right for a layer test and leaves exactly two things
// unasserted:
//
//   - that the CHAIN joins. Those files seed a vector with admin SQL; nothing
//     drives `createWorkItem → the emitted event → the embedding job → the stored
//     vector → the MCP tool` as one path, so every claim about the story as a
//     whole rests on two halves each proven against a fixture of the other.
//   - that the CONTRAST holds. The story exists because `search_work_items` is a
//     substring predicate and cannot see a card that says the same thing in other
//     words. Two separate passing tests do not assert that; ONE test holding BOTH
//     calls does, and cannot quietly stop being true.
//
// The ONE seam stubbed is `embedTexts` — the motir-ai boundary, exactly as
// `semanticSearchStoryGate.test.ts` stubs it and for the same reason (§6.2: this
// repo stores vectors and does not produce them, so the provider call is the only
// place one can enter). Postgres, pgvector, the HNSW index, the RLS policies, the
// job, both services and the MCP transport are real.
//
// The invariants, in the order MOTIR-3102 states them:
//   1. The two empty-states stay APART.
//   2. Truncation is ANNOUNCED — the flag, not the row count.
//   3. No prose crosses the wire — the payload's SHAPE.
//   4. Semantic beats substring on the known case, in ONE test.
//   5. `search_work_items` is untouched.
//   6. Tenancy, on BOTH tools.
//   7. The degradation path (Amendment 2 chose Option B, so this one binds).

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  embedTexts: vi.fn(),
}));

import { db } from '@/lib/db';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { buildMcpServer } from '@/lib/mcp/registry';
import { SKELETON_TOOL_NAME } from '@/lib/mcp/tools/skeleton';
import { SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME } from '@/lib/mcp/tools/searchWorkItemsSemantic';
import { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemEmbeddingRequested } from '@/lib/jobs/definitions/workItemEmbedding';
import type { WorkItemEmbeddingRequestedData } from '@/lib/jobs/types';
import type { SemanticSearchResponse } from '@/lib/dto/ai';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../../helpers/jobs';

const MODEL = 'text-embedding-3-small';

// ── The story's own fixture pair, named ONCE so every invariant below reads on
// the SAME case the story was written about: the card MOTIR-3079 recorded, and
// the query that could not find it. ──
const TARGET_TITLE = 'Board columns remember their collapsed state';
const TARGET_BODY =
  'The board persists each column’s collapsed/expanded state per user so it survives a reload. ' +
  'THIS PROSE MUST NEVER CROSS THE BOUNDARY: it is exactly the body a retrieval channel would ' +
  'hand a prompt as ground truth, and exactly what ADR §2 forbids this surface to carry.';
const DECOY_TITLE = 'Rotate the signing key on a schedule';
const QUERY = 'persist UI preferences';

/** A unit vector along one axis — so every distance below is arithmetic. */
function oneHot(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

// The stand-in "model": the query and the target card share an axis, the decoy
// sits on another. Substituting a fixed map for a real model is what makes every
// assertion below about the PLUMBING rather than about a provider's weights.
const AXIS_BY_TEXT = new Map<string, number>([
  [QUERY, 0],
  [`${TARGET_TITLE}\n\n${TARGET_BODY}`, 0],
  [`${DECOY_TITLE}\n\n`, 1],
]);

function axisFor(text: string): number {
  const axis = AXIS_BY_TEXT.get(text);
  // A document this map does not know is a fixture that moved without the map —
  // fail loudly rather than rank everything onto axis 0.
  if (axis === undefined) throw new Error(`no axis pinned for embedding document: ${text}`);
  return axis;
}

let cap: { events: CapturedJobEvent[]; restore: () => void };

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
    embeddings: input.map((text) => oneHot(axisFor(text))),
  }));
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The single `work-item/embedding.requested` payload emitted since `from`. */
function requestedSince(from: number): WorkItemEmbeddingRequestedData {
  const evts = cap.events.slice(from).filter((e) => e.name === 'work-item/embedding.requested');
  expect(evts).toHaveLength(1);
  return evts[0]!.data as WorkItemEmbeddingRequestedData;
}

/**
 * Create a work item THROUGH THE SHIPPED SERVICE and run the REAL embedding job
 * over the event that create emitted — the whole write half of the story, with
 * nothing seeded and nothing simulated but the provider call itself.
 */
async function createAndEmbed(
  fx: WorkItemFixture,
  input: { title: string; descriptionMd?: string },
): Promise<{ id: string; identifier: string }> {
  const from = cap.events.length;
  const created = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', ...input },
    fx.ctx,
  );
  const { result } = await new InngestTestEngine({
    function: workItemEmbeddingRequested,
    events: [{ name: 'work-item/embedding.requested', data: requestedSince(from) }],
  }).execute();
  // The chain's own precondition: if the job did not embed, every assertion after
  // it would be testing an empty store and would pass for the wrong reason.
  expect(result).toEqual({ embedded: true, model: MODEL });
  return { id: created.id, identifier: created.identifier };
}

async function callTool(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'story-gate-3098', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function okPayload<T>(res: CallToolResult): T {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as unknown as T;
}

function textOf(res: CallToolResult): string {
  return (res.content as { type: string; text: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

interface SkeletonPayload {
  items: { key: string; kind: string; title: string; status: string; parentKey: string | null }[];
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
}

interface SearchPayload {
  items: { key: string; title: string }[];
  total: number;
}

describe('Story MOTIR-3098 — an agent can find what already exists', () => {
  it('INVARIANT 4 — semantic finds the card by MEANING that `search_work_items` cannot see by substring', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const target = await createAndEmbed(fx, {
      title: TARGET_TITLE,
      descriptionMd: TARGET_BODY,
    });
    await createAndEmbed(fx, { title: DECOY_TITLE });

    // BOTH calls in ONE test, because the CONTRAST is the acceptance criterion:
    // two separate tests can each keep passing while the contrast quietly stops
    // being true.
    const semantic = okPayload<SemanticSearchResponse>(
      await callTool(fx.ctx, SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, {
        projectKey: 'ACME',
        query: QUERY,
      }),
    );
    const substring = okPayload<SearchPayload>(
      await callTool(fx.ctx, 'search_work_items', {
        projectKey: 'ACME',
        filter: {
          version: 'v1',
          combinator: 'and',
          conditions: [{ field: 'text', operator: 'contains', value: QUERY }],
        },
      }),
    );

    expect(semantic.outcome).toBe('ranked');
    expect(semantic.results[0]?.key).toBe(target.identifier);
    expect(semantic.results[0]?.title).toBe(TARGET_TITLE);
    // …and the SAME string through the substring search finds nothing at all.
    expect(substring.total).toBe(0);
    expect(substring.items).toEqual([]);
  });

  it('INVARIANT 5 — `search_work_items` is UNTOUCHED: the substring it CAN see, it still sees', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    // The other direction of the same contrast, and the thing that makes the
    // test above a statement about MEANING rather than about a broken search: a
    // query that IS a substring still matches, unchanged by this story.
    const hit = okPayload<SearchPayload>(
      await callTool(fx.ctx, 'search_work_items', {
        projectKey: 'ACME',
        filter: {
          version: 'v1',
          combinator: 'and',
          conditions: [{ field: 'text', operator: 'contains', value: 'collapsed state' }],
        },
      }),
    );

    expect(hit.total).toBe(1);
    expect(hit.items[0]?.key).toBe(target.identifier);
  });

  it('INVARIANT 1 — "nothing similar" and "could not tell" are DIFFERENT payloads over two fixtures', async () => {
    // Fixture A: an INDEXED project where nothing is close.
    const indexed = await makeWorkItemFixture({ name: 'Indexed', identifier: 'AAA' });
    await createAndEmbed(indexed, { title: DECOY_TITLE });
    const answered = okPayload<SemanticSearchResponse>(
      await callTool(indexed.ctx, SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, {
        projectKey: 'AAA',
        query: QUERY,
        minScore: 0.5,
      }),
    );

    // Fixture B: a project with NO embeddings — the item exists, nothing indexed it.
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BBB' });
    await workItemsService.createWorkItem(
      { projectId: bare.projectId, kind: 'task', title: TARGET_TITLE },
      bare.ctx,
    );
    const unanswerable = okPayload<SemanticSearchResponse>(
      await callTool(bare.ctx, SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, {
        projectKey: 'BBB',
        query: QUERY,
      }),
    );

    // The result sets are IDENTICAL. Everything that keeps them apart is the
    // discriminator — which is the whole point, and why the assertion is on the
    // payload and not on the sentence a human reads.
    expect(answered.results).toEqual([]);
    expect(unanswerable.results).toEqual([]);
    expect(answered.outcome).toBe('nothing-similar');
    expect(unanswerable.outcome).toBe('not-indexed');
    expect(answered.coverage).toEqual({ embedded: 1, total: 1 });
    expect(unanswerable.coverage).toEqual({ embedded: 0, total: 1 });
    expect(unanswerable.message).toMatch(/NOT evidence/);
  });

  it('INVARIANT 7 — an UNREACHABLE motir-ai is a readable non-answer, not an empty result and not a throw', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });
    // Only the QUERY embed fails — the row is already stored, so this is exactly
    // the state Amendment 2's Option B has to survive: a fully indexed project
    // that cannot be asked a question right now.
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const res = await callTool(fx.ctx, SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, {
      projectKey: 'ACME',
      query: QUERY,
    });
    const payload = okPayload<SemanticSearchResponse>(res);

    expect(res.isError).toBeFalsy();
    expect(payload.outcome).toBe('unavailable');
    expect(payload.results).toEqual([]);
    // NULL, not `{ embedded: 0, total: 1 }` — nothing was counted, and zeroes
    // would be indistinguishable from a degraded read of a real project.
    expect(payload.coverage).toBeNull();
    expect(payload.message).toMatch(/NOT evidence/);
    expect(textOf(res)).toMatch(/search_work_items/);
  });

  it('INVARIANT 3 — NO prose crosses the wire: the row is exactly key, title, score (ADR §2)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    const res = await callTool(fx.ctx, SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, {
      projectKey: 'ACME',
      query: QUERY,
    });
    const payload = okPayload<SemanticSearchResponse>(res);

    expect(payload.results).toHaveLength(1);
    // Asserted on the SHAPE. A substring check over the rendered text would pass
    // against a payload carrying `descriptionMd` in a field nobody rendered — the
    // invariant is structural, so the assertion has to be.
    for (const row of payload.results) {
      expect(Object.keys(row).sort()).toEqual(['key', 'score', 'title']);
      expect(row).not.toHaveProperty('descriptionMd');
      expect(row).not.toHaveProperty('explanationMd');
    }
    expect(JSON.stringify(payload)).not.toContain('MUST NEVER CROSS THE BOUNDARY');
  });

  it('INVARIANT 2 — a bounded skeleton sets the TRUNCATION FLAG, which is the assertion', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    for (const title of ['one', 'two', 'three', 'four']) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      );
    }

    const bounded = okPayload<SkeletonPayload>(
      await callTool(fx.ctx, SKELETON_TOOL_NAME, { projectKey: 'ACME', limit: 2 }),
    );
    const whole = okPayload<SkeletonPayload>(
      await callTool(fx.ctx, SKELETON_TOOL_NAME, { projectKey: 'ACME' }),
    );

    // The FLAG, not the count: a tool that silently stopped at 2 would satisfy a
    // row-count check identically and mislead every caller into believing it had
    // seen the whole project.
    expect(bounded.truncated).toBe(true);
    expect(bounded.total).toBe(4);
    expect(bounded.returned).toBe(2);
    // And the complete answer reports the bound too, so completeness is LEGIBLE
    // rather than inferred from a number the caller cannot compare against.
    expect(whole.truncated).toBe(false);
    expect(whole.total).toBe(4);
    expect(whole.returned).toBe(4);
  });

  it('INVARIANT 6 — a cross-workspace probe on BOTH tools is a plain not-found, with no leak', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'ACME' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'ZZZ' });
    await createAndEmbed(theirs, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    for (const [name, args] of [
      [SKELETON_TOOL_NAME, { projectKey: 'ZZZ' }],
      [SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME, { projectKey: 'ZZZ', query: QUERY }],
    ] as const) {
      const res = await callTool(mine.ctx, name, args);
      expect(res.isError, `${name} must refuse a foreign project`).toBe(true);
      const text = textOf(res);
      expect(text).toMatch(/NOT_FOUND/);
      // No partial tree, no ranked keys, and no proof the project exists.
      expect(text).not.toContain(TARGET_TITLE);
      expect(text).not.toContain('ZZZ-');
      expect(res.structuredContent).toBeUndefined();
    }
  });
});
