import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  isLowerThan,
  isMonitorLevel,
  meetsMinimumLevel,
  MONITOR_LEVELS,
} from '@/lib/monitors/levels';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import {
  monitorIssueRepository,
  type InsertMonitorIssueInput,
} from '@/lib/repositories/monitorIssueRepository';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

// The monitor-issue INGESTION STORE (Story MOTIR-4929 · Subtask MOTIR-5576) —
// `monitor_issue`, the connection's ingestion columns, the level vocabulary and
// the repository methods the reconciler composes. Real Postgres, per CLAUDE.md.
//
// Each block answers an acceptance criterion that names a TEST rather than an
// inspection:
//   · a deleted bug leaves its issue row pointing at nothing, key intact;
//   · RLS, on a fixture where the actor's view and the true population differ;
//   · two SIMULTANEOUS claims of one issue → one row, the loser reading the
//     winner's row after blocking on its lock;
//   · a rewind and an advance racing → the rewind is never overwritten;
//   · the watermark never moves backwards;
//   · the level predicate is total over its inputs;
//   · a bind records WHO bound it.
//
// ⚠️ RLS is INERT under the dev/CI superuser (PRODECT_FINDINGS #5), so the
// tenancy assertions run under `SET LOCAL ROLE motir_app` — the same `asAppRole`
// shape `monitor-connection-store.test.ts` carries, for the reason it gives.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Bound {
  fx: WorkItemFixture;
  installationRowId: string;
  connectionId: string;
}

let seq = 0;

/** A tenant with a grant and ONE binding, seeded as the owner. */
async function seedBinding(tag: string): Promise<Bound> {
  const n = seq++;
  const fx = await makeWorkItemFixture({
    name: `WS ${tag}`,
    identifier: `I${tag.toUpperCase()}${n}`,
  });
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: `install-${tag}-${n}`,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('a'),
      refreshTokenEncrypted: encryptToken('r'),
      tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      metadata: { orgSlug: `org-${tag}` },
    },
  });
  const connection = await adminDb.monitorConnection.create({
    data: {
      installationId: installation.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalProjectId: `ext-${tag}-${n}`,
      externalProjectSlug: `slug-${tag}`,
      boundByUserId: fx.ownerId,
    },
  });
  return { fx, installationRowId: installation.id, connectionId: connection.id };
}

function issueInput(b: Bound, externalIssueId: string): InsertMonitorIssueInput {
  return {
    connectionId: b.connectionId,
    projectId: b.fx.projectId,
    workspaceId: b.fx.workspaceId,
    externalIssueId,
    title: `TypeError in ${externalIssueId}`,
    culprit: 'app/page.tsx',
    level: 'error',
    permalink: `https://sentry.example/issues/${externalIssueId}`,
    eventCount: 1,
    firstSeenAt: new Date('2026-09-18T10:00:00Z'),
    lastSeenAt: new Date('2026-09-18T10:00:00Z'),
  };
}

