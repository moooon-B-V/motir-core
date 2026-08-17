import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemEmbeddingRepository } from '@/lib/repositories/workItemEmbeddingRepository';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `work_item_embedding` RLS — the direct-DB tenancy proof (Story MOTIR-2694 ·
// Subtask MOTIR-2696, ADR §5). The Story-MOTIR-2694 companion to
// tests/work-item-rls.test.ts, which proves the same shape for `work_item`.
//
// ⚠️ CRITICAL (PRODECT_FINDINGS #5): the dev/CI database connects as the
// `prodect` superuser, which has BYPASSRLS — RLS is INERT under it regardless of
// FORCE ROW LEVEL SECURITY. So every assertion below runs inside a transaction
// that `SET LOCAL ROLE motir_app` (the NOSUPERUSER NOBYPASSRLS role the
// add_workspace_rls migration installs, renamed by
// 20260810000000_rename_app_role_to_motir_app). Without the role switch each of
// these would assert the OPPOSITE of reality — a green suite proving nothing.
// The role reverts at transaction end.
//
// `asAppRole` is deliberately a local copy of the helper in
// work-item-rls.test.ts / project-rls.test.ts: the RLS suites each carry their
// own, so a shared edit cannot silently weaken all of them at once.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** A deterministic unit-ish vector; the values are irrelevant to tenancy. */
function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed % 1536 ? 1 : 0));
}

interface Tenants {
  w1: string;
  w2: string;
  p1: string;
  p2: string;
  item1: string;
  item2: string;
}

/** Two independent tenants, each with one project, one item, one embedding.
 *  Seeded as the OWNER (fixtures legitimately span tenants — adminDb rationale). */
async function makeTenants(): Promise<Tenants> {
  const fxA = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'TA' });
  const fxB = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'TB' });
  const itemA = await createTestWorkItem(fxA, { kind: 'task', title: 'A task' });
  const itemB = await createTestWorkItem(fxB, { kind: 'task', title: 'B task' });

  for (const [fx, item, seed] of [
    [fxA, itemA, 1],
    [fxB, itemB, 2],
  ] as const) {
    await adminDb.$transaction((tx) =>
      workItemEmbeddingRepository.upsert(
        {
          workItemId: item.id,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          model: 'text-embedding-3-small',
          dimensions: 1536,
          contentHash: `hash-${seed}`,
          embeddedAt: new Date(),
          embedding: vector(seed),
        },
        tx,
      ),
    );
  }

  return {
    w1: fxA.workspaceId,
    w2: fxB.workspaceId,
    p1: fxA.projectId,
    p2: fxB.projectId,
    item1: itemA.id,
    item2: itemB.id,
  };
}

