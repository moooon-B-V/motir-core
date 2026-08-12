import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import {
  efSearchForLimit,
  workItemEmbeddingRepository,
} from '@/lib/repositories/workItemEmbeddingRepository';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { createTestProject, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// The RANKING read and its pre-filter under-return mitigation (Story MOTIR-2694 ·
// Subtask MOTIR-2696, ADR Consequences). Real pgvector, a real HNSW index, a real
// large table — the failure this file exists to pin is a property of the INDEX,
// so nothing about it can be established against a mock.
//
// THE HAZARD, stated precisely. An HNSW scan collects its candidates by walking
// the graph BEFORE the query's `WHERE` is applied. So a project holding a small
// share of a large table can have every one of its rows fall outside the
// candidate set, and the query returns FEWER rows than the project actually has
// — silently, with no error. For a candidate-finder whose entire job is to stop
// GATE 1 reporting a false "nothing matches", a silent short read is the same
// bug one layer down.

const MODEL = 'text-embedding-3-small';
const OTHER_MODEL = 'text-embedding-3-large';

/** Rows in the filler project for the AT-SCALE tests — enough that the HNSW
 *  graph is real and its candidate set can miss the small project entirely.
 *  The behavioural tests below pass `0`: they assert ordering and filtering,
 *  which a 1 500-row fixture would only make slower. */
const FILLER_ROWS = 1_500;
const TARGET_ROWS = 3;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A one-hot vector — deterministic, and far from the random filler cluster. */
function oneHot(index: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0));
}

/** The pgvector literal for a vector of a single repeated value. */
function uniform(value: number): number[] {
  return Array.from({ length: 1536 }, () => value);
}

interface RankingFixture {
  fx: WorkItemFixture;
  /** The SMALL project whose full ranked set must always come back. */
  targetProjectId: string;
  /** Its items, in the order their vectors approach `uniform(0.5)`. */
  targetIdentifiers: string[];
  /** The LARGE sibling project that dominates the index. */
  fillerProjectId: string;
}

/**
 * A large table: two projects in ONE workspace, so the difference between them
 * is the `project_id` PRE-FILTER and nothing else.
 *
 * Seeded with raw SQL rather than the fixture helper. Fifteen hundred rows
 * through `createTestWorkItem` would be fifteen hundred transactions, and the
 * vectors are generated SERVER-SIDE (`ARRAY(SELECT random() …)`) so 1 500 × 1 536
 * floats never cross the wire as SQL text. Correlated on `g` so each row gets its
 * own vector — an uncorrelated sub-select would be hoisted to an InitPlan and
 * every filler row would share one vector, collapsing the graph this test needs.
 */
async function makeTable(fillerRows: number): Promise<RankingFixture> {
  const fx = await makeWorkItemFixture({ name: 'Ranking', identifier: 'RNK' });
  const filler = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Filler',
    identifier: 'FIL',
  });

  if (fillerRows > 0) {
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item"
         ("id","workspaceId","projectId","kind","key","identifier","title","reporterId",
          "position","status","priority","createdAt","updatedAt")
       SELECT 'fill-'||to_char(g,'FM00000'), $1, $2, 'task', g, 'FIL-'||g, 'Filler '||g, $3,
              'a'||to_char(g,'FM00000'), 'todo', 'medium', now(), now()
       FROM generate_series(1, ${fillerRows}) g`,
      fx.workspaceId,
      filler.id,
      fx.ownerId,
    );
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item_embedding"
         ("work_item_id","workspace_id","project_id","model","dimensions","content_hash",
          "embedded_at","embedding")
       SELECT 'fill-'||to_char(g,'FM00000'), $1, $2, $3, 1536, 'h'||g, now(),
              (SELECT ARRAY(SELECT random() FROM generate_series(1,1536) WHERE g IS NOT NULL))::vector
       FROM generate_series(1, ${fillerRows}) g`,
      fx.workspaceId,
      filler.id,
      MODEL,
    );
  }

  // The target project's items: one-hot vectors, so their distance to
  // `uniform(0.5)` is deterministic and their ORDER is fixed by construction.
  const targetIdentifiers: string[] = [];
  for (let i = 0; i < TARGET_ROWS; i += 1) {
    const id = `tgt-${i}`;
    const identifier = `RNK-${i + 1}`;
    targetIdentifiers.push(identifier);
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item"
         ("id","workspaceId","projectId","kind","key","identifier","title","reporterId",
          "position","status","priority","createdAt","updatedAt")
       VALUES ($1,$2,$3,'task',$4,$5,$6,$7,$8,'todo','medium',now(),now())`,
      id,
      fx.workspaceId,
      fx.projectId,
      i + 1,
      identifier,
      `Target ${i}`,
      fx.ownerId,
      `b${i}`,
    );
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item_embedding"
         ("work_item_id","workspace_id","project_id","model","dimensions","content_hash",
          "embedded_at","embedding")
       VALUES ($1,$2,$3,$4,1536,$5,now(),$6::vector)`,
      id,
      fx.workspaceId,
      fx.projectId,
      MODEL,
      `th${i}`,
      `[${oneHot(i).join(',')}]`,
    );
  }

  // Give the planner honest statistics — without them its row estimates are
  // defaults and the plan it picks below says nothing about production.
  await adminDb.$executeRawUnsafe('ANALYZE "work_item_embedding"');
  await adminDb.$executeRawUnsafe('ANALYZE "work_item"');

  return {
    fx,
    targetProjectId: fx.projectId,
    targetIdentifiers,
    fillerProjectId: filler.id,
  };
}

