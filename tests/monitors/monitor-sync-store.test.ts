import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { db } from '@/lib/db';
import {
  isMonitorResolveState,
  MONITOR_RESOLVE_STATES,
  type MonitorResolveState,
} from '@/lib/monitors/syncStates';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import {
  monitorIssueRepository,
  type InsertMonitorIssueInput,
} from '@/lib/repositories/monitorIssueRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

// The monitor SYNC STORE (Story MOTIR-4931 · Subtask MOTIR-5701) — the columns
// resolve-back and the assignee sync persist, and the repository methods the
// behaviour cards call. Real Postgres, per CLAUDE.md.
//
// The claim is asserted under a REAL race, not a serial pair: the story's
// "resolving twice calls the provider once" is only true if exactly one of two
// simultaneous claimants wins, and a serial pair passes whatever the SQL says.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Bound {
  fx: WorkItemFixture;
  connectionId: string;
}

let seq = 0;

async function seedBinding(tag: string): Promise<Bound> {
  const n = seq++;
  const fx = await makeWorkItemFixture({
    name: `WS ${tag}`,
    identifier: `S${tag.toUpperCase()}${n}`,
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
  // Through the PRE-EXISTING create path, so the defaults asserted below are the
  // database's, not a value this test wrote.
  const connection = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
    return monitorConnectionRepository.create(
      {
        installationId: installation.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        externalProjectId: `ext-${tag}-${n}`,
        externalProjectSlug: `slug-${tag}`,
        boundByUserId: fx.ownerId,
      },
      tx,
    );
  });
  return { fx, connectionId: connection.id };
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

/** A link row pointing at a fresh bug in `status`. */
async function seedLink(
  b: Bound,
  externalIssueId: string,
  status: string,
  extra: Prisma.MonitorIssueUncheckedCreateInput extends infer T ? Partial<T> : never = {},
) {
  const bug = await createTestWorkItem(b.fx, { kind: 'bug', title: `bug ${externalIssueId}` });
  await adminDb.workItem.update({ where: { id: bug.id }, data: { status } });
  return adminDb.monitorIssue.create({
    data: {
      ...issueInput(b, externalIssueId),
      workItemId: bug.id,
      filedWorkItemIdentifier: bug.identifier,
      ...extra,
    },
  });
}

function inWorkspace<T>(b: Bound, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${b.fx.workspaceId}, true)`;
    return fn(tx);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const T0 = new Date('2026-09-18T12:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('the connection’s sync columns', () => {
  it('an existing-path connection reads BOTH switches ON and no failure', async () => {
    const b = await seedBinding('def');
    const row = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: b.connectionId },
    });
    expect(row).toMatchObject({
      resolveOnDone: true,
      syncAssignee: true,
      lastSyncError: null,
      lastSyncErrorAt: null,
      lastSyncErrorWorkItemIdentifier: null,
    });
  });

  it('setSyncDirections is SPARSE — one switch leaves the other alone', async () => {
    const b = await seedBinding('sparse');
    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.setSyncDirections(b.connectionId, { resolveOnDone: false }, tx),
    );
    let row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: b.connectionId } });
    expect(row).toMatchObject({ resolveOnDone: false, syncAssignee: true });

    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.setSyncDirections(b.connectionId, { syncAssignee: false }, tx),
    );
    row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: b.connectionId } });
    expect(row).toMatchObject({ resolveOnDone: false, syncAssignee: false });

    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.setSyncDirections(
        b.connectionId,
        { resolveOnDone: true, syncAssignee: true },
        tx,
      ),
    );
    row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: b.connectionId } });
    expect(row).toMatchObject({ resolveOnDone: true, syncAssignee: true });
  });

  it('records a sync failure, replaces it, and clears it', async () => {
    const b = await seedBinding('fail');
    await inWorkspace(b, (tx) =>
      monitorConnectionRepository.recordSyncFailure(
        b.connectionId,
        { reason: 'Sentry said no', workItemIdentifier: 'X-1', at: T0 },
        tx,
      ),
    );
    let row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: b.connectionId } });
    expect(row).toMatchObject({
      lastSyncError: 'Sentry said no',
      lastSyncErrorWorkItemIdentifier: 'X-1',
    });
    expect(row.lastSyncErrorAt?.toISOString()).toBe(T0.toISOString());

    await inWorkspace(b, (tx) => monitorConnectionRepository.clearSyncFailure(b.connectionId, tx));
    row = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: b.connectionId } });
    expect(row).toMatchObject({
      lastSyncError: null,
      lastSyncErrorAt: null,
      lastSyncErrorWorkItemIdentifier: null,
    });
    // Clearing an already-clear (or deleted) connection is a no-op, not a throw.
    await inWorkspace(b, (tx) => monitorConnectionRepository.clearSyncFailure(b.connectionId, tx));
    await inWorkspace(b, (tx) => monitorConnectionRepository.clearSyncFailure('gone-id', tx));
  });
});

describe('the resolve_state vocabulary', () => {
  it('is a closed union of exactly four members', () => {
    expect(MONITOR_RESOLVE_STATES).toEqual(['pending', 'resolved', 'failed', 'gone']);
    expect(MONITOR_RESOLVE_STATES.every(isMonitorResolveState)).toBe(true);
    expect(isMonitorResolveState('done')).toBe(false);
    expect(isMonitorResolveState(null)).toBe(false);
    expectTypeOf<'pending'>().toMatchTypeOf<MonitorResolveState>();
    // @ts-expect-error — a member outside the union is refused at the type level.
    const outside: MonitorResolveState = 'resolving';
    expect(outside).toBe('resolving');
  });
});

describe('claimResolve under a REAL race', () => {
  it('two simultaneous claims of one link: exactly one wins, neither throws', async () => {
    const b = await seedBinding('race');
    const link = await seedLink(b, 'iss-race', 'done');

    // Each claimant claims and then HOLDS its transaction, so the other is
    // certainly waiting on the row lock rather than merely scheduled after it.
    const claim = () =>
      inWorkspace(b, async (tx) => {
        const won = await monitorIssueRepository.claimResolve(link.id, T0, minutes(-15), tx);
        await sleep(300);
        return won;
      });
    const results = await Promise.all([claim(), claim()]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.resolveState).toBe('pending');
    expect(row.resolveAttemptedAt?.toISOString()).toBe(T0.toISOString());
  });

  it('never re-claims a RESOLVED or GONE link', async () => {
    const b = await seedBinding('term');
    const resolved = await seedLink(b, 'iss-r', 'done', {
      resolveState: 'resolved',
      resolveAttemptedAt: minutes(-60),
      resolvedByMotirAt: minutes(-60),
    });
    const gone = await seedLink(b, 'iss-g', 'done', {
      resolveState: 'gone',
      resolveAttemptedAt: minutes(-60),
    });
    for (const id of [resolved.id, gone.id]) {
      const won = await inWorkspace(b, (tx) =>
        monitorIssueRepository.claimResolve(id, T0, minutes(1), tx),
      );
      expect(won).toBe(false);
    }
  });

  it('re-claims a STALE pending and a failed link, and not a fresh pending', async () => {
    const b = await seedBinding('stale');
    const stale = await seedLink(b, 'iss-s', 'done', {
      resolveState: 'pending',
      resolveAttemptedAt: minutes(-30),
    });
    const fresh = await seedLink(b, 'iss-f', 'done', {
      resolveState: 'pending',
      resolveAttemptedAt: minutes(-5),
    });
    const failed = await seedLink(b, 'iss-x', 'done', {
      resolveState: 'failed',
      resolveAttemptedAt: minutes(-1),
      resolveError: 'boom',
    });
    const claim = (id: string) =>
      inWorkspace(b, (tx) => monitorIssueRepository.claimResolve(id, T0, minutes(-15), tx));

    expect(await claim(stale.id)).toBe(true);
    expect(await claim(fresh.id)).toBe(false);
    expect(await claim(failed.id)).toBe(true);
  });

  it('records each way out of pending', async () => {
    const b = await seedBinding('rec');
    const a = await seedLink(b, 'iss-a', 'done', { resolveState: 'pending' });
    const f = await seedLink(b, 'iss-f', 'done', { resolveState: 'pending' });
    const g = await seedLink(b, 'iss-g', 'done', { resolveState: 'pending' });
    await inWorkspace(b, async (tx) => {
      await monitorIssueRepository.recordResolved(a.id, T0, tx);
      await monitorIssueRepository.recordResolveFailed(f.id, 'Sentry 500', tx);
      await monitorIssueRepository.recordGone(g.id, tx);
    });
    const rows = await adminDb.monitorIssue.findMany({ where: { id: { in: [a.id, f.id, g.id] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toMatchObject({ resolveState: 'resolved', resolveError: null });
    expect(byId.get(a.id)?.resolvedByMotirAt?.toISOString()).toBe(T0.toISOString());
    expect(byId.get(f.id)).toMatchObject({ resolveState: 'failed', resolveError: 'Sentry 500' });
    expect(byId.get(g.id)).toMatchObject({ resolveState: 'gone', resolvedByMotirAt: null });
  });
});

describe('the list reads', () => {
  it('listByWorkItem returns every link on one bug', async () => {
    const b = await seedBinding('lbw');
    const first = await seedLink(b, 'iss-1', 'todo');
    await adminDb.monitorIssue.create({
      data: { ...issueInput(b, 'iss-2'), workItemId: first.workItemId },
    });
    await seedLink(b, 'iss-other', 'todo');
    const links = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listByWorkItem(first.workItemId!, tx),
    );
    expect(links.map((l) => l.externalIssueId).sort()).toEqual(['iss-1', 'iss-2']);
  });

  it('listResolvableForConnection honours a CUSTOM done-category status and the claim rule', async () => {
    const b = await seedBinding('lr');
    await adminDb.workflowStatus.create({
      data: {
        workspaceId: b.fx.workspaceId,
        projectId: b.fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z9',
      },
    });
    const shipped = await seedLink(b, 'iss-shipped', 'shipped');
    const failed = await seedLink(b, 'iss-failed', 'done', { resolveState: 'failed' });
    const stale = await seedLink(b, 'iss-stale', 'done', {
      resolveState: 'pending',
      resolveAttemptedAt: minutes(-30),
    });
    await seedLink(b, 'iss-fresh', 'done', {
      resolveState: 'pending',
      resolveAttemptedAt: minutes(-1),
    });
    await seedLink(b, 'iss-resolved', 'done', { resolveState: 'resolved' });
    await seedLink(b, 'iss-live', 'todo');

    const doneKeys = ['done', 'cancelled', 'shipped'];
    const rows = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listResolvableForConnection(
        b.connectionId,
        doneKeys,
        minutes(-15),
        25,
        tx,
      ),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([shipped.id, failed.id, stale.id].sort());

    const capped = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listResolvableForConnection(
        b.connectionId,
        doneKeys,
        minutes(-15),
        2,
        tx,
      ),
    );
    expect(capped).toHaveLength(2);
    const none = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listResolvableForConnection(b.connectionId, [], minutes(-15), 25, tx),
    );
    expect(none).toEqual([]);
  });

  it('listForAssigneeRefresh: oldest-checked first, nulls first, live bugs only, capped', async () => {
    const b = await seedBinding('ar');
    const never = await seedLink(b, 'iss-never', 'todo');
    const old = await seedLink(b, 'iss-old', 'todo', { assigneeCheckedAt: minutes(-60) });
    const recent = await seedLink(b, 'iss-recent', 'in_progress', {
      assigneeCheckedAt: minutes(-1),
    });
    await seedLink(b, 'iss-done', 'done');
    // A deleted bug: the FK nulls the pointer.
    const deleted = await seedLink(b, 'iss-deleted', 'todo');
    await adminDb.workItem.delete({ where: { id: deleted.workItemId! } });

    const rows = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listForAssigneeRefresh(b.connectionId, ['done', 'cancelled'], 10, tx),
    );
    expect(rows.map((r) => r.id)).toEqual([never.id, old.id, recent.id]);

    const capped = await inWorkspace(b, (tx) =>
      monitorIssueRepository.listForAssigneeRefresh(b.connectionId, ['done', 'cancelled'], 2, tx),
    );
    expect(capped.map((r) => r.id)).toEqual([never.id, old.id]);
  });

  it('records an assignee sync and a bare check, and locks a link by id', async () => {
    const b = await seedBinding('as');
    const link = await seedLink(b, 'iss-as', 'todo');
    await inWorkspace(b, (tx) =>
      monitorIssueRepository.recordAssigneeSync(
        link.id,
        { externalAssigneeId: 'team:7', note: 'team_assignee', checkedAt: T0 },
        tx,
      ),
    );
    let row = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: link.id } });
    expect(row).toMatchObject({
      syncedAssigneeExternalId: 'team:7',
      assigneeSyncNote: 'team_assignee',
    });
    await inWorkspace(b, (tx) =>
      monitorIssueRepository.markAssigneeChecked(link.id, minutes(5), tx),
    );
    row = await adminDb.monitorIssue.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.assigneeCheckedAt?.toISOString()).toBe(minutes(5).toISOString());
    expect(row.syncedAssigneeExternalId).toBe('team:7');

    const locked = await inWorkspace(b, (tx) => monitorIssueRepository.lockById(link.id, tx));
    expect(locked?.id).toBe(link.id);
    const missing = await inWorkspace(b, (tx) => monitorIssueRepository.lockById('nope', tx));
    expect(missing).toBeNull();
  });
});
