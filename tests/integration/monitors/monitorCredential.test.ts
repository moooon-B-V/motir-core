import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MonitorProviderCallError } from '@/lib/monitors/errors';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The CREDENTIAL LIFECYCLE (Story MOTIR-4926 · Subtask MOTIR-5261) — the
// eight-hourly refresh, the on-demand probe, and the stored `degraded` verdict.
// Real Postgres, because a ROW LOCK cannot be asserted against a mock and this
// card's central risk is a concurrency one.
//
// The failure this guards is specific and not hypothetical: the provider ROTATES
// the refresh token on every refresh, so two concurrent refreshes spending the
// same stored token break a connection with nothing but two page loads arriving
// together. The concurrency test below is therefore the load-bearing one, and it
// asserts the OBSERVABLE consequence — exactly one provider call, and the loser
// proceeding with the winner's credential — rather than "it is locked", which
// nothing can see.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A grant whose stored token expires `inMs` from now — negative for expired. */
async function seedGrant(fx: WorkItemFixture, inMs: number): Promise<{ id: string }> {
  return adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: `inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('stored-access'),
      refreshTokenEncrypted: encryptToken('stored-refresh'),
      tokenExpiresAt: new Date(Date.now() + inMs),
      metadata: { orgSlug: 'fake-org' },
    },
    select: { id: true },
  });
}

describe('the REFRESH keeps a grant usable past eight hours', () => {
  it('returns the stored token untouched while it is still fresh', async () => {
    const fx = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRSH' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);

    const credential = await monitorCredentialService.getAccessToken(grant.id);

    expect(credential.token).toBe('stored-access');
    // The common path makes NO provider call at all.
    expect(fakeMonitorState().refreshCount).toBe(0);
  });

  it('refreshes FIRST when the expiry has passed, and PERSISTS the pair the provider returned', async () => {
    const fx = await makeWorkItemFixture({ name: 'Expired', identifier: 'EXPD' });
    const grant = await seedGrant(fx, -60_000);

    const credential = await monitorCredentialService.getAccessToken(grant.id);

    expect(credential.token).toBe('fake-access-token-1');
    expect(fakeMonitorState().refreshCount).toBe(1);

    // ⚠️ ASSERTED AGAINST THE RE-READ ROW, not the in-memory value — the card's
    // own wording. A service that returns the new token and persists the old one
    // passes every assertion about its return value.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token-1');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token-1');
    expect(row.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('treats a token expiring INSIDE the skew as already expired', async () => {
    const fx = await makeWorkItemFixture({ name: 'Skew', identifier: 'SKEW' });
    // 20 seconds left: technically valid, useless to a call that takes ten.
    const grant = await seedGrant(fx, 20_000);

    await monitorCredentialService.getAccessToken(grant.id);

    expect(fakeMonitorState().refreshCount).toBe(1);
  });

  it('clears a STALE degraded verdict on a successful refresh', async () => {
    const fx = await makeWorkItemFixture({ name: 'Recover', identifier: 'RCVR' });
    const grant = await seedGrant(fx, -60_000);
    await adminDb.monitorInstallation.update({
      where: { id: grant.id },
      data: { health: 'degraded', healthReason: 'The authorization has been revoked.' },
    });

    await monitorCredentialService.getAccessToken(grant.id);

    // The post-terminal value of the lifecycle: a re-authorised connection that
    // keeps reading `degraded` is the same silent wrongness one polarity over.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.health).toBe('connected');
    expect(row.healthReason).toBeNull();
    expect(row.healthCheckedAt).not.toBeNull();
  });
});

describe('a REFUSED refresh writes `degraded` with the PROVIDER’S OWN reason', () => {
  it('writes all three fields in one write, and the reason is not ours', async () => {
    const fx = await makeWorkItemFixture({ name: 'Revoked', identifier: 'RVKD' });
    const grant = await seedGrant(fx, -60_000);
    fakeMonitorState().failNext.add('refreshCredential');

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toBeInstanceOf(
      MonitorProviderCallError,
    );

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.health).toBe('degraded');
    // VERBATIM — the provider's sentence, which is what tells a person whether
    // to re-authorise or wait. A Motir-authored summary is what this forbids.
    expect(row.healthReason).toBe('The authorization has been revoked.');
    expect(row.healthCheckedAt).not.toBeNull();
  });

  it('logs the REASON and NO CREDENTIAL on the refusal path', async () => {
    const fx = await makeWorkItemFixture({ name: 'Logs', identifier: 'LOGS' });
    const grant = await seedGrant(fx, -60_000);
    fakeMonitorState().failNext.add('refreshCredential');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(warn.mock.calls[0]);
    // The error path is where a token usually escapes — the happy path has
    // nobody printing anything.
    expect(serialized).toContain('The authorization has been revoked.');
    expect(serialized).not.toContain('stored-access');
    expect(serialized).not.toContain('stored-refresh');
    expect(serialized).not.toContain('v1.');
  });
});

describe('a 401 on a credential believed FRESH — ONE refresh, ONE retry', () => {
  it('refreshes once, retries once, and succeeds', async () => {
    const fx = await makeWorkItemFixture({ name: 'Retry', identifier: 'RTRY' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);

    let attempts = 0;
    const result = await monitorCredentialService.withFreshCredential(grant.id, async (cred) => {
      attempts += 1;
      if (attempts === 1) {
        // The stored token LOOKS fresh and is not: revoked inside the window, or
        // rotated out of band. This is the only case that arm exists for.
        throw new MonitorProviderCallError('listProjects', 401, 'Invalid token');
      }
      return cred.token;
    });

    expect(attempts).toBe(2);
    expect(result).toBe('fake-access-token-1');
    expect(fakeMonitorState().refreshCount).toBe(1);
  });

  it('does NOT loop — a second 401 surfaces as a typed error and writes `degraded`', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoLoop', identifier: 'NLOP' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);

    let attempts = 0;
    await expect(
      monitorCredentialService.withFreshCredential(grant.id, async () => {
        attempts += 1;
        throw new MonitorProviderCallError('listProjects', 401, 'Invalid token');
      }),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);

    // THE COUNT IS THE POINT: each attempt spends a refresh token, so a provider
    // that keeps answering 401 must not be handed the whole chain.
    expect(attempts).toBe(2);
    expect(fakeMonitorState().refreshCount).toBe(1);

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.health).toBe('degraded');
    expect(row.healthReason).toBe('Invalid token');
  });

  it('does not refresh at all for a failure that is NOT a 401', async () => {
    const fx = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);

    await expect(
      monitorCredentialService.withFreshCredential(grant.id, async () => {
        throw new MonitorProviderCallError('listProjects', 500, 'Internal error');
      }),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);

    // A 500 is not a credential problem, and spending a refresh token on one is
    // how an outage turns into a broken connection.
    expect(fakeMonitorState().refreshCount).toBe(0);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.health).toBe('connected');
  });
});

describe('CONCURRENCY — two page loads must not break a connection', () => {
  it('makes exactly ONE provider refresh, and the loser proceeds with the winner’s token', async () => {
    const fx = await makeWorkItemFixture({ name: 'Race', identifier: 'RACE' });
    const grant = await seedGrant(fx, -60_000);

    // GENUINELY simultaneous: both transactions are in flight before either
    // commits, which is the only arrangement in which the rotation hazard
    // occurs. Run serially, this test passes with no lock at all.
    const [a, b] = await Promise.all([
      monitorCredentialService.getAccessToken(grant.id),
      monitorCredentialService.getAccessToken(grant.id),
    ]);

    // ⚠️ THE OBSERVABLE CONSEQUENCE, which is what makes the lock testable:
    // one refresh, not two.
    expect(fakeMonitorState().refreshCount).toBe(1);
    // Both callers hold the SAME usable token — the loser re-read under the lock
    // and found a credential that was now fresh.
    expect(a.token).toBe(b.token);
    expect(a.token).toBe('fake-access-token-1');

    // And the stored pair is usable afterwards: the rotation was persisted once.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token-1');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token-1');

    // A later call finds it fresh and refreshes nothing.
    await monitorCredentialService.getAccessToken(grant.id);
    expect(fakeMonitorState().refreshCount).toBe(1);
  });

  it('serializes FOUR simultaneous callers onto one refresh', async () => {
    const fx = await makeWorkItemFixture({ name: 'Race4', identifier: 'RAC4' });
    const grant = await seedGrant(fx, -60_000);

    const tokens = await Promise.all(
      Array.from({ length: 4 }, () => monitorCredentialService.getAccessToken(grant.id)),
    );

    expect(fakeMonitorState().refreshCount).toBe(1);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(1);
  });
});

describe('the PROBE is on demand, and the verdict is PERSISTED', () => {
  it('stores what the provider said, and returns the same thing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Probe', identifier: 'PRBE' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);
    fakeMonitorState().health = {
      status: 'degraded',
      reason: 'The authorization has been revoked.',
      checkedAt: new Date(),
    };

    const verdict = await monitorCredentialService.probeHealth(fx.projectId, grant.id, fx.ctx);

    expect(verdict.health).toBe('degraded');
    expect(verdict.healthReason).toBe('The authorization has been revoked.');
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    // The stored verdict is what the room reads BETWEEN probes, so it must not
    // disagree with what was just returned.
    expect(row.health).toBe('degraded');
    expect(row.healthReason).toBe('The authorization has been revoked.');
    expect(row.healthCheckedAt).not.toBeNull();
  });

  it('REFRESHES before probing, so a stale token is not reported as broken', async () => {
    const fx = await makeWorkItemFixture({ name: 'Stale', identifier: 'STLE' });
    const grant = await seedGrant(fx, -60_000);

    const verdict = await monitorCredentialService.probeHealth(fx.projectId, grant.id, fx.ctx);

    // The false negative this ordering prevents: reporting `degraded` on a
    // connection that is merely stale teaches people to ignore the badge.
    expect(fakeMonitorState().refreshCount).toBe(1);
    expect(verdict.health).toBe('connected');
  });

  it('reports the refresh’s OWN verdict when the credential is gone', async () => {
    const fx = await makeWorkItemFixture({ name: 'Gone', identifier: 'GONE' });
    const grant = await seedGrant(fx, -60_000);
    fakeMonitorState().failNext.add('refreshCredential');

    const verdict = await monitorCredentialService.probeHealth(fx.projectId, grant.id, fx.ctx);

    expect(verdict.health).toBe('degraded');
    expect(verdict.healthReason).toBe('The authorization has been revoked.');
    // ONE verdict, read back from the row the refresh wrote — not a second write
    // that could disagree with it.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.healthReason).toBe(verdict.healthReason);
  });

  it('asserts `integration:manage` — a probe spends a provider call and writes a row', async () => {
    const fx = await makeWorkItemFixture({ name: 'PrbGate', identifier: 'PGTE' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);
    const viewer = await adminDb.user.create({
      data: { name: 'V', email: `pv-${Date.now()}@example.com` },
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

    await expect(
      monitorCredentialService.probeHealth(fx.projectId, grant.id, {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('NO SCHEDULE is added — the boundary, asserted rather than asserted-in-a-comment', () => {
  it('is referenced by no job definition, no cron entry and no scheduled route', () => {
    // Every schedule in this story belongs to MOTIR-4929, which owns the poll.
    // This card's own criterion asks for the absence to be a test, because a
    // boundary stated only in prose is one the next card crosses by accident.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!p.endsWith('.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (!src.includes('monitorCredentialService')) continue;
        // A job definition declares itself; a cron entry names a schedule.
        if (/defineJob\(|cron:\s*['"]/.test(src)) offenders.push(p);
      }
    };
    walk(join(process.cwd(), 'lib'));
    walk(join(process.cwd(), 'app'));
    walk(join(process.cwd(), 'scripts'));

    expect(
      offenders,
      'a schedule reached the credential service; MOTIR-4929 owns every schedule',
    ).toEqual([]);
  });
});
