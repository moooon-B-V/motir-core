import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { mintJobToken } from '@/lib/ai/jobToken';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';
import { POST as similarPOST } from '@/app/api/internal/ai/similar-work-items/route';
import { POST as searchPOST } from '@/app/api/internal/ai/search-work-items/route';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestProject, createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-2694 · Subtask MOTIR-2697) — the semantic
// candidate-finder end-to-end through the REAL route, against a real Postgres
// with real pgvector and the real HNSW index.
//
// The file is deliberately built around ONE claim: the endpoint NAMES candidates
// and carries nothing else across the boundary. So the shape assertions are
// EXACT (`toEqual`, not `toMatchObject`) — a `toMatchObject` would pass on the
// day a body field starts leaking, which is the single failure
// `docs/decisions/plan-tree-embeddings.md` §2 exists to prevent.
//
// The before/after in `ranks by meaning…` is the other half: it drives the SAME
// conceptual query through this route and through the shipped `contains` route
// and shows one finding the card and the other finding nothing. That gap is the
// whole reason the story was written, so it is pinned as a test rather than
// asserted in prose.

const SERVICE_SECRET = 'core-callback-secret-test';
const MODEL = 'text-embedding-3-small';
const OTHER_MODEL = 'text-embedding-3-large';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_embedding", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A unit vector along one axis — deterministic, so every distance below is
 *  fixed by construction rather than by whatever the provider would have said. */
function oneHot(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

let seq = 0;

/**
 * Seed a work item AND its embedding directly.
 *
 * Raw SQL through the ADMIN client rather than `createTestWorkItem` + the write
 * path, for two reasons: the write path's embedding job calls `motir-ai` (which
 * no test may reach), and these tests need to PIN each item's vector so the
 * expected ranking is arithmetic rather than a property of a live model.
 */
async function seedItem(input: {
  fx: WorkItemFixture;
  projectId: string;
  key: number;
  identifier: string;
  title: string;
  descriptionMd?: string | null;
  embedding?: number[];
  model?: string;
  archived?: boolean;
}): Promise<string> {
  seq += 1;
  const id = `itm-${seq.toString().padStart(5, '0')}`;
  await adminDb.$executeRawUnsafe(
    `INSERT INTO "work_item"
       ("id","workspaceId","projectId","kind","key","identifier","title","descriptionMd",
        "reporterId","position","status","priority","archivedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,'task',$4,$5,$6,$7,$8,$9,'todo','medium',$10,now(),now())`,
    id,
    input.fx.workspaceId,
    input.projectId,
    input.key,
    input.identifier,
    input.title,
    input.descriptionMd ?? null,
    input.fx.ownerId,
    `a${seq.toString().padStart(5, '0')}`,
    input.archived ? new Date() : null,
  );
  if (input.embedding) {
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "work_item_embedding"
         ("work_item_id","workspace_id","project_id","model","dimensions","content_hash",
          "embedded_at","embedding")
       VALUES ($1,$2,$3,$4,${EMBEDDING_DIMENSIONS},$5,now(),$6::vector)`,
      id,
      input.fx.workspaceId,
      input.projectId,
      input.model ?? MODEL,
      `hash-${id}`,
      `[${input.embedding.join(',')}]`,
    );
  }
  return id;
}

function tokenFor(fx: WorkItemFixture, projectId?: string): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: projectId ?? fx.projectId,
  });
}

function req(opts: {
  bearer?: string;
  token?: string;
  body?: unknown;
  path?: string;
  rawBody?: string;
}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(`http://core/api/internal/ai/${opts.path ?? 'similar-work-items'}`, {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body ?? {}),
  });
}

/** The ordinary happy-path call: a valid vector, the pinned model, defaults. */
function similarReq(fx: WorkItemFixture, body: Record<string, unknown> = {}): Request {
  return req({
    bearer: SERVICE_SECRET,
    token: tokenFor(fx),
    body: { queryEmbedding: oneHot(0), model: MODEL, ...body },
  });
}

