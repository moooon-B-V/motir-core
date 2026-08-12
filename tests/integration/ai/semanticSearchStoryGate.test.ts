import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';

// THE STORY-LEVEL GATE for Story MOTIR-2694 (Subtask MOTIR-2698) — the five
// guards of `docs/decisions/plan-tree-embeddings.md`, asserted over the ASSEMBLED
// story rather than over any one of its halves.
//
// ⚠️ WHAT MAKES THIS FILE DIFFERENT FROM THE SUBTASK TESTS BESIDE IT, and why it
// is not a copy of them. Every existing test of this surface SEEDS the embedding
// with admin SQL — `similarWorkItemsRoute.test.ts`, `workItemEmbeddingRanking`,
// `workItemEmbeddingRls` — because each is testing ONE layer and needs the vector
// pinned to make its arithmetic deterministic. That is right for a layer test and
// it leaves exactly one thing unasserted: that the layers JOIN. Nothing today
// drives `createWorkItem → the emitted event → the job → the stored vector → the
// endpoint` as one chain, so every claim about the story as a whole currently
// rests on two halves that were each proven against a fixture of the other.
//
// This file drives that chain. The ONE seam stubbed is `embedTexts` — the
// motir-ai boundary — because there is no gateway in tests and an embedding is a
// metered external call (§6.2: `motir-core` stores vectors and does not produce
// them, so this is the only place one can enter). Postgres, pgvector, the HNSW
// index, the RLS policies, the job, the route and every service are real.
//
// The guards, in the order MOTIR-2698 states them:
//   1. KEYS, NOT PROSE (ADR §2) — including the MUTATION proof, below.
//   2. The BEFORE/AFTER that proves the gap was real.
//   3. Tenancy, per the neighbouring tables.
//   4. Degradation is a normal outcome.
//   5. The write path stays outside the transaction.

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  embedTexts: vi.fn(),
}));

import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { mintJobToken } from '@/lib/ai/jobToken';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { workItemEmbeddingRequested } from '@/lib/jobs/definitions/workItemEmbedding';
import { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';
import { POST as similarPOST } from '@/app/api/internal/ai/similar-work-items/route';
import { POST as searchPOST } from '@/app/api/internal/ai/search-work-items/route';
import { hashEmbeddingDocument } from '@/lib/workItems/embeddingDocument';
import type { WorkItemEmbeddingRequestedData } from '@/lib/jobs/types';
import { createTestProject, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../../helpers/jobs';

const SERVICE_SECRET = 'core-callback-secret-test';
const MODEL = 'text-embedding-3-small';

// ── The story's own fixture pair, named once so every guard below reads on the
// SAME case the story was written about (MOTIR-2698 AC3: a reader should see the
// case, not trust the label). ──
const TARGET_TITLE = 'Board columns remember their collapsed state';
const TARGET_BODY =
  'The board persists each column’s collapsed/expanded state per user so it survives a reload. ' +
  'THIS PROSE MUST NEVER CROSS THE BOUNDARY: it is exactly the body text a retrieval channel ' +
  'would hand a prompt as ground truth, and exactly what ADR §2 forbids the endpoint to carry.';
const DECOY_TITLE = 'Rotate the signing key on a schedule';
const QUERY = 'persist UI preferences';

/** A unit vector along one axis — deterministic, so every distance is arithmetic. */
function oneHot(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

// The stand-in "model": the query `persist UI preferences` and the target card
// share an axis; the decoy sits on another. What the tests below pin is that the
// endpoint returns the NEAREST vector's card — the substitution of a real model
// for a fixed map is what makes the assertion about the plumbing rather than
// about OpenAI's weights.
const AXIS_BY_TEXT = new Map<string, number>([
  [QUERY, 0],
  [`${TARGET_TITLE}\n\n${TARGET_BODY}`, 0],
  [`${DECOY_TITLE}\n\n`, 1],
]);

function axisFor(text: string): number {
  const axis = AXIS_BY_TEXT.get(text);
  // A document this map does not know is a test that changed its fixture without
  // changing the map — fail loudly rather than rank everything onto axis 0.
  if (axis === undefined) throw new Error(`no axis pinned for embedding document: ${text}`);
  return axis;
}

let cap: { events: CapturedJobEvent[]; restore: () => void };

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_embedding", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
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

function tokenFor(fx: WorkItemFixture, projectId?: string): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: projectId ?? fx.projectId,
  });
}