async function asAppRole<T>(
  ctx: { userId: string; workspaceId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.project_id', '', true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** A transaction bound to the tenant's workspace — the shape the service opens. */
function inWorkspace<T>(b: Bound, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${b.fx.workspaceId}, true)`;
    return fn(tx);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a deleted bug leaves its issue row pointing at NOTHING, its key intact', () => {
  it('sets workItemId to null on delete and keeps filedWorkItemIdentifier', async () => {
    const b = await seedBinding('del');
    const bug = await createTestWorkItem(b.fx, { kind: 'bug', title: 'filed bug' });
    const row = await adminDb.monitorIssue.create({
      data: {
        ...issueInput(b, 'iss-del'),
        workItemId: bug.id,
        filedWorkItemIdentifier: bug.identifier,
      },
    });

    await adminDb.workItem.delete({ where: { id: bug.id } });

    const after = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.workItemId).toBeNull();
    expect(after.filedWorkItemIdentifier).toBe(bug.identifier);
  });
});

describe('monitor_issue RLS', () => {
  it('shows a workspace only its OWN issue rows — the true population is larger', async () => {
    const a = await seedBinding('a');
    const b = await seedBinding('b');
    await adminDb.monitorIssue.create({ data: issueInput(a, 'iss-a') });
    await adminDb.monitorIssue.create({ data: issueInput(b, 'iss-b') });

    // TWO rows exist; the actor may see exactly one — a fixture in which the
    // actor saw everything could not tell a scoped read from an unscoped one.
    expect(await adminDb.monitorIssue.count()).toBe(2);
    const seenByA = await asAppRole({ userId: a.fx.ownerId, workspaceId: a.fx.workspaceId }, (tx) =>
      tx.monitorIssue.findMany(),
    );
    expect(seenByA.map((r) => r.externalIssueId)).toEqual(['iss-a']);

    // Addressed by its dedup key, the other tenant's row is not even LOCKABLE.
    const locked = await asAppRole({ userId: a.fx.ownerId, workspaceId: a.fx.workspaceId }, (tx) =>
      monitorIssueRepository.lockByExternalId(b.connectionId, 'iss-b', tx),
    );
    expect(locked).toBeNull();
  });

  it('refuses a WRITE stamped with another workspace’s tenancy', async () => {
    const a = await seedBinding('a');
    const b = await seedBinding('b');
    await expect(
      asAppRole({ userId: a.fx.ownerId, workspaceId: a.fx.workspaceId }, (tx) =>
        monitorIssueRepository.insertIfAbsent(
          { ...issueInput(a, 'forged'), workspaceId: b.fx.workspaceId },
          tx,
        ),
      ),
    ).rejects.toThrow();
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });
});

describe('claim-or-lock under a REAL race', () => {
  it('two simultaneous claims of one issue leave ONE row, and the loser reads the winner’s', async () => {
    const b = await seedBinding('race');
    const bug = await createTestWorkItem(b.fx, { kind: 'bug', title: 'winner’s bug' });
    const order: string[] = [];

    // Each claimant: insert-if-absent, lock, re-read, and — if it finds the row
    // unfiled — "file" it while STILL HOLDING the lock (the reconciler's shape).
    const claim = (label: string) =>
      inWorkspace(b, async (tx) => {
        const inserted = await monitorIssueRepository.insertIfAbsent(issueInput(b, 'iss-race'), tx);
        const id = await monitorIssueRepository.lockByExternalId(b.connectionId, 'iss-race', tx);
        const row = await monitorIssueRepository.findById(id!, tx);
        order.push(`${label}:locked`);
        if (row!.workItemId === null) {
          // Hold the lock long enough that the other claimant is certainly
          // waiting on it, not merely scheduled after us.
          await sleep(300);
          await monitorIssueRepository.markFiled(row!.id, bug.id, bug.identifier, tx);
          return { label, inserted, sawFiled: false };
        }
        return { label, inserted, sawFiled: true };
      });

    const results = await Promise.all([claim('one'), claim('two')]);

    expect(await adminDb.monitorIssue.count()).toBe(1);
    // Exactly one filed; the other blocked, then read the row AS THE WINNER LEFT
    // IT — which is what stops a second bug. No unique-violation reached either.
    expect(results.filter((r) => r.sawFiled)).toHaveLength(1);
    expect(results.filter((r) => !r.sawFiled)).toHaveLength(1);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    const row = await adminDb.monitorIssue.findFirstOrThrow();
    expect(row.workItemId).toBe(bug.id);
  });
});

describe('the watermark', () => {
  it('never moves BACKWARDS — advancing to T2 then T1 < T2 reads T2 back', async () => {
    const b = await seedBinding('wm');
    const t1 = new Date('2026-09-18T10:00:00Z');
    const t2 = new Date('2026-09-18T11:00:00Z');

    const first = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(b.connectionId, t2, null, tx),
    );
    const second = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(b.connectionId, t1, null, tx),
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: b.connectionId },
    });
    expect(row.lastSeenWatermark?.toISOString()).toBe(t2.toISOString());
  });

  it('does not apply when the minimum level changed since the poll read it', async () => {
    const b = await seedBinding('lvl');
    await adminDb.monitorConnection.update({
      where: { id: b.connectionId },
      data: { minimumLevel: 'warning' },
    });

    const stale = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(b.connectionId, new Date(), 'error', tx),
    );
    expect(stale.applied).toBe(false);
    const matching = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(b.connectionId, new Date(), 'warning', tx),
    );
    expect(matching.applied).toBe(true);
  });

  it('a REWIND racing an advance is never overwritten, whichever commits first', async () => {
    const b = await seedBinding('rw');
    const before = new Date('2026-09-18T09:00:00Z');
    await adminDb.monitorConnection.update({
      where: { id: b.connectionId },
      data: { minimumLevel: 'error', lastSeenWatermark: before },
    });

    // The rewind takes the row lock first and HOLDS it; the advance — read at
    // `error` — is issued while the rewind is uncommitted, so it has to wait and
    // then re-evaluate its predicate against the committed row.
    let rewindHolding!: () => void;
    const holding = new Promise<void>((resolve) => (rewindHolding = resolve));
    const rewind = inWorkspace(b, async (tx) => {
      await monitorConnectionRepository.setMinimumLevel(b.connectionId, 'warning', true, tx);
      rewindHolding();
      await sleep(300);
    });
    await holding;
    const advance = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(
        b.connectionId,
        new Date('2026-09-18T12:00:00Z'),
        'error',
        tx,
      ),
    );
    await rewind;

    expect(advance.applied).toBe(false);
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: b.connectionId },
    });
    expect(row.minimumLevel).toBe('warning');
    expect(row.lastSeenWatermark).toBeNull();
  });

  it('the other order: an advance that commits first is then rewound, and stays rewound', async () => {
    const b = await seedBinding('rw2');
    await adminDb.monitorConnection.update({
      where: { id: b.connectionId },
      data: { minimumLevel: 'error' },
    });

    const advance = await inWorkspace(b, (tx) =>
      monitorConnectionRepository.advanceWatermark(
        b.connectionId,
        new Date('2026-09-18T12:00:00Z'),
        'error',
        tx,
      ),
    );
    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.setMinimumLevel(b.connectionId, null, true, tx),
    );

    expect(advance.applied).toBe(true);
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: b.connectionId },
    });
    expect(row.lastSeenWatermark).toBeNull();
    expect(row.minimumLevel).toBeNull();
  });

  it('a raise without rewind leaves a set watermark alone', async () => {
    const b = await seedBinding('raise');
    const at = new Date('2026-09-18T09:00:00Z');
    await adminDb.monitorConnection.update({
      where: { id: b.connectionId },
      data: { lastSeenWatermark: at },
    });
    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.setMinimumLevel(b.connectionId, 'fatal', false, tx),
    );
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: b.connectionId },
    });
    expect(row.lastSeenWatermark?.toISOString()).toBe(at.toISOString());
  });
});

describe('the poll-outcome and polling reads', () => {
  it('lists every binding across workspaces under SYSTEM context, and records an outcome', async () => {
    const a = await seedBinding('pa');
    const b = await seedBinding('pb');
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return monitorConnectionRepository.listForPolling(tx);
    });
    expect(rows.map((r) => r.id).sort()).toEqual([a.connectionId, b.connectionId].sort());
    expect(rows.find((r) => r.id === a.connectionId)?.boundByUserId).toBe(a.fx.ownerId);

    const polledAt = new Date('2026-09-18T12:30:00Z');
    await inWorkspace(a, (tx) =>
      monitorConnectionRepository.recordPollOutcome(
        a.connectionId,
        { status: 'failed', error: 'boom', filedCount: null, polledAt },
        tx,
      ),
    );
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: a.connectionId },
    });
    expect(row).toMatchObject({
      lastPollStatus: 'failed',
      lastPollError: 'boom',
      lastPollFiledCount: null,
    });
    expect(row.lastPolledAt?.toISOString()).toBe(polledAt.toISOString());
    // A FAILED poll does not claim a success.
    expect(row.lastPollSucceededAt).toBeNull();

    const okAt = new Date('2026-09-18T13:00:00Z');
    await inWorkspace(a, (tx) =>
      monitorConnectionRepository.recordPollOutcome(
        a.connectionId,
        { status: 'ok', error: null, filedCount: 2, polledAt: okAt },
        tx,
      ),
    );
    const afterOk = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: a.connectionId },
    });
    expect(afterOk).toMatchObject({
      lastPollStatus: 'ok',
      lastPollError: null,
      lastPollFiledCount: 2,
    });
    expect(afterOk.lastPollSucceededAt?.toISOString()).toBe(okAt.toISOString());
  });

  it('writes the latest facts onto an issue row', async () => {
    const b = await seedBinding('facts');
    const row = await adminDb.monitorIssue.create({ data: issueInput(b, 'iss-f') });
    const later = new Date('2026-09-18T13:00:00Z');
    await inWorkspace(b, (tx) =>
      monitorIssueRepository.updateFacts(
        row.id,
        { ...issueInput(b, 'iss-f'), eventCount: 9, lastSeenAt: later, level: 'fatal' },
        tx,
      ),
    );
    const after = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ eventCount: 9, level: 'fatal' });
    expect(after.lastSeenAt.toISOString()).toBe(later.toISOString());
  });
});

describe('the level vocabulary', () => {
  const minimums: Array<string | null> = [null, ...MONITOR_LEVELS];

  it('lets a null or UNKNOWN level through at EVERY minimum', () => {
    for (const minimum of minimums) {
      expect(meetsMinimumLevel(null, minimum)).toBe(true);
      expect(meetsMinimumLevel('critical-ish', minimum)).toBe(true);
    }
  });

  it('is total over the five members: at-or-above qualifies, below does not', () => {
    MONITOR_LEVELS.forEach((level, li) => {
      MONITOR_LEVELS.forEach((minimum, mi) => {
        expect(meetsMinimumLevel(level, minimum)).toBe(li >= mi);
      });
      expect(meetsMinimumLevel(level, null)).toBe(true);
    });
  });

  it('treats an unrecognised MINIMUM as filtering nothing', () => {
    expect(meetsMinimumLevel('debug', 'loud')).toBe(true);
  });

  it('orders minimums with null lowest, for the rewind decision', () => {
    expect(isLowerThan(null, 'debug')).toBe(true);
    expect(isLowerThan('warning', 'error')).toBe(true);
    expect(isLowerThan('error', 'warning')).toBe(false);
    expect(isLowerThan('error', 'error')).toBe(false);
    expect(isLowerThan('fatal', null)).toBe(false);
  });

  it('recognises exactly the five members', () => {
    expect(MONITOR_LEVELS.every(isMonitorLevel)).toBe(true);
    expect(isMonitorLevel('loud')).toBe(false);
    expect(isMonitorLevel(null)).toBe(false);
  });
});

describe('a bind records WHO bound it', () => {
  it('stores the caller as boundByUserId', async () => {
    resetFakeMonitorProvider();
    registerMonitorProvider(fakeMonitorProvider, 'sentry');
    try {
      const fx = await makeWorkItemFixture({ name: 'Binder', identifier: 'BNDR' });
      await monitorConnectionService.completeGrant(
        {
          provider: 'sentry',
          providerInstallationId: 'pi-binder',
          code: 'valid-code',
          projectId: fx.projectId,
        },
        fx.ctx,
      );
      const dto = await monitorConnectionService.bindProject(
        fx.projectId,
        { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
        fx.ctx,
      );
      const row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: dto.id } });
      expect(row.boundByUserId).toBe(fx.ownerId);
    } finally {
      registerMonitorProvider(sentryMonitorProvider, 'sentry');
    }
  });
});