describe('POST /api/internal/ai/similar-work-items — auth (§4a + §4b)', () => {
  it('refuses a request with no service bearer', async () => {
    const fx = await makeWorkItemFixture();
    const res = await similarPOST(
      req({ token: tokenFor(fx), body: { queryEmbedding: oneHot(0), model: MODEL } }),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a wrong service bearer', async () => {
    const fx = await makeWorkItemFixture();
    const res = await similarPOST(
      req({
        bearer: 'not-the-secret',
        token: tokenFor(fx),
        body: { queryEmbedding: oneHot(0), model: MODEL },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a request with no job token', async () => {
    const res = await similarPOST(
      req({ bearer: SERVICE_SECRET, body: { queryEmbedding: oneHot(0), model: MODEL } }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/internal/ai/similar-work-items — the keys-not-prose invariant (ADR §2)', () => {
  it('returns key/title/score and NOTHING else for an item that definitely has a body', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const description =
      'A LONG DESCRIPTION THAT MUST NEVER CROSS THE BOUNDARY. It names the acceptance criteria, ' +
      'the context refs and the implementation plan — exactly the prose a retrieval channel would ' +
      'hand a prompt as ground truth, and exactly what this endpoint refuses to carry.';
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Board columns remember their collapsed state',
      descriptionMd: description,
      embedding: oneHot(0),
    });

    const res = await similarPOST(similarReq(fx));
    expect(res.status).toBe(200);
    const body = await res.json();

    // EXACT — a fourth key on the row fails here, which is the point.
    expect(body.results).toEqual([
      { key: 'SEM-1', title: 'Board columns remember their collapsed state', score: 1 },
    ]);
    expect(Object.keys(body).sort()).toEqual(['coverage', 'model', 'results']);
    expect(body.model).toBe(MODEL);
    expect(body.coverage).toEqual({ embedded: 1, total: 1 });

    // And the negative form, stated over the WIRE rather than over the parsed
    // object: no substring of the body text appears anywhere in the payload, so
    // a leak through some future nested field is caught too.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('MUST NEVER CROSS');
    expect(wire).not.toContain('descriptionMd');
  });
});

describe('POST /api/internal/ai/similar-work-items — ranking', () => {
  it('ranks by meaning, where the shipped `contains` search finds nothing', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    // The card whose TITLE shares no keyword at all with the query. This is the
    // exact pair from the story: a query for "persist UI preferences" against a
    // card called "Board columns remember their collapsed state".
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Board columns remember their collapsed state',
      embedding: oneHot(0),
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Unrelated: rotate the signing key',
      embedding: oneHot(1),
    });

    // BEFORE — the shipped substring filter, asked the question GATE 1 asks.
    const before = await searchPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        path: 'search-work-items',
        body: {
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [{ field: 'text', operator: 'contains', value: 'persist UI preferences' }],
          },
        },
      }),
    );
    expect(before.status).toBe(200);
    expect((await before.json()).items).toEqual([]);

    // AFTER — the same question as a vector. `oneHot(0)` stands in for the
    // embedding of "persist UI preferences": what the assertion pins is that the
    // endpoint returns the item whose vector is NEAREST, not the item whose title
    // shares a substring — and SEM-1 shares none.
    const after = await similarPOST(similarReq(fx));
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.results.map((r: { key: string }) => r.key)).toEqual(['SEM-1', 'SEM-2']);
    expect(body.results[0].score).toBeCloseTo(1, 6);
    expect(body.results[1].score).toBeCloseTo(0, 6);
  });

  it('excludes rows embedded with a DIFFERENT model — a hard filter, not a label', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Same model',
      embedding: oneHot(0),
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Other model, nearer vector',
      embedding: oneHot(0),
      model: OTHER_MODEL,
    });

    const res = await similarPOST(similarReq(fx));
    const body = await res.json();
    expect(body.results.map((r: { key: string }) => r.key)).toEqual(['SEM-1']);
    // Coverage counts the RANKABLE rows for this model, so the incomparable row
    // is absent from the numerator and present in the denominator — which is what
    // makes a mid-swap project legible instead of looking simply empty.
    expect(body.coverage).toEqual({ embedded: 1, total: 2 });
  });

  it('excludes ARCHIVED items from results while keeping their rows (ADR §5)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const archivedId = await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Archived but nearest',
      embedding: oneHot(0),
      archived: true,
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Live',
      embedding: oneHot(1),
    });

    const body = await (await similarPOST(similarReq(fx))).json();
    expect(body.results.map((r: { key: string }) => r.key)).toEqual(['SEM-2']);
    expect(body.coverage).toEqual({ embedded: 1, total: 1 });

    // The row survives, so un-archiving restores candidacy with no re-embed.
    const kept = await adminDb.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS "count" FROM "work_item_embedding" WHERE "work_item_id" = $1',
      archivedId,
    );
    expect(kept[0]?.count).toBe(1);
  });

  it('applies `minScore` as a threshold, and omitting it applies none', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Near',
      embedding: oneHot(0),
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Far',
      embedding: oneHot(1),
    });

    const unfiltered = await (await similarPOST(similarReq(fx))).json();
    expect(unfiltered.results).toHaveLength(2);

    const filtered = await (await similarPOST(similarReq(fx, { minScore: 0.5 }))).json();
    expect(filtered.results.map((r: { key: string }) => r.key)).toEqual(['SEM-1']);
    // The threshold filters the PAGE; it never narrows the coverage the caller
    // uses to judge whether "nothing matched" is a real answer.
    expect(filtered.coverage).toEqual({ embedded: 2, total: 2 });
  });
});

