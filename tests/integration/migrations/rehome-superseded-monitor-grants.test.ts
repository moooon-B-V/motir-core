import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6005 — the one-off REPAIR of grants stranded before connect learned to
// supersede them. Seeds the PRODUCTION shape read on 2026-09-22: two grants for
// org `motir` in one workspace, the older one dead and holding the only binding
// (with its issue links), the newer one healthy and holding nothing.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260922010000_rehome_superseded_monitor_grants/migration.sql',
  ),
  'utf8',
);

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigration(): Promise<void> {
  const statements = statementsOf(MIGRATION_SQL);
  expect(statements).toHaveLength(2);
  for (const stmt of statements) await adminDb.$executeRawUnsafe(stmt);
}

function grant(
  fx: WorkItemFixture,
  installationId: string,
  orgSlug: string | null,
  createdAt: Date,
) {
  return adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('a'),
      refreshTokenEncrypted: encryptToken('r'),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      ...(orgSlug ? { metadata: { orgSlug } } : {}),
      createdAt,
    },
  });
}

function binding(fx: WorkItemFixture, installationId: string, externalProjectId: string) {
  return adminDb.monitorConnection.create({
    data: {
      installationId,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalProjectId,
      externalProjectSlug: externalProjectId,
      resolveOnDone: true,
      syncAssignee: true,
    },
  });
}

function link(fx: WorkItemFixture, connectionId: string, externalIssueId: string) {
  return adminDb.monitorIssue.create({
    data: {
      connectionId,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalIssueId,
      title: `Error ${externalIssueId}`,
      culprit: 'lib/x.ts',
      level: 'error',
      permalink: `https://fake.invalid/issues/${externalIssueId}`,
      eventCount: 1,
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-20T00:00:00.000Z'),
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the migration re-homes a stranded organisation onto its newest grant', () => {
  it('moves the binding with its links onto the newer grant and deletes the dead one — and a second run changes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MTRX' });
    const dead = await grant(fx, 'f1f54ed5', 'motir', new Date('2026-09-19T20:57:06.000Z'));
    const fresh = await grant(fx, '47897c42', 'motir', new Date('2026-09-22T00:33:57.000Z'));
    const core = await binding(fx, dead.id, 'motir-core');
    for (let i = 1; i <= 7; i += 1) await link(fx, core.id, `issue-${i}`);

    await runMigration();

    const grants = await adminDb.monitorInstallation.findMany({ select: { id: true } });
    expect(grants.map((g) => g.id)).toEqual([fresh.id]);
    const moved = await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: core.id } });
    expect(moved.installationId).toBe(fresh.id);
    expect(moved).toMatchObject({ resolveOnDone: true, syncAssignee: true });
    expect(await adminDb.monitorIssue.count({ where: { connectionId: core.id } })).toBe(7);

    // IDEMPOTENT.
    await runMigration();
    expect(await adminDb.monitorInstallation.count()).toBe(1);
    expect(await adminDb.monitorConnection.count({ where: { installationId: fresh.id } })).toBe(1);
    expect(await adminDb.monitorIssue.count()).toBe(7);
  });

  it('touches no grant of a DIFFERENT organisation, and none with no recorded organisation', async () => {
    const fx = await makeWorkItemFixture({ name: 'Two orgs', identifier: 'TWOO' });
    const a = await grant(fx, 'inst-a', 'org-a', new Date('2026-09-01T00:00:00.000Z'));
    const b = await grant(fx, 'inst-b', 'org-b', new Date('2026-09-02T00:00:00.000Z'));
    const nullOrg = await grant(fx, 'inst-null', null, new Date('2026-09-03T00:00:00.000Z'));
    const ba = await binding(fx, a.id, 'a-web');
    const bn = await binding(fx, nullOrg.id, 'n-web');

    await runMigration();

    expect(
      (await adminDb.monitorInstallation.findMany({ select: { id: true } }))
        .map((g) => g.id)
        .sort(),
    ).toEqual([a.id, b.id, nullOrg.id].sort());
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: ba.id } })).installationId,
    ).toBe(a.id);
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: bn.id } })).installationId,
    ).toBe(nullOrg.id);
  });

  it('keeps an older grant whose binding the newest grant already holds, rather than colliding', async () => {
    const fx = await makeWorkItemFixture({ name: 'Held', identifier: 'HELD' });
    const old = await grant(fx, 'inst-old', 'motir', new Date('2026-09-01T00:00:00.000Z'));
    const fresh = await grant(fx, 'inst-new', 'motir', new Date('2026-09-02T00:00:00.000Z'));
    const oldCore = await binding(fx, old.id, 'motir-core');
    const newCore = await binding(fx, fresh.id, 'motir-core');

    await runMigration();

    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: oldCore.id } }))
        .installationId,
    ).toBe(old.id);
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: newCore.id } }))
        .installationId,
    ).toBe(fresh.id);
    expect(await adminDb.monitorInstallation.count()).toBe(2);
  });
});
