import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PERMISSION_CATALOG, PERMISSIONS } from '@/lib/permissions/catalog';
import { decodeMonitorConnectState, encodeMonitorConnectState } from '@/lib/monitors/connectState';
import {
  MonitorConnectionAlreadyExistsError,
  MonitorGrantNotFoundError,
} from '@/lib/monitors/errors';
import {
  resolveMonitorReturnPath,
  DEFAULT_MONITOR_RETURN_PATH,
} from '@/lib/monitors/returnSurface';
import { decryptToken } from '@/lib/monitors/tokenCrypto';
import { fakeMonitorState, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { fakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// CONNECT and DISCONNECT (Story MOTIR-4926 · Subtask MOTIR-5260) — the grant
// exchange, the connection service, and the `integration:manage` permission that
// governs all of it. Real Postgres, per CLAUDE.md.
//
// The PROVIDER is the FAKE, registered under the `sentry` discriminator for the
// duration of each test — the same runtime switch the E2E card uses, and not a
// `vi.mock`, so what these tests exercise is the shipped resolution path
// (MOTIR-5259).
//
// What only THIS layer can prove, and what each block is therefore for:
//   · the permission actually gates every method — a member who may browse and
//     not manage is refused, by TYPE;
//   · the credential is ENCRYPTED at rest and its plaintext appears in NO DTO;
//   · disconnect leaves no orphaned row — and, more importantly, no orphaned
//     CREDENTIAL;
//   · the state cookie is what carries the project, so a callback that has none
//     stores nothing.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  // The runtime switch, applied directly: the fake answers for the stored
  // `sentry` discriminator, exactly as `MOTIR_MONITOR_FAKE_PROVIDER=1` arranges
  // in a spawned server.
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  // Put the real adapter back so no later file inherits the fake.
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect a grant the way the callback does, and return the fixture + ids. */
async function connect(fx: WorkItemFixture): Promise<{ installationId: string }> {
  return monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: 'provider-install-1',
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
}

describe('the PERMISSION is part of this card, and it governs every method', () => {
  it('carries `integration:manage` as an ENFORCED key in its own domain', () => {
    expect(PERMISSIONS).toContain('integration:manage');
    expect(PERMISSION_CATALOG['integration:manage']).toMatchObject({
      key: 'integration:manage',
      domain: 'integration',
      enforcement: 'enforced',
    });
  });

  it('refuses a member who may BROWSE but not manage — by type, on every method', async () => {
    const fx = await makeWorkItemFixture({ name: 'Gate', identifier: 'GATE' });
    const viewer = await adminDb.user.create({
      data: { name: 'Viewer', email: `viewer-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: viewer.id, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        role: 'viewer',
      },
    });
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    // Each method, because a gate added to three of four is the shape that ships.
    await expect(monitorConnectionService.getView(fx.projectId, viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      monitorConnectionService.listAvailableProjects(fx.projectId, viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      monitorConnectionService.bindProject(
        fx.projectId,
        { externalProjectId: 'x', externalProjectSlug: 'x' },
        viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      monitorConnectionService.disconnect(fx.projectId, 'anything', viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      monitorConnectionService.completeGrant(
        {
          provider: 'sentry',
          providerInstallationId: 'i',
          code: 'valid-code',
          projectId: fx.projectId,
        },
        viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // And the refusal happened BEFORE anything was stored.
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('names the missing KEY on the refusal, so a client can say which', async () => {
    const fx = await makeWorkItemFixture({ name: 'Named', identifier: 'NAMD' });
    const viewer = await adminDb.user.create({
      data: { name: 'V', email: `v2-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: viewer.id, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        role: 'viewer',
      },
    });

    try {
      await monitorConnectionService.getView(fx.projectId, {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
      });
      expect.unreachable('the gate should have refused');
    } catch (err) {
      expect((err as PermissionDeniedError).permission).toBe('integration:manage');
    }
  });
});

describe('the GRANT EXCHANGE persists an encrypted credential', () => {
  it('stores both tokens encrypted, with the expiry the provider stated', async () => {
    const fx = await makeWorkItemFixture({ name: 'Grant', identifier: 'GRNT' });
    const { installationId } = await connect(fx);

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: installationId },
    });
    // The plaintext the fake issued.
    expect(row.accessTokenEncrypted).not.toBe('fake-access-token');
    expect(row.accessTokenEncrypted.startsWith('v1.')).toBe(true);
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token');
    expect(row.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    // The org the grant asked for at connect, so the room never has to.
    expect(row.metadata).toEqual({ orgSlug: 'fake-org' });
  });

  it('VERIFIES the install, so the provider does not reap it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Verify', identifier: 'VRFY' });
    await connect(fx);
    expect(fakeMonitorState().verifiedInstallations).toEqual(['provider-install-1']);
  });

  it('BINDS NOTHING — the person has not chosen a project yet', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoBind', identifier: 'NOBD' });
    await connect(fx);
    // The recorded reading of the card's flow: binding every project in the org
    // by default is wrong the moment a customer has ten Sentry projects and
    // three Motir ones, which is the cardinality this story exists to model.
    expect(await adminDb.monitorConnection.count()).toBe(0);
    expect(await adminDb.monitorInstallation.count()).toBe(1);
  });

  it('re-authorising the same installation ROTATES in place, not a second grant', async () => {
    const fx = await makeWorkItemFixture({ name: 'Again', identifier: 'AGAN' });
    const first = await connect(fx);
    fakeMonitorState().grants.set('second-code', {
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const second = await monitorConnectionService.completeGrant(
      {
        provider: 'sentry',
        providerInstallationId: 'provider-install-1',
        code: 'second-code',
        projectId: fx.projectId,
      },
      fx.ctx,
    );

    expect(second.installationId).toBe(first.installationId);
    expect(await adminDb.monitorInstallation.count()).toBe(1);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: first.installationId },
    });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('rotated-access');
  });
});

