import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { MonitorProviderCallError } from '@/lib/monitors/errors';
import {
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
} from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// MOTIR-6008 — a connect whose FOLLOW-UP calls fail must keep the grant.
//
// `exchangeGrant` spends Sentry's single-use grant code. The verify and the
// organisation read used to run BEFORE anything was stored, so a slow answer to
// either (production, 2026-09-22: "No response within 5000ms") threw the tokens
// away and left Sentry holding an install Motir had no credential for. The fake
// provider's `failNext` stands in for the slow call: it throws the same typed
// provider refusal the real adapter raises on a timeout.

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

function connect(fx: WorkItemFixture, providerInstallationId = 'pi-follow-up') {
  return monitorConnectionService.completeGrant(
    { provider: 'sentry', providerInstallationId, code: 'valid-code', projectId: fx.projectId },
    fx.ctx,
  );
}

describe('a follow-up that fails after the exchange KEEPS the grant', () => {
  for (const call of ['verifyInstall', 'describeInstallation'] as const) {
    it(`stores the exchanged tokens when ${call} fails, marked pending, with no organisation yet`, async () => {
      const fx = await makeWorkItemFixture({
        name: `Slow ${call}`,
        identifier: call === 'verifyInstall' ? 'SLVF' : 'SLDS',
      });
      fakeMonitorState().failNext.add(call);

      const result = await connect(fx);

      expect(result.orgSlug).toBeNull();
      const rows = await adminDb.monitorInstallation.findMany();
      expect(rows).toHaveLength(1);
      // Asserted on the RE-READ row: the credential Sentry issued is the one stored.
      expect(decryptToken(rows[0]!.accessTokenEncrypted)).toBe('fake-access-token');
      expect(rows[0]!.metadata).toEqual({ installPending: true });
    });
  }

  it('finishes the pending install on the next try: records the organisation and clears the marker', async () => {
    const fx = await makeWorkItemFixture({ name: 'Finish', identifier: 'FNSH' });
    fakeMonitorState().failNext.add('verifyInstall');
    const { installationId } = await connect(fx);

    const finished = await monitorConnectionService.completePendingInstall(fx.projectId, fx.ctx);

    expect(finished).toBe(true);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.metadata).toEqual({ orgSlug: 'fake-org' });
  });

  it('leaves the grant stored and pending while the provider is still failing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Still slow', identifier: 'STSL' });
    fakeMonitorState().failNext.add('verifyInstall');
    const { installationId } = await connect(fx);
    fakeMonitorState().failNext.add('verifyInstall');

    const finished = await monitorConnectionService.completePendingInstall(fx.projectId, fx.ctx);

    expect(finished).toBe(false);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.metadata).toEqual({ installPending: true });
  });

  it('the picker finishes a pending install before it lists the organisation’s projects', async () => {
    const fx = await makeWorkItemFixture({ name: 'Picker', identifier: 'PICK' });
    fakeMonitorState().failNext.add('describeInstallation');
    const { installationId } = await connect(fx);

    const projects = await monitorConnectionService.listAvailableProjects(fx.projectId, fx.ctx);

    expect(projects.length).toBeGreaterThan(0);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    expect(row.metadata).toEqual({ orgSlug: 'fake-org' });
  });

  it('once finished, the grant supersedes an older grant for the same organisation (MOTIR-6005)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Supersede', identifier: 'SPRS' });
    const older = await adminDb.monitorInstallation.create({
      data: {
        provider: 'sentry',
        installationId: 'pi-older',
        workspaceId: fx.workspaceId,
        accessTokenEncrypted: encryptToken('a'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        metadata: { orgSlug: 'fake-org' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const binding = await adminDb.monitorConnection.create({
      data: {
        installationId: older.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        externalProjectId: 'fake-web',
        externalProjectSlug: 'web',
      },
    });
    fakeMonitorState().failNext.add('verifyInstall');
    const { installationId } = await connect(fx);
    // Pending: no organisation yet, so nothing was superseded.
    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: binding.id } }))
        .installationId,
    ).toBe(older.id);

    await monitorConnectionService.completePendingInstall(fx.projectId, fx.ctx);

    expect(
      (await adminDb.monitorConnection.findUniqueOrThrow({ where: { id: binding.id } }))
        .installationId,
    ).toBe(installationId);
    expect(await adminDb.monitorInstallation.findUnique({ where: { id: older.id } })).toBeNull();
  });
});

describe('what did NOT change', () => {
  it('a failed EXCHANGE still stores nothing and surfaces the provider’s refusal', async () => {
    const fx = await makeWorkItemFixture({ name: 'Refused', identifier: 'RFSD' });
    fakeMonitorState().failNext.add('exchangeGrant');

    await expect(connect(fx)).rejects.toBeInstanceOf(MonitorProviderCallError);
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('a connect whose follow-ups succeed is finished at once, with no pending marker', async () => {
    const fx = await makeWorkItemFixture({ name: 'Clean', identifier: 'CLEN' });

    const result = await connect(fx);

    expect(result.orgSlug).toBe('fake-org');
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: result.installationId },
    });
    expect(row.metadata).toEqual({ orgSlug: 'fake-org' });
  });

  it('bounds the follow-ups by no less than the exchange that precedes them', () => {
    expect(MONITOR_VERIFY_INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
    );
  });
});
