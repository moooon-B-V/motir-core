import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { db } from '@/lib/db';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import {
  CrossWorkspaceLinkError,
  DuplicateLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkspaceMismatchLinkError,
} from '@/lib/workItems/linkErrors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  createTestLink as createLink,
} from '../../fixtures';

// Integration tests for workItemLinkRepository against a REAL Postgres (Yue's
// no-mocks rule). These exercise the DB-layer triggers through the repository
// edge: the cycle trigger (is_blocked_by-scoped), the workspaceId-consistency
// trigger, the self-link rejection, and the Prisma P2002 → DuplicateLinkError
// translation. The mapper is exercised in the happy-path test so the DTO
// shape is locked alongside the persistence.
//
// The fixture (makeFixture), work-item builder (createWorkItem), and link
// builder (createLink) now come from tests/fixtures/ (Subtask 1.4.7) — the
// per-file copies were unified there. makeFixture takes { name, identifier }
// so the cross-workspace cases can mint two distinct tenants.
//
// work_item_link truncates with the auth tables: TRUNCATE ... CASCADE on
// workspace/user carries it via the FKs, but we name it explicitly first
// for intent + resilience if that cascade ever changes (mirrors what
// repository.test.ts does for work_item).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workItemLinkRepository.create — happy path', () => {
  it('persists a link and returns a row whose mapper produces the expected DTO', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    const link = await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    expect(link.id).toBeTruthy();
    expect(link.fromId).toBe(a.id);
    expect(link.toId).toBe(b.id);
    expect(link.kind).toBe('is_blocked_by');
    expect(link.workspaceId).toBe(fx.workspace.id);

    const dto = toWorkItemLinkDto(link);
    expect(dto).toEqual({
      id: link.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
      createdAt: link.createdAt.toISOString(),
    });
    // workspaceId is internal infrastructure — must not appear on the DTO.
    expect(dto).not.toHaveProperty('workspaceId');
  });
});

describe('workItemLinkRepository.create — cycle trigger (is_blocked_by only)', () => {
  it('rejects A is_blocked_by B then B is_blocked_by A with WorkItemLinkCycleError', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    await expect(
      createLink({
        workspaceId: fx.workspace.id,
        fromId: b.id,
        toId: a.id,
        kind: 'is_blocked_by',
        createdById: fx.owner.id,
      }),
    ).rejects.toBeInstanceOf(WorkItemLinkCycleError);
  });

  // Subtask 1.4.7 gap-fill: the card calls for the DEEPER link cycle —
  // A is_blocked_by B, B is_blocked_by C, then C is_blocked_by A closes a
  // 3-edge cycle. The trigger's recursive CTE must walk A → B → C to discover
  // that the new C→A edge reaches back to A. (The test above closes a 2-cycle;
  // this exercises one more recursion hop.)
  it('rejects a 3-hop is_blocked_by cycle (A→B→C, then C→A) on the closing edge', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });

    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: b.id,
      toId: c.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    // C is_blocked_by A closes the chain A → B → C → A.
    await expect(
      createLink({
        workspaceId: fx.workspace.id,
        fromId: c.id,
        toId: a.id,
        kind: 'is_blocked_by',
        createdById: fx.owner.id,
      }),
    ).rejects.toBeInstanceOf(WorkItemLinkCycleError);
  });

  it('allows the relates_to reciprocal pair A↔B (the cycle trigger is scoped to is_blocked_by)', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    const ab = await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });
    const ba = await createLink({
      workspaceId: fx.workspace.id,
      fromId: b.id,
      toId: a.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });

    expect(ab.id).toBeTruthy();
    expect(ba.id).toBeTruthy();
  });
});