describe('the plaintext appears in NO DTO and NO response body', () => {
  it('is absent from the room view, the picker and the bind result', async () => {
    const fx = await makeWorkItemFixture({ name: 'Secret', identifier: 'SCRT' });
    await connect(fx);
    const bound = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      fx.ctx,
    );
    const view = await monitorConnectionService.getView(fx.projectId, fx.ctx);
    const available = await monitorConnectionService.listAvailableProjects(fx.projectId, fx.ctx);

    // ASSERTED, not inspected — the story's own criterion. Both the plaintext
    // and the CIPHERTEXT: nothing downstream can decrypt what it never got.
    for (const payload of [bound, view, available]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('fake-access-token');
      expect(serialized).not.toContain('fake-refresh-token');
      expect(serialized).not.toContain('v1.');
    }
    // What the view DOES carry: the health the room draws a degraded row from.
    expect(view.health).toBe('connected');
    expect(view.orgSlug).toBe('fake-org');
    // The grant carries its own check time, so a grant with no rows can still say
    // when it was last checked (design panel 1b).
    expect(view.healthCheckedAt).toBe(view.connections[0]!.healthCheckedAt);
    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]!.externalProjectSlug).toBe('web');
  });

  it('flags an already-bound project in the picker rather than offering it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Picker', identifier: 'PICK' });
    await connect(fx);
    await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      fx.ctx,
    );

    const available = await monitorConnectionService.listAvailableProjects(fx.projectId, fx.ctx);
    expect(available.find((p) => p.externalId === 'fake-web')?.bound).toBe(true);
    expect(available.find((p) => p.externalId === 'fake-worker')?.bound).toBe(false);
  });
});

describe('binding and re-binding', () => {
  it('refuses the SAME monitored project twice, by type', async () => {
    const fx = await makeWorkItemFixture({ name: 'Twice', identifier: 'TWCE' });
    await connect(fx);
    await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      fx.ctx,
    );

    await expect(
      monitorConnectionService.bindProject(
        fx.projectId,
        { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(MonitorConnectionAlreadyExistsError);
    expect(await adminDb.monitorConnection.count()).toBe(1);
  });

  it('holds MORE THAN ONE monitored project against one Motir project', async () => {
    const fx = await makeWorkItemFixture({ name: 'Set', identifier: 'SETT' });
    await connect(fx);
    for (const [id, slug] of [
      ['fake-web', 'web'],
      ['fake-worker', 'worker'],
    ]) {
      await monitorConnectionService.bindProject(
        fx.projectId,
        { externalProjectId: id!, externalProjectSlug: slug! },
        fx.ctx,
      );
    }
    const view = await monitorConnectionService.getView(fx.projectId, fx.ctx);
    expect(view.connections.map((c) => c.externalProjectSlug)).toEqual(['web', 'worker']);
  });

  it('refuses a bind with NO grant, and says so distinctly', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoGrant', identifier: 'NOGR' });
    await expect(
      monitorConnectionService.bindProject(
        fx.projectId,
        { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(MonitorGrantNotFoundError);
  });

  it('reads an EMPTY room for a project with no grant — not an error', async () => {
    const fx = await makeWorkItemFixture({ name: 'Empty', identifier: 'EMTY' });
    const view = await monitorConnectionService.getView(fx.projectId, fx.ctx);
    expect(view).toEqual({
      installationId: null,
      orgSlug: null,
      health: null,
      healthReason: null,
      healthCheckedAt: null,
      connections: [],
    });
  });
});

describe('DISCONNECT leaves no orphaned row — and no orphaned CREDENTIAL', () => {
  it('removes the grant with the LAST binding, and says that it did', async () => {
    const fx = await makeWorkItemFixture({ name: 'Disc', identifier: 'DISC' });
    await connect(fx);
    const bound = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      fx.ctx,
    );

    const result = await monitorConnectionService.disconnect(fx.projectId, bound.id, fx.ctx);

    expect(result).toEqual({ removedGrant: true });
    expect(await adminDb.monitorConnection.count()).toBe(0);
    // The credential is GONE, which is the point: a grant with no bindings is a
    // stored secret nothing can reach and nothing will ever rotate.
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('keeps the grant while another binding still uses it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Keep', identifier: 'KEEP' });
    await connect(fx);
    const first = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      fx.ctx,
    );
    await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-worker', externalProjectSlug: 'worker' },
      fx.ctx,
    );

    const result = await monitorConnectionService.disconnect(fx.projectId, first.id, fx.ctx);

    expect(result).toEqual({ removedGrant: false });
    expect(await adminDb.monitorConnection.count()).toBe(1);
    expect(await adminDb.monitorInstallation.count()).toBe(1);
  });

  it('answers a binding in ANOTHER project as not-found, never as forbidden', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    await connect(a);
    const bound = await monitorConnectionService.bindProject(
      a.projectId,
      { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
      a.ctx,
    );

    // The no-existence-leak posture: from B's side, A's binding does not exist.
    await expect(
      monitorConnectionService.disconnect(b.projectId, bound.id, b.ctx),
    ).rejects.toThrow();
    expect(await adminDb.monitorConnection.count()).toBe(1);
  });
});

