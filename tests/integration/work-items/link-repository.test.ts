import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { truncateAuthTables } from '../../helpers/db';
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
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
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

describe('workItemLinkRepository.create — workspace consistency trigger', () => {
  it('rejects a link whose fromItem and toItem live in different workspaces (WI_LINK_CROSS_WORKSPACE)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const a = await createWorkItem(fxA, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fxB, { kind: 'task', title: 'B' });

    await expect(
      createLink({
        // workspaceId matches one side; the trigger compares the two items
        // and rejects regardless because they disagree.
        workspaceId: fxA.workspace.id,
        fromId: a.id,
        toId: b.id,
        kind: 'relates_to',
        createdById: fxA.owner.id,
      }),
    ).rejects.toBeInstanceOf(CrossWorkspaceLinkError);
  });

  it('rejects a same-workspace link whose denormalized workspaceId is wrong (WI_LINK_WORKSPACE_MISMATCH)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const a = await createWorkItem(fxA, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fxA, { kind: 'task', title: 'B' });

    // Same-workspace items, but the link row carries the WRONG workspaceId
    // (workspace B). The trigger's mismatch branch surfaces a distinct typed
    // error so this service-layer bug shape is visible.
    await expect(
      createLink({
        workspaceId: fxB.workspace.id,
        fromId: a.id,
        toId: b.id,
        kind: 'relates_to',
        createdById: fxA.owner.id,
      }),
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

    const all = await workItemLinkRepository.findByFromItem(a.id);
    expect(all.map((l) => l.kind).sort()).toEqual(['is_blocked_by', 'relates_to']);

    const blockers = await workItemLinkRepository.findByFromItem(a.id, 'is_blocked_by');
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

    const all = await workItemLinkRepository.findByToItem(c.id);
    expect(all.map((l) => l.kind).sort()).toEqual(['duplicates', 'is_blocked_by']);

    const dups = await workItemLinkRepository.findByToItem(c.id, 'duplicates');
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

    const found = await workItemLinkRepository.findById(link.id);
    expect(found?.id).toBe(link.id);

    await db.$transaction((tx) => workItemLinkRepository.delete(link.id, tx));

    const missing = await workItemLinkRepository.findById(link.id);
    expect(missing).toBeNull();
  });
});
