import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  card,
  monitorLinkScenario,
  plantLink,
  type MonitorLinkScenario,
} from './_monitorLinkFixtures';

// MOTIR-6005 — a RECONNECT after a reinstall. A Sentry integration cannot be
// re-authorised while installed, so recovering a dead credential means
// uninstall -> reinstall, and the reinstall arrives under a NEW provider
// installation id. Connect used to store it as a second grant and leave every
// binding (and the room, which shows the oldest grant) on the dead one.
//
// The fake provider reports org `fake-org` for every installation, which is
// exactly the reinstall shape: same organisation, new installation id.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function reconnect(s: MonitorLinkScenario, providerInstallationId: string) {
  return monitorConnectionService.completeGrant(
    { provider: 'sentry', providerInstallationId, code: 'valid-code', projectId: s.fx.projectId },
    s.fx.ctx,
  );
}

describe('a reconnect for the SAME organisation supersedes its older grant', () => {
  it('moves every binding onto the new grant, keeps their links, and deletes the old grant', async () => {
    const s = await monitorLinkScenario('Rehome');
    const oldGrant = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: s.webConnectionId },
      select: { installationId: true },
    });
    const bug = await card(s.fx, 'Filed from Sentry');
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'issue-1',
      workItemId: bug.id,
      lastSeenAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    const fresh = await reconnect(s, 'pi-reinstalled');

    expect(fresh.installationId).not.toBe(oldGrant.installationId);
    const grants = await adminDb.monitorInstallation.findMany({ select: { id: true } });
    expect(grants.map((g) => g.id)).toEqual([fresh.installationId]);
    // MOVED, not re-created: the same binding ids, now on the new grant.
    const bindings = await adminDb.monitorConnection.findMany({ orderBy: { id: 'asc' } });
    expect(bindings.map((b) => b.id).sort()).toEqual(
      [s.webConnectionId, s.workerConnectionId].sort(),
    );
    expect(new Set(bindings.map((b) => b.installationId))).toEqual(new Set([fresh.installationId]));
    // And the issue link survived, so the next poll files nothing twice.
    const links = await adminDb.monitorIssue.findMany({
      where: { connectionId: s.webConnectionId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.workItemId).toBe(bug.id);
  });

  it('leaves a grant for a DIFFERENT organisation in the same workspace untouched', async () => {
    const s = await monitorLinkScenario('OtherOrg');
    const other = await adminDb.monitorInstallation.create({
      data: {
        provider: 'sentry',
        installationId: 'pi-other-org',
        workspaceId: s.fx.workspaceId,
        accessTokenEncrypted: encryptToken('a'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        metadata: { orgSlug: 'another-org' },
      },
    });
    const otherBinding = await adminDb.monitorConnection.create({
      data: {
        installationId: other.id,
        projectId: s.fx.projectId,
        workspaceId: s.fx.workspaceId,
        externalProjectId: 'another-web',
        externalProjectSlug: 'another-web',
      },
    });

    await reconnect(s, 'pi-reinstalled');

    expect(
      await adminDb.monitorInstallation.findUnique({ where: { id: other.id } }),
    ).not.toBeNull();
    const kept = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: otherBinding.id },
    });
    expect(kept.installationId).toBe(other.id);
  });

  it('does not duplicate a binding the new grant already holds, and keeps the old grant that still owns it', async () => {
    const s = await monitorLinkScenario('Held');
    const fresh = await reconnect(s, 'pi-reinstalled');
    // An older grant for the same org that binds the SAME monitored project the
    // fresh grant now holds — moving it would collide with the unique index.
    const stale = await adminDb.monitorInstallation.create({
      data: {
        provider: 'sentry',
        installationId: 'pi-stale',
        workspaceId: s.fx.workspaceId,
        accessTokenEncrypted: encryptToken('a'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        metadata: { orgSlug: 'fake-org' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const staleBinding = await adminDb.monitorConnection.create({
      data: {
        installationId: stale.id,
        projectId: s.fx.projectId,
        workspaceId: s.fx.workspaceId,
        externalProjectId: 'fake-web',
        externalProjectSlug: 'web',
      },
    });

    // Re-authorising the same (fresh) installation runs the rule again.
    await reconnect(s, 'pi-reinstalled');

    expect(
      await adminDb.monitorConnection.count({
        where: { installationId: fresh.installationId, externalProjectId: 'fake-web' },
      }),
    ).toBe(1);
    const left = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: staleBinding.id },
    });
    expect(left.installationId).toBe(stale.id);
    expect(
      await adminDb.monitorInstallation.findUnique({ where: { id: stale.id } }),
    ).not.toBeNull();
  });
});
