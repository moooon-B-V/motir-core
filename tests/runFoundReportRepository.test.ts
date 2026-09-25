import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { runFoundReportRepository } from '@/lib/repositories/runFoundReportRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE RUN-FOUND REPORT's filing row (MOTIR-5544 · MOTIR-6282) against a real
// Postgres: `docs/decisions/run-found-trigger-dispatched-path.md`, *Idempotency*
// — one bug per stopped leg, keyed by the `DispatchRunCard` id, the row inserted
// and LOCKED before the create.
//
// Four properties, each only provable against the database itself:
//
//   1. RLS is SYSTEM-ADMIN ONLY — a workspace context reads ZERO rows, even of
//      its own leg's report; the system context reads what it wrote.
//   2. `insertIfAbsent` twice for one leg leaves ONE row.
//   3. `lockByLegId` in a second transaction BLOCKS until the first commits —
//      two real connections, not a mock.
//   4. Deleting the leg deletes its report (`ON DELETE CASCADE`).
//
// ⚠️ The dev/CI DB connects as the `prodect` superuser, which has BYPASSRLS, so
// the RLS assertions run under `SET LOCAL ROLE motir_app` (PRODECT_FINDINGS #5)
// — the local `asAppRole` copy every RLS suite carries.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Leg {
  userId: string;
  workspaceId: string;
  legId: string;
}

/** One tenant with a run and ONE leg, seeded as the owner. */
async function seedLeg(tag: string): Promise<Leg> {
  const n = seq++;
  const user = await adminDb.user.create({
    data: { name: `User ${tag}`, email: `run-found-${tag}-${n}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `run-found-org-${tag}-${n}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `run-found-ws-${tag}-${n}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `run-found-p-${tag}-${n}`,
      identifier: `F${tag.toUpperCase()}${n}`,
      workspaceId: workspace.id,
    },
  });
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      command: 'run_scope',
      createdById: user.id,
    },
  });
  const leg = await adminDb.dispatchRunCard.create({
    data: { workspaceId: workspace.id, dispatchRunId: run.id, position: 0 },
  });
  return { userId: user.id, workspaceId: workspace.id, legId: leg.id };
}

/** Bind the GUCs a runtime context binds, then drop to the non-bypass role. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('run_found_report RLS — SYSTEM-ADMIN ONLY', () => {
  it('a workspace context reads ZERO rows of it; the system context reads the row it wrote', async () => {
    const a = await seedLeg('a');

    // WRITTEN under the non-bypass role by the system context — the WITH CHECK
    // half of the one policy admits the trusted writer.
    const inserted = await asAppRole({ systemAdmin: true }, (tx) =>
      runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx),
    );
    expect(inserted).toBe(true);

    // The leg's OWN tenant sees nothing — the row is Motir's record, not theirs.
    const seenByTenant = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.runFoundReport.findMany(),
    );
    expect(seenByTenant).toEqual([]);

    const seenBySystem = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.runFoundReport.findMany(),
    );
    expect(seenBySystem.map((r) => r.dispatchRunCardId)).toEqual([a.legId]);
    expect(seenBySystem[0]!.workspaceId).toBe(a.workspaceId);
    expect(seenBySystem[0]!.outcome).toBeNull();
  });

  it('a workspace context cannot WRITE one — the WITH CHECK half', async () => {
    const a = await seedLeg('a');
    await expect(
      asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
        tx.runFoundReport.create({
          data: { dispatchRunCardId: a.legId, workspaceId: a.workspaceId },
        }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.runFoundReport.count()).toBe(0);
  });
});

describe('runFoundReportRepository — claim, lock, record', () => {
  it('insertIfAbsent twice for one leg leaves ONE row', async () => {
    const a = await seedLeg('a');

    const first = await withSystemContext((tx) =>
      runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx),
    );
    const second = await withSystemContext((tx) =>
      runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await adminDb.runFoundReport.count({ where: { dispatchRunCardId: a.legId } })).toBe(1);
  });

  it("a second transaction's lockByLegId BLOCKS until the first commits", async () => {
    const a = await seedLeg('a');
    await withSystemContext((tx) =>
      runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx),
    );

    const order: string[] = [];
    let held!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      held = resolve;
    });

    // Transaction ONE takes the lock, holds it, and records an outcome.
    const one = withSystemContext(async (tx) => {
      const id = await runFoundReportRepository.lockByLegId(a.legId, tx);
      expect(id).not.toBeNull();
      held();
      await sleep(400);
      await runFoundReportRepository.markOutcome(
        id!,
        { outcome: 'filed', filedWorkItemId: 'wi_1', filedWorkItemIdentifier: 'MOTIR-1' },
        tx,
      );
      order.push('one-committing');
    });

    await lockHeld;
    // Transaction TWO — a separate connection from the pool — asks for the
    // same lock while ONE still holds it.
    const startedAt = Date.now();
    const two = withSystemContext(async (tx) => {
      const id = await runFoundReportRepository.lockByLegId(a.legId, tx);
      order.push('two-locked');
      // Re-read UNDER the lock: ONE's conclusion is already visible.
      return runFoundReportRepository.findById(id!, tx);
    });

    const [, seenByTwo] = await Promise.all([one, two]);

    expect(order).toEqual(['one-committing', 'two-locked']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(seenByTwo?.outcome).toBe('filed');
    expect(seenByTwo?.filedWorkItemIdentifier).toBe('MOTIR-1');
    expect(seenByTwo?.filedWorkItemId).toBe('wi_1');
  });

  it('lockByLegId answers null for a leg with no row; findById null for an unknown id', async () => {
    const a = await seedLeg('a');
    await withSystemContext(async (tx) => {
      expect(await runFoundReportRepository.lockByLegId(a.legId, tx)).toBeNull();
      expect(await runFoundReportRepository.findById('nope', tx)).toBeNull();
    });
  });

  it('markOutcome records an arm that files nothing with null bug columns', async () => {
    const a = await seedLeg('a');
    const row = await withSystemContext(async (tx) => {
      await runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx);
      const id = await runFoundReportRepository.lockByLegId(a.legId, tx);
      return runFoundReportRepository.markOutcome(id!, { outcome: 'changed' }, tx);
    });
    expect(row.outcome).toBe('changed');
    expect(row.filedWorkItemId).toBeNull();
    expect(row.filedWorkItemIdentifier).toBeNull();
  });
});

describe('run_found_report follows its leg', () => {
  it('deleting the DispatchRunCard deletes its report (ON DELETE CASCADE)', async () => {
    const a = await seedLeg('a');
    await withSystemContext((tx) =>
      runFoundReportRepository.insertIfAbsent(a.legId, a.workspaceId, tx),
    );
    expect(await adminDb.runFoundReport.count()).toBe(1);

    await adminDb.dispatchRunCard.delete({ where: { id: a.legId } });

    expect(await adminDb.runFoundReport.count()).toBe(0);
  });
});
