import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The motir-ai boundary is the ONE seam stubbed here — there is no gateway in
// tests and an embedding is a metered external call. Everything else (Postgres,
// RLS, the repositories, the services) is real, per CLAUDE.md's no-DB-mocks
// rule: the properties under test are ORDERING and PERSISTENCE, and a mocked
// database cannot witness either.
vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  workItemEmbeddingsService,
  BACKFILL_PAGE_SIZE,
  EMBEDDING_BATCH_MAX_INPUTS,
} from '@/lib/services/workItemEmbeddingsService';
import { workItemEmbeddingRepository } from '@/lib/repositories/workItemEmbeddingRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { EmbeddingDimensionMismatchError } from '@/lib/workItems/errors';
import { composeEmbeddingDocument, hashEmbeddingDocument } from '@/lib/workItems/embeddingDocument';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

const MODEL = 'text-embedding-3-small';

/** A deterministic 1536-float vector; the values matter only to the ordering tests. */
function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed % 1536 ? 1 : 0));
}

/** Make the stubbed boundary answer with one correct-length vector per input. */
function respondWithVectors(model = MODEL): void {
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model,
    dimensions: 1536,
    embeddings: input.map((_, i) => vector(i + 1)),
  }));
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  respondWithVectors();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Seed `count` work items in one statement — the fixture helper opens a
 *  transaction per item, which is the wrong shape for a two-hundred-row page. */
async function bulkSeed(fx: WorkItemFixture, count: number): Promise<void> {
  await adminDb.$executeRawUnsafe(
    `INSERT INTO "work_item"
       ("id","workspaceId","projectId","kind","key","identifier","title","reporterId",
        "position","status","priority","createdAt","updatedAt")
     SELECT 'bulk-'||to_char(g,'FM0000'), $1, $2, 'task', 5000+g, $4||'-'||(5000+g),
            'Bulk '||g, $3, 'a'||to_char(g,'FM0000'), 'todo', 'medium', now(), now()
     FROM generate_series(1, ${count}) g`,
    fx.workspaceId,
    fx.projectId,
    fx.ownerId,
    fx.projectIdentifier,
  );
}

async function scenario(): Promise<{ fx: WorkItemFixture; item: WorkItem }> {
  const fx = await makeWorkItemFixture({ name: 'Embeddings', identifier: 'EMB' });
  const item = await createTestWorkItem(fx, { kind: 'task', title: 'Board columns' });
  return { fx, item };
}