function req(opts: { token: string; body: unknown; path?: string }): Request {
  return new Request(`http://core/api/internal/ai/${opts.path ?? 'similar-work-items'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': opts.token,
    },
    body: JSON.stringify(opts.body),
  });
}

/** Ask the semantic endpoint the story's question, as the story's caller would. */
async function askSemantic(
  fx: WorkItemFixture,
  opts: { projectId?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: SimilarBody }> {
  const res = await similarPOST(
    req({
      token: tokenFor(fx, opts.projectId),
      body: { queryEmbedding: oneHot(axisFor(QUERY)), model: MODEL, ...opts.body },
    }),
  );
  return { status: res.status, body: (await res.json()) as SimilarBody };
}

interface SimilarBody {
  results: Array<{ key: string; title: string; score: number }>;
  model: string;
  coverage: { embedded: number; total: number };
}

/**
 * THE GUARD ITSELF, extracted so it can be TURNED ON A MUTANT (MOTIR-2698 AC2).
 *
 * ⚠️ An invariant test is only worth what its failure mode is worth, and
 * "asserts the right thing" is not observable from reading a passing assertion.
 * So the keys-not-prose check lives here as ONE function, applied twice: once to
 * the real response (which must pass) and once to a response deliberately WIDENED
 * with a body field (which must fail). Without the second application, a guard
 * that had quietly stopped checking would look identical on a green run — and
 * this is the single invariant `docs/decisions/plan-tree-embeddings.md` §2 says a
 * fourth content field may only cross by amending the ADR.
 *
 * It reads the response SHAPE, not the intent: an exact key set per row, an exact
 * key set on the envelope, and the forbidden prose absent from the serialized
 * wire — the last so a leak through some future NESTED field is caught too.
 */
function assertKeysNotProse(body: unknown, forbiddenProse: string): void {
  const payload = body as SimilarBody;
  for (const row of payload.results) {
    expect(Object.keys(row).sort()).toEqual(['key', 'score', 'title']);
  }
  expect(Object.keys(payload).sort()).toEqual(['coverage', 'model', 'results']);
  const wire = JSON.stringify(payload);
  expect(wire).not.toContain(forbiddenProse);
  expect(wire).not.toContain('descriptionMd');
  expect(wire).not.toContain('explanationMd');
}

describe('MOTIR-2694 story gate · guard 1 — KEYS, NOT PROSE (ADR §2)', () => {
  it('the body reaches the STORE and never the wire, on the real create → embed → search chain', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    // The prose really did enter the system — this is the half a seeded fixture
    // cannot show. The stored hash is the hash of title + blank line + body
    // (§3), so the description demonstrably shaped the vector that the search
    // below then ranks on. The endpoint is dropping content it HAS, not content
    // it never received.
    const row = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: target.id } });
    expect(row?.contentHash).toBe(hashEmbeddingDocument(`${TARGET_TITLE}\n\n${TARGET_BODY}`));

    const { status, body } = await askSemantic(fx);
    expect(status).toBe(200);
    expect(body.results).toEqual([{ key: target.identifier, title: TARGET_TITLE, score: 1 }]);
    assertKeysNotProse(body, 'MUST NEVER CROSS THE BOUNDARY');
  });

  it('MUTATION — a ranked row that GAINS a body field does not widen the wire: the mapper is the choke point', async () => {
    // The failure this stands in for is the realistic one, and it is not
    // malicious: someone adds a column to the ranking query for a good internal
    // reason — a snippet for debugging, the description for a re-rank — and the
    // wire shape follows it out of the building. `toSimilarWorkItemRows` names
    // its three fields instead of spreading the row precisely so that cannot
    // happen; this is that claim, exercised rather than commented.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    const widened = vi.spyOn(workItemEmbeddingsService, 'rankSimilar').mockResolvedValue({
      results: [
        {
          workItemId: target.id,
          identifier: target.identifier,
          title: TARGET_TITLE,
          distance: 0,
          // The mutation: a fourth field on the row the mapper consumes.
          descriptionMd: TARGET_BODY,
        } as never,
      ],
      rankable: 1,
      total: 1,
      exactFallbackUsed: false,
    });
    try {
      const { status, body } = await askSemantic(fx);
      expect(status).toBe(200);
      // Inert — the widened row reached the mapper and the wire is unchanged.
      expect(body.results).toEqual([{ key: target.identifier, title: TARGET_TITLE, score: 1 }]);
      assertKeysNotProse(body, 'MUST NEVER CROSS THE BOUNDARY');
      expect(widened).toHaveBeenCalledTimes(1);
    } finally {
      widened.mockRestore();
    }
  });

  it('MUTATION — the guard FAILS on a widened response, so a green run is evidence and not habit', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });
    const { body } = await askSemantic(fx);

    // Same guard, same call, one mutant response. Both arms are asserted: the
    // row-level widening (a fourth key) and the nested-prose widening (the body
    // arriving somewhere the key check does not look) — because a guard that
    // caught only the first would still let §2's actual harm through.
    const rowWidened = {
      ...body,
      results: body.results.map((r) => ({ ...r, descriptionMd: TARGET_BODY })),
    };
    expect(() => assertKeysNotProse(rowWidened, 'MUST NEVER CROSS THE BOUNDARY')).toThrow();

    const nestWidened = { ...body, coverage: { ...body.coverage, sample: TARGET_BODY } };
    expect(() => assertKeysNotProse(nestWidened, 'MUST NEVER CROSS THE BOUNDARY')).toThrow();

    // And the control: unmutated, it passes. Without this line the two throws
    // above are also satisfied by a guard that throws on everything.
    expect(() => assertKeysNotProse(body, 'MUST NEVER CROSS THE BOUNDARY')).not.toThrow();
    expect(body.results[0]?.key).toBe(target.identifier);
  });
});

describe('MOTIR-2694 story gate · guard 2 — the BEFORE/AFTER that proves the gap was real', () => {
  it(`"${QUERY}" finds "${TARGET_TITLE}" semantically, and the shipped contains filter finds nothing`, async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });
    const decoy = await createAndEmbed(fx, { title: DECOY_TITLE });

    // The pair shares NO keyword: "persist"/"UI"/"preferences" appear nowhere in
    // the target's title. That is the whole premise of the story, so it is
    // asserted rather than assumed — a fixture edit that accidentally introduced
    // an overlapping word would otherwise make the "after" pass for the reason
    // the "before" was supposed to rule out.
    for (const word of QUERY.split(' ')) {
      expect(TARGET_TITLE.toLowerCase()).not.toContain(word.toLowerCase());
    }

    // BEFORE — the search GATE 1 has today.
    const before = await searchPOST(
      req({
        token: tokenFor(fx),
        path: 'search-work-items',
        body: {
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [{ field: 'text', operator: 'contains', value: QUERY }],
          },
        },
      }),
    );
    expect(before.status).toBe(200);
    expect(((await before.json()) as { items: unknown[] }).items).toEqual([]);

    // AFTER — the same question as a vector, through the whole chain.
    const { status, body } = await askSemantic(fx);
    expect(status).toBe(200);
    expect(body.results.map((r) => r.key)).toEqual([target.identifier, decoy.identifier]);
    expect(body.results[0]?.score).toBeCloseTo(1, 6);
    expect(body.results[1]?.score).toBeCloseTo(0, 6);
    expect(body.coverage).toEqual({ embedded: 2, total: 2 });
  });

  it('returns the top-N with NO default threshold — the limit is the only bound (MOTIR-2698 answers ADR §6.1)', async () => {
    // ⚠️ THE DECISION THIS CARD OWED. §6.1 pinned no default `minScore` and named
    // MOTIR-2698 as the owner of "is one warranted". The answer is NO, and the
    // reason is the cost asymmetry the ADR states for itself in §3: a spurious
    // candidate costs ONE keyed read and is discarded, while a missed candidate
    // costs a duplicate branch of the plan — which is the exact failure the story
    // exists to remove. A default threshold can only ever convert the cheap error
    // into the expensive one, and it would do so invisibly, because a suppressed
    // candidate and an absent one are the same empty list at the wire.
    //
    // A number chosen here would also be unfounded twice over: a cosine cutoff is
    // a property of the model AND of the corpus, and this repo holds neither (it
    // stores vectors and does not produce them, §6.2). So the endpoint returns
    // the top-N, `limit` is the bound, and the CALLER — which knows what it asked
    // and reads every candidate through a keyed tool anyway — may pass a
    // threshold when it has one. That is asserted here rather than left as prose.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });
    const decoy = await createAndEmbed(fx, { title: DECOY_TITLE });

    // The decoy is orthogonal — score 0, the weakest possible non-negative
    // candidate. It comes back anyway.
    const none = await askSemantic(fx);
    expect(none.body.results.map((r) => r.key)).toEqual([target.identifier, decoy.identifier]);

    // The caller's threshold still works — the default is absent, not disabled.
    const filtered = await askSemantic(fx, { body: { minScore: 0.5 } });
    expect(filtered.body.results.map((r) => r.key)).toEqual([target.identifier]);

    // And `limit` is the bound that IS applied by default.
    const bounded = await askSemantic(fx, { body: { limit: 1 } });
    expect(bounded.body.results.map((r) => r.key)).toEqual([target.identifier]);
    expect(bounded.body.coverage).toEqual({ embedded: 2, total: 2 });
  });
});

describe('MOTIR-2694 story gate · guard 3 — tenancy, per the neighbouring tables', () => {
  it('a token for a sibling project sees none of this project’s rows, written through the real path', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIB',
    });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    // Mine sees mine.
    const mine = await askSemantic(fx);
    expect(mine.body.results.map((r) => r.key)).toEqual([target.identifier]);

    // The sibling — same workspace, same user, same everything but the project —
    // sees nothing at all, and says so HONESTLY: `0 / 0` is a sibling with no
    // items, not a degraded read. The project filter is what stands between the
    // two, and the target's vector is the NEAREST row in the table, so a missing
    // filter would surface it here rather than fail quietly.
    const theirs = await askSemantic(fx, { projectId: sibling.id });
    expect(theirs.status).toBe(200);
    expect(theirs.body.results).toEqual([]);
    expect(theirs.body.coverage).toEqual({ embedded: 0, total: 0 });
  });

  it('a token from ANOTHER workspace is a 404, never a 403 and never a result', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });
    await createAndEmbed(theirs, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    const res = await similarPOST(
      req({
        // My user, my workspace, THEIR project — the confused-deputy shape.
        token: mintJobToken({
          userId: mine.ctx.userId,
          workspaceId: mine.ctx.workspaceId,
          projectId: theirs.projectId,
        }),
        body: { queryEmbedding: oneHot(axisFor(QUERY)), model: MODEL },
      }),
    );
    // 404 rather than 403: a 403 confirms the project exists to someone who may
    // not see it, and the pair is only non-enumerable while both answer the same.
    expect(res.status).toBe(404);
  });
});

describe('MOTIR-2694 story gate · guard 4 — degradation is a normal outcome', () => {
  it('a provider OUTAGE during the write leaves the search honest: 200, empty, and an accurate 0/N coverage', async () => {
    // The assembled statement the layer tests cannot make: the failure happens on
    // the WRITE side, and the READ side — a different request, minutes later —
    // reports it accurately enough for the consumer to fall back. `0 / 2` says "a
    // real project that nothing has indexed", which is what makes MOTIR-2691's
    // fallback to the `contains` search a decision rather than a guess.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: TARGET_TITLE, descriptionMd: TARGET_BODY },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: DECOY_TITLE },
      fx.ctx,
    );
    const events = cap.events
      .slice(from)
      .filter((e) => e.name === 'work-item/embedding.requested')
      .map((e) => e.data as WorkItemEmbeddingRequestedData);
    expect(events).toHaveLength(2);

    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));
    for (const data of events) {
      const { error } = await new InngestTestEngine({
        function: workItemEmbeddingRequested,
        events: [{ name: 'work-item/embedding.requested', data }],
      }).execute();
      // It FAILS rather than swallowing — that is what leaves the retry budget a
      // job to come back to (guard 5's recovery, below, is the other end of it).
      expect(error).toBeTruthy();
    }

    const { status, body } = await askSemantic(fx);
    expect(status).toBe(200);
    expect(body).toEqual({ results: [], model: MODEL, coverage: { embedded: 0, total: 2 } });
  });

  it('an ABSENT index degrades the SPEED and never the answer — still a 200 with the full ranked set', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const target = await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });
    const decoy = await createAndEmbed(fx, { title: DECOY_TITLE });

    await adminDb.$executeRawUnsafe('DROP INDEX IF EXISTS "work_item_embedding_embedding_idx"');
    try {
      const { status, body } = await askSemantic(fx);
      expect(status).toBe(200);
      expect(body.results.map((r) => r.key)).toEqual([target.identifier, decoy.identifier]);
    } finally {
      // Rebuild it — this worker's database outlives this file.
      await adminDb.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "work_item_embedding_embedding_idx" ON "work_item_embedding" USING hnsw ("embedding" vector_cosine_ops)',
      );
    }
  });

  it('an UNREADABLE store is a 200 with 0/0 — distinguishable from the 0/N above, never a 5xx', async () => {
    // The two empty answers must not look alike: `0 / N` is "nothing is indexed
    // yet" and `0 / 0` is "I could not look". A consumer that cannot tell them
    // apart re-creates, one layer up, the exact false-negative this story removed.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await createAndEmbed(fx, { title: TARGET_TITLE, descriptionMd: TARGET_BODY });

    const broken = vi
      .spyOn(workItemEmbeddingsService, 'rankSimilar')
      .mockRejectedValue(new Error('operator does not exist: vector <=> vector'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await askSemantic(fx);
      expect(status).toBe(200);
      expect(body).toEqual({ results: [], model: MODEL, coverage: { embedded: 0, total: 0 } });
      expect(logged).toHaveBeenCalled();
    } finally {
      broken.mockRestore();
      logged.mockRestore();
    }
  });
});

describe('MOTIR-2694 story gate · guard 5 — the write path stays OUTSIDE the transaction (ADR §6.3.5)', () => {
  it('a provider failure leaves the work item WRITTEN and correct, with only the sidecar missing', async () => {
    // The ordering claim, stated as its durable consequence: the item is a first-
    // class row that a create returned and a read returns unchanged, and the
    // embedding is a sidecar that failed. If the external call sat inside the
    // write transaction, this create would have rolled back and the user would
    // have lost a card because a metered vector service was down.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const from = cap.events.length;
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: TARGET_TITLE, descriptionMd: TARGET_BODY },
      fx.ctx,
    );
    const data = requestedSince(from);
    const { error } = await new InngestTestEngine({
      function: workItemEmbeddingRequested,
      events: [{ name: 'work-item/embedding.requested', data }],
    }).execute();
    expect(error).toBeTruthy();

    const readBack = await workItemsService.getWorkItem(created.id, fx.ctx);
    expect(readBack.title).toBe(TARGET_TITLE);
    expect(readBack.descriptionMd).toBe(TARGET_BODY);
    expect(await adminDb.workItemEmbedding.count({ where: { workItemId: created.id } })).toBe(0);
  });

  it('and the item becomes findable once the provider RECOVERS — the failure is transient, not terminal', async () => {
    // The other end of guard 4's "it FAILS rather than swallowing". An outage
    // that silently marked the item embedded would leave it permanently invisible
    // to the finder, because nothing else ever revisits it; this asserts the loop
    // actually closes on the retry, through the same event Inngest would redeliver.
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const from = cap.events.length;
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: TARGET_TITLE, descriptionMd: TARGET_BODY },
      fx.ctx,
    );
    const data = requestedSince(from);
    const run = () =>
      new InngestTestEngine({
        function: workItemEmbeddingRequested,
        events: [{ name: 'work-item/embedding.requested', data }],
      }).execute();

    expect((await run()).error).toBeTruthy();
    const duringOutage = await askSemantic(fx);
    expect(duringOutage.body.results).toEqual([]);

    // The provider comes back; the SAME event is redelivered.
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      embeddings: input.map((text) => oneHot(axisFor(text))),
    }));
    expect((await run()).result).toEqual({ embedded: true, model: MODEL });

    const afterRecovery = await askSemantic(fx);
    expect(afterRecovery.body.results.map((r) => r.key)).toEqual([created.identifier]);
    assertKeysNotProse(afterRecovery.body, 'MUST NEVER CROSS THE BOUNDARY');
  });
});