/** Run inside a transaction with the workspace GUC bound, like the service does. */
async function bound<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

/**
 * Push the planner onto the ordered vector index.
 *
 * ⚠️ WHICH knobs are needed is itself the finding, so it is recorded here rather
 * than tuned until green. Turning off seq and bitmap scans is NOT enough:
 * `work_item_embedding_project_id_model_idx` offers a btree scan of the
 * project's rows plus an explicit Sort, and the planner prefers that — an EXACT
 * plan, which is why a selective project never sees the hazard in this schema at
 * all. `enable_sort = off` removes that alternative, leaving the ANN index as the
 * only way to satisfy the inner `ORDER BY` — which is the plan a project holding
 * a large share of the table gets on its own, at a size no unit test should have
 * to build.
 *
 * `ef_search` is pinned at pgvector's DEFAULT (40), so the short read below is
 * the index's ordinary behaviour rather than an artificially starved one.
 */
async function forceAnnPath(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
  await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
  await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
  await tx.$executeRawUnsafe('SET LOCAL hnsw.ef_search = 40');
}

/** Whether a plan for the ranking query touches the ANN index. */
async function plansThroughAnnIndex(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<boolean> {
  const literal = `[${uniform(0.5).join(',')}]`;
  const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
    `EXPLAIN
     SELECT c."workItemId", c."identifier", c."distance" FROM (
       SELECT e."work_item_id" AS "workItemId", w."identifier",
              (e."embedding" <=> '${literal}'::vector) AS "distance"
       FROM "work_item_embedding" e
       JOIN "work_item" w ON w."id" = e."work_item_id"
       WHERE e."project_id" = '${projectId}' AND e."model" = '${MODEL}'
         AND e."embedding" IS NOT NULL AND w."archivedAt" IS NULL
       ORDER BY e."embedding" <=> '${literal}'::vector ASC
       LIMIT 10
     ) c ORDER BY c."distance" ASC, c."identifier" ASC`,
  );
  return rows.some((r) => r['QUERY PLAN'].includes('work_item_embedding_embedding_idx'));
}

describe('the HNSW pre-filter under-return is REAL', () => {
  it('forced onto the ANN index, a small project comes back SHORT', async () => {
    const t = await makeTable(FILLER_ROWS);

    const [rows, usedAnnIndex] = await bound(t.fx.workspaceId, async (tx) => {
      await forceAnnPath(tx);
      const result = await workItemEmbeddingRepository.rankByEmbedding(
        {
          projectId: t.targetProjectId,
          model: MODEL,
          queryEmbedding: uniform(0.5),
          limit: 10,
        },
        tx,
      );
      return [result, await plansThroughAnnIndex(tx, t.targetProjectId)] as const;
    });

    // The plan really IS the ANN index — without this the next assertion could
    // pass for some entirely different reason and prove nothing.
    expect(usedAnnIndex).toBe(true);
    // …and it loses rows that exist. THIS is the defect the mitigation answers:
    // no error, no warning, just a candidate-finder quietly failing to find.
    expect(rows.length).toBeLessThan(TARGET_ROWS);
  });

  it('disabling the ordered index recovers the FULL set from the same query', async () => {
    const t = await makeTable(FILLER_ROWS);

    const [rows, usedAnnIndex] = await bound(t.fx.workspaceId, async (tx) => {
      // Only `ef_search` and the mitigation — the seq/bitmap/sort knobs above are
      // deliberately NOT set, because that is the state the service runs in: it
      // has one lever, and the assertion is that the lever alone is enough.
      await tx.$executeRawUnsafe('SET LOCAL hnsw.ef_search = 40');
      await workItemEmbeddingRepository.disableOrderedIndexScan(tx);
      return [
        await workItemEmbeddingRepository.rankByEmbedding(
          {
            projectId: t.targetProjectId,
            model: MODEL,
            queryEmbedding: uniform(0.5),
            limit: 10,
          },
          tx,
        ),
        await plansThroughAnnIndex(tx, t.targetProjectId),
      ] as const;
    });

    expect(usedAnnIndex).toBe(false);
    expect(rows.map((r) => r.identifier).sort()).toEqual([...t.targetIdentifiers].sort());
  });

  it('the ANN index IS usable by the shipped query — the two-stage shape is why', async () => {
    // The other half of the same fact. If the identifier tiebreak sat in the
    // ranking `ORDER BY` beside the distance, no plan could ever use the index
    // and the migration would ship an index that costs every write and serves no
    // read. Keeping the tiebreak OUTSIDE the limited subquery is what makes the
    // index reachable — and therefore what makes the mitigation above necessary.
    const t = await makeTable(FILLER_ROWS);
    const usedAnnIndex = await bound(t.fx.workspaceId, async (tx) => {
      await forceAnnPath(tx);
      return plansThroughAnnIndex(tx, t.targetProjectId);
    });
    expect(usedAnnIndex).toBe(true);
  });
});