describe('embedWorkItem — the derivation', () => {
  it('writes the vector plus the derivation metadata the ADR §4 table pins', async () => {
    const { fx, item } = await scenario();

    const result = await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(result).toEqual({ embedded: true, model: MODEL });
    const row = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: item.id } });
    expect(row).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      model: MODEL,
      dimensions: 1536,
      contentHash: hashEmbeddingDocument(
        composeEmbeddingDocument({ title: 'Board columns', descriptionMd: null }),
      ),
    });
    // A row is never written without its vector — the upsert lands both in ONE
    // statement, which is what makes "a row exists" mean "this item is a
    // candidate" (ADR §4).
    const present = await adminDb.$queryRaw<{ present: boolean }[]>`
      SELECT ("embedding" IS NOT NULL) AS "present"
      FROM "work_item_embedding" WHERE "work_item_id" = ${item.id}`;
    expect(present[0]?.present).toBe(true);
  });

  it('embeds the §3 document — title + blank line + description, nothing else', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'DOC' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { descriptionMd: 'D', explanationMd: 'WHY THIS MATTERS' },
    });

    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    // The explanation axis answers a different question and is excluded (§3).
    expect(vi.mocked(embedTexts).mock.calls[0]?.[0]).toEqual(['T\n\nD']);
  });

  it('is IDEMPOTENT — a second run makes NO provider call', async () => {
    const { fx, item } = await scenario();
    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });
    vi.mocked(embedTexts).mockClear();

    const again = await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(again).toEqual({ embedded: false, reason: 'unchanged' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('RE-EMBEDS after the document moves, and the stored hash follows it', async () => {
    const { fx, item } = await scenario();
    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });
    const before = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: item.id } });

    await adminDb.workItem.update({
      where: { id: item.id },
      data: { title: 'Board columns remember collapse' },
    });
    const result = await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(result.embedded).toBe(true);
    const after = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: item.id } });
    expect(after?.contentHash).not.toBe(before?.contentHash);
    // Still ONE row — the upsert converges rather than accumulating.
    expect(await adminDb.workItemEmbedding.count({ where: { workItemId: item.id } })).toBe(1);
  });

  it('RE-READS the item at run time rather than embedding a captured payload (§6.3.3)', async () => {
    // The convergence guarantee: whatever the text was when the event was
    // enqueued, the job embeds what the row says NOW. Simulated by editing the
    // row after the trigger would have fired and before the job runs.
    const { fx, item } = await scenario();
    await adminDb.workItem.update({ where: { id: item.id }, data: { title: 'Edited later' } });

    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(vi.mocked(embedTexts).mock.calls[0]?.[0]).toEqual(['Edited later\n\n']);
  });

  it('degrades to `ai-not-configured` on a self-hosted deployment — no call, no throw', async () => {
    const { fx, item } = await scenario();
    vi.stubEnv('MOTIR_AI_URL', '');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');

    const result = await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(result).toEqual({ embedded: false, reason: 'ai-not-configured' });
    expect(embedTexts).not.toHaveBeenCalled();
    expect(await adminDb.workItemEmbedding.count()).toBe(0);
  });

  it('returns `not-found` when the item vanished between the enqueue and the run', async () => {
    const { fx, item } = await scenario();
    await adminDb.workItem.delete({ where: { id: item.id } });

    expect(
      await workItemEmbeddingsService.embedWorkItem({
        workspaceId: fx.workspaceId,
        workItemId: item.id,
      }),
    ).toEqual({ embedded: false, reason: 'not-found' });
    expect(embedTexts).not.toHaveBeenCalled();
  });
});