describe('POST /api/internal/ai/similar-work-items — the request shape', () => {
  it('CLAMPS an over-large limit rather than refusing it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    // 55 embedded rows, so the 50-row ceiling is a real boundary and not an
    // assertion about a set that was smaller than the cap anyway.
    for (let i = 0; i < 55; i += 1) {
      await seedItem({
        fx,
        projectId: fx.projectId,
        key: i + 1,
        identifier: `SEM-${i + 1}`,
        title: `Item ${i}`,
        embedding: oneHot(i),
      });
    }

    const res = await similarPOST(similarReq(fx, { limit: 9_999 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(50);
    expect(body.coverage).toEqual({ embedded: 55, total: 55 });
  });

  it('clamps a limit below the floor up to one', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'A',
      embedding: oneHot(0),
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'B',
      embedding: oneHot(1),
    });

    const res = await similarPOST(similarReq(fx, { limit: 0 }));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toHaveLength(1);
  });

  it('refuses a caller-supplied project rather than ignoring it', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const res = await similarPOST(similarReq(fx, { projectId: other.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SIMILAR_PROJECT_NOT_A_PARAMETER');
  });

  it('refuses a wrong-length query vector as a 400, never a database error', async () => {
    const fx = await makeWorkItemFixture();
    const res = await similarPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { queryEmbedding: [0.1, 0.2, 0.3], model: MODEL },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SIMILAR_DIMENSION_MISMATCH');
  });

  it.each([
    ['a missing query vector', { model: MODEL }],
    [
      'a non-numeric element in the vector',
      { queryEmbedding: [null, ...oneHot(0).slice(1)], model: MODEL },
    ],
    ['a missing model', { queryEmbedding: () => oneHot(0) }],
    ['a blank model', { queryEmbedding: () => oneHot(0), model: '  ' }],
    ['a non-numeric limit', { queryEmbedding: () => oneHot(0), model: MODEL, limit: 'ten' }],
    ['an out-of-range minScore', { queryEmbedding: () => oneHot(0), model: MODEL, minScore: 4 }],
    ['a non-numeric minScore', { queryEmbedding: () => oneHot(0), model: MODEL, minScore: 'high' }],
  ])('refuses %s with a 400', async (_label, raw) => {
    const fx = await makeWorkItemFixture();
    const body = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'function' ? v() : v]),
    );
    const res = await similarPOST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body }));
    expect(res.status).toBe(400);
  });

  it('refuses a non-JSON body with a 400', async () => {
    const fx = await makeWorkItemFixture();
    const res = await similarPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), rawBody: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses a JSON body that is not an object with a 400', async () => {
    const fx = await makeWorkItemFixture();
    const res = await similarPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), rawBody: '[1,2,3]' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/ai/similar-work-items — tenancy', () => {
  it('searches only the TOKEN’s project, never a sibling in the same workspace', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIB',
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Mine',
      embedding: oneHot(1),
    });
    // The sibling's row is NEARER the query, so a missing project filter would
    // put it first — the assertion cannot pass by accident of ordering.
    await seedItem({
      fx,
      projectId: sibling.id,
      key: 1,
      identifier: 'SIB-1',
      title: 'Not mine, and nearer',
      embedding: oneHot(0),
    });

    const mine = await (await similarPOST(similarReq(fx))).json();
    expect(mine.results.map((r: { key: string }) => r.key)).toEqual(['SEM-1']);
    expect(mine.coverage).toEqual({ embedded: 1, total: 1 });

    // And the mirror: a token for the SIBLING sees only the sibling's row.
    const theirs = await (
      await similarPOST(
        req({
          bearer: SERVICE_SECRET,
          token: tokenFor(fx, sibling.id),
          body: { queryEmbedding: oneHot(0), model: MODEL },
        }),
      )
    ).json();
    expect(theirs.results.map((r: { key: string }) => r.key)).toEqual(['SIB-1']);
  });

  it('is a 404, never a 403, for a project in ANOTHER workspace', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });
    await seedItem({
      fx: theirs,
      projectId: theirs.projectId,
      key: 1,
      identifier: 'THR-1',
      title: 'Their card',
      embedding: oneHot(0),
    });

    // A token minted for MY user + MY workspace but naming THEIR project — the
    // shape a confused-deputy attempt would take.
    const res = await similarPOST(
      req({
        bearer: SERVICE_SECRET,
        token: mintJobToken({
          userId: mine.ctx.userId,
          workspaceId: mine.ctx.workspaceId,
          projectId: theirs.projectId,
        }),
        body: { queryEmbedding: oneHot(0), model: MODEL },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('is a 404, never a 403, for a PRIVATE project the token’s user may not browse', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Hidden card',
      embedding: oneHot(0),
    });
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });
    // A real workspace member who is NOT a member of this private project — the
    // permission denial, as distinct from the cross-tenant case above.
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });

    const res = await similarPOST(
      req({
        bearer: SERVICE_SECRET,
        token: mintJobToken({
          userId: outsider.id,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
        body: { queryEmbedding: oneHot(0), model: MODEL },
      }),
    );
    // 404, not 403: a 403 would confirm the private project exists to someone who
    // may not see it (finding #26) — and it is the SAME answer the cross-tenant
    // case gets, which is the property that makes the pair non-enumerable.
    expect(res.status).toBe(404);
  });
});