describe('work_item_embedding RLS — read isolation', () => {
  it('with NO workspace GUC bound, the motir_app role sees ZERO rows', async () => {
    await makeTenants();
    const rows = await asAppRole({}, (tx) => tx.workItemEmbedding.findMany());
    // The policy compares against `current_setting('app.workspace_id', true)`,
    // which is NULL when unset — so the predicate is NULL and every row is
    // hidden. Failing CLOSED is the point: an unbound background job reads
    // nothing rather than reading everything.
    expect(rows).toEqual([]);
  });

  it("with W1 bound, only W1's embeddings are visible — never W2's", async () => {
    const t = await makeTenants();
    const rows = await asAppRole({ workspaceId: t.w1 }, (tx) =>
      tx.workItemEmbedding.findMany({ select: { workItemId: true } }),
    );
    expect(rows.map((r) => r.workItemId)).toEqual([t.item1]);
  });

  it('a cross-tenant lookup BY PRIMARY KEY returns null, not the row', async () => {
    // Knowing the other tenant's work-item id must not be enough — the PK is the
    // FK here, so a leaked id would otherwise be a direct handle on the row.
    const t = await makeTenants();
    const found = await asAppRole({ workspaceId: t.w1 }, (tx) =>
      workItemEmbeddingRepository.findByWorkItemId(t.item2, tx),
    );
    expect(found).toBeNull();
  });

  it("the ranking read never crosses tenants, even asked for the other tenant's project", async () => {
    // The endpoint resolves `projectId` from the token, but the storage layer
    // must not depend on that being true: bound to W1, a query naming W2's
    // project returns nothing rather than W2's rows.
    const t = await makeTenants();
    const rows = await asAppRole({ workspaceId: t.w1 }, (tx) =>
      workItemEmbeddingRepository.rankByEmbedding(
        {
          projectId: t.p2,
          model: 'text-embedding-3-small',
          queryEmbedding: vector(2),
          limit: 10,
        },
        tx,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("countRankable is likewise blind to the other tenant's project", async () => {
    const t = await makeTenants();
    const count = await asAppRole({ workspaceId: t.w1 }, (tx) =>
      workItemEmbeddingRepository.countRankable(t.p2, 'text-embedding-3-small', tx),
    );
    expect(count).toBe(0);
  });
});

describe('work_item_embedding RLS — write isolation', () => {
  it('refuses to write a row into ANOTHER workspace (WITH CHECK)', async () => {
    const t = await makeTenants();
    const itemInW2 = t.item2;
    await expect(
      asAppRole({ workspaceId: t.w1 }, (tx) =>
        workItemEmbeddingRepository.upsert(
          {
            workItemId: itemInW2,
            workspaceId: t.w2,
            projectId: t.p2,
            model: 'text-embedding-3-small',
            dimensions: 1536,
            contentHash: 'smuggled',
            embeddedAt: new Date(),
            embedding: vector(3),
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot OVERWRITE another tenant's embedding by claiming its own workspace id", async () => {
    // The other half of the same attack: the WITH CHECK above stops a row LABELLED
    // for W2, so try a row labelled W1 pointing at W2's item. The insert's post-image
    // passes WITH CHECK — the FK is what must (and does) refuse it, since W2's item
    // is invisible from here... and if it did land, the USING clause of the ON
    // CONFLICT update could not see W2's existing row either. Assert the row is
    // untouched whichever way it fails.
    const t = await makeTenants();
    await asAppRole({ workspaceId: t.w1 }, (tx) =>
      workItemEmbeddingRepository
        .upsert(
          {
            workItemId: t.item2,
            workspaceId: t.w1,
            projectId: t.p1,
            model: 'text-embedding-3-small',
            dimensions: 1536,
            contentHash: 'smuggled',
            embeddedAt: new Date(),
            embedding: vector(4),
          },
          tx,
        )
        .catch(() => 0),
    );

    // Read back as the OWNER: W2's row still carries its original hash.
    const row = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: t.item2 } });
    expect(row?.contentHash).toBe('hash-2');
  });
});

describe('work_item_embedding — the row dies with the item (ADR §4)', () => {
  it('hard-deleting the work item cascades the embedding away', async () => {
    const t = await makeTenants();
    await adminDb.workItem.delete({ where: { id: t.item1 } });
    expect(
      await adminDb.workItemEmbedding.findUnique({ where: { workItemId: t.item1 } }),
    ).toBeNull();
  });

  it('ARCHIVING the work item KEEPS the embedding (ADR §5 — un-archive needs no re-embed)', async () => {
    const t = await makeTenants();
    await adminDb.workItem.update({ where: { id: t.item1 }, data: { archivedAt: new Date() } });
    expect(
      await adminDb.workItemEmbedding.findUnique({ where: { workItemId: t.item1 } }),
    ).not.toBeNull();
  });

  it('an ARCHIVED item is excluded from RESULTS while its row is kept', async () => {
    const t = await makeTenants();
    await adminDb.workItem.update({ where: { id: t.item1 }, data: { archivedAt: new Date() } });
    const [rows, count] = await asAppRole({ workspaceId: t.w1 }, async (tx) => [
      await workItemEmbeddingRepository.rankByEmbedding(
        {
          projectId: t.p1,
          model: 'text-embedding-3-small',
          queryEmbedding: vector(1),
          limit: 10,
        },
        tx,
      ),
      await workItemEmbeddingRepository.countRankable(t.p1, 'text-embedding-3-small', tx),
    ]);
    expect(rows).toEqual([]);
    // countRankable must AGREE with the ranking read, or the service's
    // under-return fallback would fire on every query in this project.
    expect(count).toBe(0);
  });
});