describe('embedWorkItem — failure leaves the work item written and correct (ADR §6.3.5)', () => {
  it('a provider OUTAGE writes no embedding and leaves the item untouched', async () => {
    const { fx, item } = await scenario();
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    // It THROWS so the job's idempotent retry budget absorbs it — the item is
    // simply not a candidate meanwhile, which is never an error to a user.
    await expect(
      workItemEmbeddingsService.embedWorkItem({
        workspaceId: fx.workspaceId,
        workItemId: item.id,
      }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);

    const stored = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(stored?.title).toBe('Board columns');
    expect(stored?.archivedAt).toBeNull();
    expect(await adminDb.workItemEmbedding.count({ where: { workItemId: item.id } })).toBe(0);

    // And the failure is transient by construction: once the provider recovers,
    // the SAME item embeds with no other intervention.
    respondWithVectors();
    await expect(
      workItemEmbeddingsService.embedWorkItem({
        workspaceId: fx.workspaceId,
        workItemId: item.id,
      }),
    ).resolves.toEqual({ embedded: true, model: MODEL });
  });

  it('a MISSING vector is refused too — the guard covers a short answer, not only a wide one', async () => {
    // Belt and braces against the boundary: `embedTexts` already refuses a batch
    // whose count disagrees with the request, so this arm is unreachable through
    // the real client. It is kept — and asserted — because what it protects
    // against is storing `undefined` as a vector, which fails nowhere and ranks
    // wrongly forever.
    const { fx, item } = await scenario();
    vi.mocked(embedTexts).mockResolvedValue({ model: MODEL, dimensions: 1536, embeddings: [] });

    await expect(
      workItemEmbeddingsService.embedWorkItem({
        workspaceId: fx.workspaceId,
        workItemId: item.id,
      }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(await adminDb.workItemEmbedding.count({ where: { workItemId: item.id } })).toBe(0);
  });

  it('a WRONG-LENGTH vector is refused before the write, naming the model', async () => {
    const { fx, item } = await scenario();
    vi.mocked(embedTexts).mockResolvedValue({
      model: 'text-embedding-3-large',
      dimensions: 3072,
      embeddings: [Array.from({ length: 3072 }, () => 0.1)],
    });

    await expect(
      workItemEmbeddingsService.embedWorkItem({
        workspaceId: fx.workspaceId,
        workItemId: item.id,
      }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    // Not merely "the cast failed": nothing is stored, so a re-dimensioned model
    // cannot leave a vector that ranks against incomparable neighbours.
    expect(await adminDb.workItemEmbedding.count({ where: { workItemId: item.id } })).toBe(0);
  });
});

describe('embedWorkItem — the external call is NEVER inside a transaction (ADR §6.3.2)', () => {
  it('holds no open transaction while the provider call is in flight', async () => {
    const { fx, item } = await scenario();

    // Observed rather than asserted structurally: at the moment `embedTexts` is
    // invoked, ask Postgres ITSELF — over a SEPARATE connection — whether any
    // session on this database is sitting `idle in transaction`. A service that
    // called out from inside `withWorkspaceServiceContext` would have exactly
    // that: a transaction open, waiting on the network, holding a connection and
    // burning Prisma's 5s interactive budget. Reading the server's own view is
    // the only assertion that cannot be satisfied by a refactor that merely
    // LOOKS staged.
    let openTransactions = -1;
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
      const rows = await adminDb.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'idle in transaction'`;
      openTransactions = Number(rows[0]?.count ?? -1);
      return { model: MODEL, dimensions: 1536, embeddings: input.map((_, i) => vector(i + 1)) };
    });

    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect(openTransactions).toBe(0);
  });

  it('the read that decides, and the write that stores, are SEPARATE transactions', async () => {
    // The corollary of the above, from the other side: the read transaction has
    // COMMITTED before the call, so a concurrent writer is never blocked by an
    // embedding in flight. Proved by mutating the item from another connection
    // DURING the call and seeing the mutation land immediately.
    const { fx, item } = await scenario();
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
      await adminDb.workItem.update({ where: { id: item.id }, data: { priority: 'high' } });
      return { model: MODEL, dimensions: 1536, embeddings: input.map((_, i) => vector(i + 1)) };
    });

    await workItemEmbeddingsService.embedWorkItem({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
    });

    expect((await adminDb.workItem.findUnique({ where: { id: item.id } }))?.priority).toBe('high');
  });
});

describe('backfillProject', () => {
  it('embeds every item that has no vector, in ONE batched call', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF' });
    const items = [];
    for (let i = 0; i < 5; i += 1) {
      items.push(await createTestWorkItem(fx, { kind: 'task', title: `Item ${i}` }));
    }

    const result = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(result).toEqual({ scanned: 5, embedded: 5, model: MODEL });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(await adminDb.workItemEmbedding.count({ where: { projectId: fx.projectId } })).toBe(5);
  });

  it('is a NO-OP on a second run — the whole point of hashing the content', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF2' });
    await createTestWorkItem(fx, { kind: 'task', title: 'Only item' });
    await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    vi.mocked(embedTexts).mockClear();

    const again = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(again).toEqual({ scanned: 1, embedded: 0, model: null });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('re-embeds only the item whose text moved, leaving its neighbours alone', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF3' });
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Alpha' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'Beta' });
    await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const bBefore = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: b.id } });
    vi.mocked(embedTexts).mockClear();

    await adminDb.workItem.update({
      where: { id: a.id },
      data: { descriptionMd: 'now with a body' },
    });
    const result = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(result.embedded).toBe(1);
    expect(vi.mocked(embedTexts).mock.calls[0]?.[0]).toEqual(['Alpha\n\nnow with a body']);
    const bAfter = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: b.id } });
    expect(bAfter?.embeddedAt).toEqual(bBefore?.embeddedAt);
  });

  it("CHUNKS at motir-ai's 64-input cap rather than discovering it as a 400", async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF4' });
    // One more than the cap: the sweep must split, not send 65.
    const total = EMBEDDING_BATCH_MAX_INPUTS + 1;
    await bulkSeed(fx, total);

    const result = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(result.embedded).toBe(total);
    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(embedTexts).mock.calls[0]?.[0]).toHaveLength(EMBEDDING_BATCH_MAX_INPUTS);
    expect(vi.mocked(embedTexts).mock.calls[1]?.[0]).toHaveLength(1);
  });

  it('PAGES the scan, and the second page resumes where the first stopped', async () => {
    // One past the page size, so the keyset cursor is exercised for real. It has
    // to be: the sweep WRITES as it scans, so an OFFSET page over the set it is
    // changing would skip rows — silently, and only on projects big enough to
    // need more than one page.
    const fx = await makeWorkItemFixture({ identifier: 'BF7' });
    const total = BACKFILL_PAGE_SIZE + 1;
    await bulkSeed(fx, total);

    const result = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(result).toMatchObject({ scanned: total, embedded: total });
    // Every single item, not `total - 1` and not a duplicate of the first page.
    expect(await adminDb.workItemEmbedding.count({ where: { projectId: fx.projectId } })).toBe(
      total,
    );
  });

  it('returns immediately on an EMPTY project — no page, no call', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF8' });

    expect(
      await workItemEmbeddingsService.backfillProject({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).toEqual({ scanned: 0, embedded: 0, model: null });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('refuses a SHORT batch rather than pairing vectors with the wrong items', async () => {
    // The worst failure this code can have: `embeddings[i]` is paired with
    // `group[i]` positionally, so a batch that came back short would silently
    // store one item's vector under another's key and rank the wrong card
    // forever. It must throw instead — and write nothing.
    const fx = await makeWorkItemFixture({ identifier: 'BF9' });
    await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    vi.mocked(embedTexts).mockResolvedValue({ model: MODEL, dimensions: 1536, embeddings: [] });

    await expect(
      workItemEmbeddingsService.backfillProject({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(await adminDb.workItemEmbedding.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('covers ARCHIVED items too — un-archiving must not need a re-embed (ADR §5)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF5' });
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Retired' });
    await adminDb.workItem.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const result = await workItemEmbeddingsService.backfillProject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(result.embedded).toBe(1);
    expect(
      await adminDb.workItemEmbedding.findUnique({ where: { workItemId: archived.id } }),
    ).not.toBeNull();
  });

  it('does nothing at all when motir-ai is not configured', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BF6' });
    await createTestWorkItem(fx, { kind: 'task', title: 'Item' });
    vi.stubEnv('MOTIR_AI_URL', '');

    expect(
      await workItemEmbeddingsService.backfillProject({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).toEqual({ scanned: 0, embedded: 0, model: null });
    expect(embedTexts).not.toHaveBeenCalled();
  });
});

describe('the repository primitives, exercised directly', () => {
  // Reaching into the repository from a test is the one sanctioned cross-layer
  // reach (CLAUDE.md), and these two are reachable only from here: the cursor's
  // non-null arm needs a page boundary, and the ef_search clamp is a guard on a
  // value the service always supplies in range.

  it('listForBackfill RESUMES after a cursor, exclusive of it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CUR' });
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const [first, second] = [a.id, b.id].sort();

    const page = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemEmbeddingRepository.listForBackfill(
        { projectId: fx.projectId, afterId: first!, limit: 10 },
        tx,
      ),
    );

    expect(page.map((r) => r.id)).toEqual([second]);
  });

  it("setEfSearch CLAMPS to pgvector's range, whatever it is handed", async () => {
    const fx = await makeWorkItemFixture({ identifier: 'EFS' });
    const read = async (value: number): Promise<string> =>
      withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
        await workItemEmbeddingRepository.setEfSearch(value, tx);
        const rows = await tx.$queryRawUnsafe<{ ef: string }[]>(
          `SELECT current_setting('hnsw.ef_search') AS ef`,
        );
        return rows[0]?.ef ?? '(unset)';
      });

    // The value is INTERPOLATED (SET takes no bind parameters), so the clamp is
    // what makes the interpolated text provably a number.
    expect(await read(0)).toBe('40');
    expect(await read(Number.NaN)).toBe('40');
    expect(await read(1_000_000)).toBe('1000');
    expect(await read(120.9)).toBe('120');
  });
});