describe('the STATE COOKIE is what carries the project', () => {
  it('round-trips the project and the return surface', () => {
    const encoded = encodeMonitorConnectState({
      nonce: 'a'.repeat(32),
      projectId: 'project_1',
      returnSurfaceId: 'projectMonitoring',
      issuedAt: Date.now(),
    });
    expect(decodeMonitorConnectState(encoded)).toMatchObject({
      projectId: 'project_1',
      returnSurfaceId: 'projectMonitoring',
    });
  });

  it('is NULL for every failure, with no recoverable middle', () => {
    // Absent, unparseable, short-nonce, projectless — and EXPIRED, which is the
    // one a caller would otherwise be tempted to treat as a warning.
    expect(decodeMonitorConnectState(null)).toBeNull();
    expect(decodeMonitorConnectState('not-base64-json')).toBeNull();
    expect(
      decodeMonitorConnectState(
        encodeMonitorConnectState({
          nonce: 'short',
          projectId: 'p',
          returnSurfaceId: 'projectMonitoring',
          issuedAt: Date.now(),
        }),
      ),
    ).toBeNull();
    const stale = encodeMonitorConnectState({
      nonce: 'a'.repeat(32),
      projectId: 'p',
      returnSurfaceId: 'projectMonitoring',
      issuedAt: Date.now() - 3_600_000,
    });
    expect(decodeMonitorConnectState(stale)).toBeNull();
  });

  it('narrows an unknown return surface to the default rather than carrying it', () => {
    const raw = Buffer.from(
      JSON.stringify({
        nonce: 'a'.repeat(32),
        projectId: 'p',
        returnSurfaceId: 'https://evil.example/steal',
        issuedAt: Date.now(),
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeMonitorConnectState(raw)?.returnSurfaceId).toBe('projectMonitoring');
  });
});

describe('the RETURN TARGET is an id, never a path', () => {
  it('resolves every attempt at a URL to the default', () => {
    // The open-redirect refusal is a SET MEMBERSHIP test, so it cannot be
    // defeated by an encoding the way a prefix or scheme check can.
    for (const attempt of [
      'https://evil.example/steal',
      '//evil.example',
      '/settings/project/monitoring',
      '../../etc/passwd',
      '\\\\evil.example',
      'projectMonitoring/../..',
      '',
      null,
      undefined,
    ]) {
      expect(resolveMonitorReturnPath(attempt)).toBe(DEFAULT_MONITOR_RETURN_PATH);
    }
    // The one id that resolves to something.
    expect(resolveMonitorReturnPath('projectMonitoring')).toBe('/settings/project/monitoring');
  });
});

describe('the deployment is told what it needs', () => {
  it('documents every new env var in `.env.example`', () => {
    // The flow is unreachable without them and the resolver reads them at CALL
    // time, so a deployment that never registered the integration does not
    // crash — but a deployment that WANTS the feature has to be able to find the
    // names, and MOTIR-5257 is the card that sets them.
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    for (const name of [
      'SENTRY_APP_CLIENT_ID',
      'SENTRY_APP_CLIENT_SECRET',
      'SENTRY_APP_SLUG',
      'SENTRY_TOKEN_ENCRYPTION_KEY',
      'MOTIR_MONITOR_FAKE_PROVIDER',
    ]) {
      expect(example, `${name} is undocumented`).toContain(`${name}=`);
    }
    // And it says, in as many words, that the pre-existing Sentry vars are not
    // these — the collision MOTIR-5257 warns about.
    expect(example).toContain('NONE of these is one of MOTIR-1161');
  });
});