// ⚠️ THESE TWO WRITES RUN AS THE OWNER, NOT THROUGH `createLink` (MOTIR-2881).
// The subject is a TWO-TENANT claim — the trigger compares fromItem's workspace with
// toItem's — and no single bound context can see both items, so there is no context
// to write them under. Under `motir_app` the trigger's own lookups are RLS-filtered:
// the foreign item reads as MISSING, the function takes its "defer to the FK" branch,
// and the insert SUCCEEDS. That is a real defect in the backstop rather than a test
// problem — a `lib/`+migration fix, out of this card's scope — and it is filed as
// MOTIR-2884. Running these as the owner keeps the trigger's own claim under test
// here; the role-specific hole belongs to that card, with its own regression case.
describe('workItemLinkRepository.create — workspace consistency trigger', () => {
  it('rejects a link whose fromItem and toItem live in different workspaces (WI_LINK_CROSS_WORKSPACE)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const a = await createWorkItem(fxA, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fxB, { kind: 'task', title: 'B' });

    await expect(
      adminDb.$transaction((tx) =>
        workItemLinkRepository.create(
          {
            // workspaceId matches one side; the trigger compares the two items
            // and rejects regardless because they disagree.
            workspaceId: fxA.workspace.id,
            fromId: a.id,
            toId: b.id,
            kind: 'relates_to',
            createdById: fxA.owner.id,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(CrossWorkspaceLinkError);
  });

  it('rejects a same-workspace link whose denormalized workspaceId is wrong (WI_LINK_WORKSPACE_MISMATCH)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const a = await createWorkItem(fxA, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fxA, { kind: 'task', title: 'B' });

    // Same-workspace items, but the link row carries the WRONG workspaceId
    // (workspace B). The trigger's mismatch branch surfaces a distinct typed
    // error so this service-layer bug shape is visible. Owner-side for the reason
    // in the block comment above this describe.
    await expect(
      adminDb.$transaction((tx) =>
        workItemLinkRepository.create(
          {
            workspaceId: fxB.workspace.id,
            fromId: a.id,
            toId: b.id,
            kind: 'relates_to',
            createdById: fxA.owner.id,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkspaceMismatchLinkError);
  });
});

describe('workItemLinkRepository.create — self-link trigger', () => {
  it('rejects fromId = toId with SelfLinkError', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });

    await expect(
      createLink({
        workspaceId: fx.workspace.id,
        fromId: a.id,
        toId: a.id,
        kind: 'relates_to',
        createdById: fx.owner.id,
      }),
    ).rejects.toBeInstanceOf(SelfLinkError);
  });
});

describe('workItemLinkRepository.create — duplicate-link rejection', () => {
  it('rejects the same (fromId, toId, kind) twice with DuplicateLinkError', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });

    await expect(
      createLink({
        workspaceId: fx.workspace.id,
        fromId: a.id,
        toId: b.id,
        kind: 'relates_to',
        createdById: fx.owner.id,
      }),
    ).rejects.toBeInstanceOf(DuplicateLinkError);
  });

  it('allows the same (fromId, toId) pair with a different kind', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });
    const relates = await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });

    expect(relates.id).toBeTruthy();
  });
});

describe('workItemLinkRepository.findByFromItem / findByToItem', () => {
  it('findByFromItem with no kind filter returns every link kind out of the item', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });

    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: c.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });

    const all = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findByFromItem(a.id, undefined, tx),
    );
    expect(all.map((l) => l.kind).sort()).toEqual(['is_blocked_by', 'relates_to']);

    const blockers = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findByFromItem(a.id, 'is_blocked_by', tx),
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.toId).toBe(b.id);
  });

  it('findByToItem with no kind filter returns every link kind into the item', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });

    // a is_blocked_by c, b duplicates c — both arrows into c.
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: c.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: b.id,
      toId: c.id,
      kind: 'duplicates',
      createdById: fx.owner.id,
    });

    const all = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findByToItem(c.id, undefined, tx),
    );
    expect(all.map((l) => l.kind).sort()).toEqual(['duplicates', 'is_blocked_by']);

    const dups = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findByToItem(c.id, 'duplicates', tx),
    );
    expect(dups).toHaveLength(1);
    expect(dups[0]!.fromId).toBe(b.id);
  });
});

describe('workItemLinkRepository.findById + delete', () => {
  it('findById returns the row and null after delete', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });

    const link = await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'relates_to',
      createdById: fx.owner.id,
    });

    const found = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findById(link.id, tx),
    );
    expect(found?.id).toBe(link.id);

    await withWorkspaceContext(fx.ctx, (tx) => workItemLinkRepository.delete(link.id, tx));

    const missing = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findById(link.id, tx),
    );
    expect(missing).toBeNull();
  });
});

describe('workItemLinkRepository.findAnyBetween — any kind, either direction (5.8.3)', () => {
  it('finds an existing link in BOTH orderings via the read path (no tx → db), null when unrelated', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    // No tx → exercises the `tx ?? dbRead` fallback. The OR matches a→b…
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findAnyBetween(a.id, b.id, tx),
      ),
    ).not.toBeNull();
    // …and the reverse ordering b→a (the "either direction" gate).
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findAnyBetween(b.id, a.id, tx),
      ),
    ).not.toBeNull();
    // An unrelated pair is genuinely absent.
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findAnyBetween(a.id, c.id, tx),
      ),
    ).toBeNull();
  });
});