describe('POST /api/internal/ai/similar-work-items — degradation is a 200 (ADR §6.1)', () => {
  it('returns an empty result and an HONEST coverage for a project nothing has indexed', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Never embedded',
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Also never embedded',
    });

    const res = await similarPOST(similarReq(fx));
    expect(res.status).toBe(200);
    // `0 / 2` — a real project with two items and nothing indexed. The caller can
    // tell this apart from `0 / 0` below, which is the unreadable-store reading.
    expect(await res.json()).toEqual({
      results: [],
      model: MODEL,
      coverage: { embedded: 0, total: 2 },
    });
  });

  it('still returns the full ranked set with the HNSW index absent', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Near',
      embedding: oneHot(0),
    });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 2,
      identifier: 'SEM-2',
      title: 'Far',
      embedding: oneHot(1),
    });
    await adminDb.$executeRawUnsafe('DROP INDEX IF EXISTS "work_item_embedding_embedding_idx"');
    try {
      const res = await similarPOST(similarReq(fx));
      expect(res.status).toBe(200);
      expect((await res.json()).results.map((r: { key: string }) => r.key)).toEqual([
        'SEM-1',
        'SEM-2',
      ]);
    } finally {
      // Rebuild it — this worker's database is reused by every later file.
      await adminDb.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "work_item_embedding_embedding_idx" ON "work_item_embedding" USING hnsw ("embedding" vector_cosine_ops)',
      );
    }
  });

  it('degrades an UNREADABLE embedding store to an empty 200 with a 0/0 coverage', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEM' });
    await seedItem({
      fx,
      projectId: fx.projectId,
      key: 1,
      identifier: 'SEM-1',
      title: 'Would have matched',
      embedding: oneHot(0),
    });

    // The failure this stands in for is real and not hypothetical: a self-hosted
    // build with no `vector` extension makes the `<=>` ranking throw. A planning
    // job must not fail because of it.
    const spy = vi
      .spyOn(workItemEmbeddingsService, 'rankSimilar')
      .mockRejectedValue(new Error('operator does not exist: vector <=> vector'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await similarPOST(similarReq(fx));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [],
        model: MODEL,
        coverage: { embedded: 0, total: 0 },
      });
      // And it is LOGGED. `0/0` tells the caller; without this line nothing tells
      // an operator, and a store that has been unreadable for a week looks
      // exactly like a project nobody has indexed.
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('semantic search degraded'),
        expect.objectContaining({ projectId: fx.projectId, model: MODEL }),
      );
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  });

  it('does NOT degrade an authorization failure into an empty 200', async () => {
    // The gate sits outside the catch on purpose: an empty 200 here would read to
    // the caller as "I looked and this project holds nothing", which is a
    // materially different (and wrong) statement from "you cannot see it".
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });
    const spy = vi
      .spyOn(workItemEmbeddingsService, 'rankSimilar')
      .mockRejectedValue(new Error('should never be reached'));
    try {
      const res = await similarPOST(
        req({
          bearer: SERVICE_SECRET,
          token: mintJobToken({
            userId: mine.ctx.userId,
            workspaceId: mine.ctx.workspaceId,
            projectId: theirs.projectId,
          }),
          body: { queryEmbedding: oneHot(0), model: MODEL },
        }),
      );
      expect(res.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT swallow an UNEXPECTED failure — the degradation catch is narrow', async () => {
    // The complement of the two tests above. Degrading a ranking failure to an
    // empty 200 is right; degrading *everything* would turn a genuine defect into
    // a silent "nothing matched", which is the very failure mode this story
    // exists to remove. So an error from the gate — anything other than the two
    // typed project refusals — propagates and becomes a 500.
    const fx = await makeWorkItemFixture();
    const spy = vi
      .spyOn(projectAccessService, 'assertCanBrowse')
      .mockRejectedValue(new Error('connection terminated unexpectedly'));
    try {
      await expect(similarPOST(similarReq(fx))).rejects.toThrow(
        'connection terminated unexpectedly',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