describe('rankSimilar — the guarantee', () => {
  it('returns a small project its FULL ranked set inside a large table', async () => {
    const t = await makeTable(FILLER_ROWS);

    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 10,
    });

    expect(result.rankable).toBe(TARGET_ROWS);
    expect(result.results).toHaveLength(TARGET_ROWS);
    expect(result.results.map((r) => r.identifier).sort()).toEqual([...t.targetIdentifiers].sort());
    // Never a filler row: the pre-filter is a filter, not a preference.
    expect(result.results.every((r) => r.identifier.startsWith('RNK-'))).toBe(true);
  });

  it('takes the exact fallback — and recovers — when the approximate pass comes up short', async () => {
    // The wiring, isolated from the planner. `rankByEmbedding` is made to
    // under-return ONCE, exactly as the index does at scale; the service must
    // notice (against `countRankable`), disable the ordered index, and re-run.
    const t = await makeTable(0);
    const real = workItemEmbeddingRepository.rankByEmbedding.bind(workItemEmbeddingRepository);
    const disable = vi.spyOn(workItemEmbeddingRepository, 'disableOrderedIndexScan');
    const rank = vi
      .spyOn(workItemEmbeddingRepository, 'rankByEmbedding')
      .mockImplementationOnce(async () => []);
    rank.mockImplementation(real);

    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 10,
    });

    expect(result.exactFallbackUsed).toBe(true);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(result.results).toHaveLength(TARGET_ROWS);
    vi.restoreAllMocks();
  });

  it('does NOT pay for the fallback when the first pass was already complete', async () => {
    const t = await makeTable(0);
    const disable = vi.spyOn(workItemEmbeddingRepository, 'disableOrderedIndexScan');

    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 10,
    });

    expect(result.exactFallbackUsed).toBe(false);
    expect(disable).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('an EMPTY project is complete at zero rows — not an endless fallback', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MT' });
    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 10,
    });
    expect(result).toMatchObject({ results: [], rankable: 0, exactFallbackUsed: false });
  });
});

describe('rankSimilar — ordering and the model filter', () => {
  it('orders by cosine distance, nearest first', async () => {
    const t = await makeTable(0);
    // `uniform(0)` is orthogonal to every one-hot vector, so make the query
    // match ONE of them exactly and assert it leads.
    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: oneHot(1),
      limit: 10,
    });
    expect(result.results[0]?.identifier).toBe('RNK-2');
    expect(result.results[0]?.distance).toBeCloseTo(0, 5);
  });

  it('EXCLUDES rows embedded with a different model — they are not comparable (§6.1)', async () => {
    const t = await makeTable(0);
    await adminDb.$executeRawUnsafe(
      `UPDATE "work_item_embedding" SET "model" = $1 WHERE "work_item_id" = 'tgt-0'`,
      OTHER_MODEL,
    );

    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 10,
    });

    // A model swap becomes a VISIBLE, rolling gap in `rankable` — not a silent
    // collapse in result quality.
    expect(result.rankable).toBe(TARGET_ROWS - 1);
    expect(result.results.map((r) => r.identifier)).not.toContain('RNK-1');
  });

  it('respects the limit and still reports the full rankable count', async () => {
    const t = await makeTable(0);
    const result = await workItemEmbeddingsService.rankSimilar({
      workspaceId: t.fx.workspaceId,
      projectId: t.targetProjectId,
      model: MODEL,
      queryEmbedding: uniform(0.5),
      limit: 1,
    });
    expect(result.results).toHaveLength(1);
    expect(result.rankable).toBe(TARGET_ROWS);
    expect(result.exactFallbackUsed).toBe(false);
  });
});

describe('efSearchForLimit', () => {
  it("never narrows below pgvector's own default", () => {
    expect(efSearchForLimit(1)).toBe(40);
    expect(efSearchForLimit(10)).toBe(40);
  });

  it('widens with the page, and stops at the ceiling', () => {
    expect(efSearchForLimit(50)).toBe(200);
    expect(efSearchForLimit(10_000)).toBe(1_000);
  });
});