describe('workItemLinkRepository.createIfAbsent — idempotent insert (5.8.3)', () => {
  it('inserts when absent, then returns null on the duplicate (skipDuplicates) — never raises P2002', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const data = {
      workspaceId: fx.workspace.id,
      fromId: a.id,
      toId: b.id,
      kind: 'relates_to' as const,
      createdById: fx.owner.id,
    };

    // First insert → the row (the `rows[0]` branch).
    const first = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.createIfAbsent(data, tx),
    );
    expect(first).not.toBeNull();
    expect(first?.fromId).toBe(a.id);
    expect(first?.kind).toBe('relates_to');

    // Same (fromId, toId, kind) → the @@unique already holds → null (the
    // `?? null` skip branch), and crucially NO P2002 escapes the transaction.
    const second = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.createIfAbsent(data, tx),
    );
    expect(second).toBeNull();
  });
});

// The BATCH form (MOTIR-3396). `createIfAbsent` was an array API called with an
// array of one, so `plansService.materialize` wired a plan's whole `blocked_by`
// graph one round trip per edge — 27 sequential Fly→Neon waits inside an
// interactive transaction on Prisma's default 5 s budget, which is what made
// approving a 15-item plan return P2028.
//
// The wall-clock failure is a LATENCY phenomenon and a local Postgres cannot
// reproduce it, so what is asserted here is the property that removes it: N rows
// go out in ONE statement, and batching costs none of the per-row structural
// enforcement the sequential form had.
describe('workItemLinkRepository.createManyIfAbsent — one statement for N links (MOTIR-3396)', () => {
  it('issues exactly ONE createManyAndReturn for N rows, with skipDuplicates', async () => {
    // A hand-rolled `tx` double rather than a real one: the claim under test is
    // "one round trip, not N", and the only place that is directly observable is
    // the call the repository makes into Prisma. The real-Postgres behaviour of
    // the same call is covered by the sibling cases below.
    const calls: Array<{ data: unknown; skipDuplicates: unknown }> = [];
    const fakeTx = {
      workItemLink: {
        createManyAndReturn: async (args: { data: unknown[]; skipDuplicates: boolean }) => {
          calls.push({ data: args.data, skipDuplicates: args.skipDuplicates });
          return args.data;
        },
      },
    } as unknown as Parameters<typeof workItemLinkRepository.createManyIfAbsent>[1];

    const rows = Array.from({ length: 27 }, (_, i) => ({
      workspaceId: 'ws',
      fromId: `from-${i}`,
      toId: `to-${i}`,
      kind: 'is_blocked_by' as const,
      createdById: 'user',
    }));
    const returned = await workItemLinkRepository.createManyIfAbsent(rows, fakeTx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toHaveLength(27);
    expect(calls[0]!.skipDuplicates).toBe(true);
    expect(returned).toHaveLength(27);
  });

  it('an EMPTY batch issues no query at all', async () => {
    let called = false;
    const fakeTx = {
      workItemLink: {
        createManyAndReturn: async () => {
          called = true;
          return [];
        },
      },
    } as unknown as Parameters<typeof workItemLinkRepository.createManyIfAbsent>[1];

    await expect(workItemLinkRepository.createManyIfAbsent([], fakeTx)).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it('inserts every row and skips a duplicate already present, against real Postgres', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });
    const base = { workspaceId: fx.workspace.id, createdById: fx.owner.id };

    // Pre-existing edge, so the batch below carries one duplicate.
    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.createIfAbsent(
        { ...base, fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
        tx,
      ),
    );

    const inserted = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.createManyIfAbsent(
        [
          { ...base, fromId: a.id, toId: b.id, kind: 'is_blocked_by' }, // duplicate
          { ...base, fromId: a.id, toId: c.id, kind: 'is_blocked_by' },
          { ...base, fromId: b.id, toId: c.id, kind: 'is_blocked_by' },
        ],
        tx,
      ),
    );

    // The duplicate is SKIPPED, not raised — so a plan proposing the same edge
    // twice is idempotent rather than an aborted approve.
    expect(inserted).toHaveLength(2);
    const all = await adminDb.workItemLink.findMany({ where: { kind: 'is_blocked_by' } });
    expect(all).toHaveLength(3);
  });

  it('still rejects a cycle formed BETWEEN two rows of the SAME batch — the BEFORE-ROW trigger sees earlier rows of its own statement', async () => {
    // The correctness claim batching could plausibly have broken, so it is
    // asserted rather than reasoned about: `enforce_work_item_link_no_cycle`
    // walks `work_item_link`, and if rows inserted earlier in the same statement
    // were invisible to it, A↔B inside one batch would slip past a check two
    // separate inserts enforce.
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const base = { workspaceId: fx.workspace.id, createdById: fx.owner.id };

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.createManyIfAbsent(
          [
            { ...base, fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
            { ...base, fromId: b.id, toId: a.id, kind: 'is_blocked_by' },
          ],
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkItemLinkCycleError);

    // Rolled back whole — the statement aborts, so neither edge survives.
    expect(await adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } })).toBe(0);
  });

  it('attributes the rejection to the OFFENDING row of the batch, not the first', async () => {
    // What a batch loses is which row failed; the trigger message interpolates
    // the ids, so it is recovered rather than guessed. Asserted because the
    // attribution is what keeps the typed error's diagnostics honest.
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });
    const base = { workspaceId: fx.workspace.id, createdById: fx.owner.id };

    // A is_blocked_by B first, so the LAST row of the next batch closes the loop.
    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository.createIfAbsent(
        { ...base, fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
        tx,
      ),
    );

    const err = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemLinkRepository
        .createManyIfAbsent(
          [
            { ...base, fromId: a.id, toId: c.id, kind: 'is_blocked_by' }, // fine
            { ...base, fromId: b.id, toId: a.id, kind: 'is_blocked_by' }, // the cycle
          ],
          tx,
        )
        .then(
          () => null,
          (e: unknown) => e,
        ),
    );

    expect(err).toBeInstanceOf(WorkItemLinkCycleError);
    expect((err as WorkItemLinkCycleError).attempted).toEqual({
      fromId: b.id,
      toId: a.id,
      kind: 'is_blocked_by',
    });
  });

  it('createIfAbsent now TRANSLATES a trigger rejection, since it delegates to the batch form', async () => {
    // A behaviour CHANGE worth pinning: before delegating, `createIfAbsent`
    // caught nothing, so a trigger rejection escaped as a raw SQLSTATE-23514
    // Prisma error. Its one caller (auto-relate-on-mention) writes a shape no
    // trigger rejects, so nothing depended on the raw form — and a typed error
    // is what every other write path in this repository already produces.
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.createIfAbsent(
          {
            workspaceId: fx.workspace.id,
            fromId: a.id,
            toId: a.id,
            kind: 'relates_to',
            createdById: fx.owner.id,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(SelfLinkError);
  });

  it('falls back to the FIRST row when the rejection names no row — a workspace mismatch reports workspace ids, not link ids', async () => {
    // The attribution is best-effort by construction: `WI_LINK_WORKSPACE_MISMATCH`
    // interpolates the two WORKSPACE ids, so there is nothing in the message to
    // match a row on. The fallback keeps the typed error intact — which is the
    // property that matters, since this class carries no `attempted` payload and
    // the diagnostic is the only thing degraded.
    const fxA = await makeFixture({ name: 'Batch A', identifier: 'BTA' });
    const fxB = await makeFixture({ name: 'Batch B', identifier: 'BTB' });
    const a = await createWorkItem(fxA, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fxA, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fxA, { kind: 'task', title: 'C' });

    await expect(
      adminDb.$transaction((tx) =>
        workItemLinkRepository.createManyIfAbsent(
          [
            {
              workspaceId: fxA.workspace.id,
              fromId: a.id,
              toId: b.id,
              kind: 'relates_to',
              createdById: fxA.owner.id,
            },
            {
              workspaceId: fxB.workspace.id, // the wrong workspace
              fromId: a.id,
              toId: c.id,
              kind: 'relates_to',
              createdById: fxA.owner.id,
            },
          ],
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkspaceMismatchLinkError);
  });

  it('a batched SELF-link is rejected exactly as a single one is', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const base = { workspaceId: fx.workspace.id, createdById: fx.owner.id };

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemLinkRepository.createManyIfAbsent(
          [
            { ...base, fromId: a.id, toId: b.id, kind: 'relates_to' },
            { ...base, fromId: a.id, toId: a.id, kind: 'relates_to' },
          ],
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(SelfLinkError);
  });
});

// THE INHERITED-LINEAGE READ (MOTIR-2400) — "is this item ready from `main`, or
// on top of unmerged work?", for a whole page in one query.
//
// ⚠️ Its filter lives in the MAPPER rather than the `where` (MOTIR-2427): a
// blocker with no branch is the COMMON case, and duplicating the null test in
// both places made the mapper's arm unreachable — untestable by construction,
// and the reason this file could never reach its branch-coverage floor.
describe('workItemLinkRepository.findBlockerSessionBranchesForItems', () => {
  it('returns one row per blocker that carries a branch', async () => {
    const fx = await makeFixture();
    const dependent = await createWorkItem(fx, { kind: 'task', title: 'dependent' });
    const blocker = await createWorkItem(fx, { kind: 'task', title: 'blocker' });
    await adminDb.workItem.update({
      where: { id: blocker.id },
      data: { sessionBranch: 'motir/auto-1' },
    });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: dependent.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    expect(
      await withWorkspaceServiceContext(fx.workspace.id, (tx) =>
        workItemLinkRepository.findBlockerSessionBranchesForItems(
          [dependent.id],
          fx.workspace.id,
          tx,
        ),
      ),
    ).toEqual([{ fromId: dependent.id, sessionBranch: 'motir/auto-1' }]);
  });

  it('DROPS a blocker with no branch — the ordinary case, and the arm that used to be unreachable', async () => {
    const fx = await makeFixture();
    const dependent = await createWorkItem(fx, { kind: 'task', title: 'dependent' });
    const trunkBlocker = await createWorkItem(fx, {
      kind: 'task',
      title: 'not integrated anywhere',
    });
    await createLink({
      workspaceId: fx.workspace.id,
      fromId: dependent.id,
      toId: trunkBlocker.id,
      kind: 'is_blocked_by',
      createdById: fx.owner.id,
    });

    // An item whose blockers are all on `main` is simply ABSENT from the result
    // — the caller reads that as "ready from the trunk". BOUND (MOTIR-2881): the
    // edge and its blocker have to be VISIBLE for the mapper's null-branch to be
    // what empties the result; unbound, the policy empties it and the arm this
    // test exists for never runs.
    expect(
      await withWorkspaceServiceContext(fx.workspace.id, (tx) =>
        workItemLinkRepository.findBlockerSessionBranchesForItems(
          [dependent.id],
          fx.workspace.id,
          tx,
        ),
      ),
    ).toEqual([]);
  });

  it('answers an EMPTY id list without touching the database', async () => {
    const fx = await makeFixture();
    // Bound like every other call in this block (MOTIR-2911). The short-circuit
    // returns before any client is addressed, so it cannot fail unbound — which
    // is exactly why it must not READ as unbound: a reader, and the call-site
    // guard, cannot tell it apart from a live read that silently sees nothing.
    expect(
      await withWorkspaceServiceContext(fx.workspace.id, (tx) =>
        workItemLinkRepository.findBlockerSessionBranchesForItems([], fx.workspace.id, tx),
      ),
    ).toEqual([]);
  });

  it('scopes to a workspace when given one, and reads unscoped when not', async () => {
    // The `workspaceId` argument is optional, so BOTH arms ship. Unscoped is the
    // operator/internal path; scoped is what every request-time caller uses.
    const mine = await makeFixture();
    const theirs = await makeFixture({ name: 'Other', identifier: 'OTH' });
    const dependent = await createWorkItem(mine, { kind: 'task', title: 'dependent' });
    const blocker = await createWorkItem(mine, { kind: 'task', title: 'blocker' });
    await adminDb.workItem.update({
      where: { id: blocker.id },
      data: { sessionBranch: 'motir/auto-2' },
    });
    await createLink({
      workspaceId: mine.workspace.id,
      fromId: dependent.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: mine.owner.id,
    });

    // Unscoped ARGUMENT, bound CONTEXT (MOTIR-2881): the `workspaceId ? …` arm this
    // half exists to cover is the one where the argument is absent, and the read
    // still has to be admitted to return a row — under `motir_app` the operator path
    // is bound by its caller, not unbound.
    expect(
      await withWorkspaceServiceContext(mine.workspace.id, (tx) =>
        workItemLinkRepository.findBlockerSessionBranchesForItems([dependent.id], undefined, tx),
      ),
    ).toEqual([{ fromId: dependent.id, sessionBranch: 'motir/auto-2' }]);
    // Scoped to ANOTHER tenant: nothing, without an existence leak. Bound to MINE, so
    // the empty answer is the ARGUMENT's scoping and not the policy's.
    expect(
      await withWorkspaceServiceContext(mine.workspace.id, (tx) =>
        workItemLinkRepository.findBlockerSessionBranchesForItems(
          [dependent.id],
          theirs.workspace.id,
          tx,
        ),
      ),
    ).toEqual([]);
  });
});
