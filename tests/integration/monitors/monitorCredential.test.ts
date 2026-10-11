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
import { MONITOR_REFRESH_TIMEOUT_MS } from '@/lib/monitors/provider';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import {
  MONITOR_REFRESH_LEASE_MS,
  monitorCredentialService,
} from '@/lib/services/monitorCredentialService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';

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

describe('a SLOW refresh still commits the rotated pair (MOTIR-5988)', () => {
  // The production incident: the provider took longer than Prisma's default
  // 5 s interactive-transaction timeout, ROTATED the refresh token, and the
  // write that should have stored the new pair ran on an expired transaction and
  // rolled back — leaving a refresh token the provider had already invalidated.
  // Every refresh after that is refused, and only a person re-authorising
  // recovers it. So the provider is slowed past 5 s here, and the proof is the
  // RE-READ ROW, never the returned value.
  it('persists the pair a provider returned after more than five seconds', async () => {
    const fx = await makeWorkItemFixture({ name: 'Slow', identifier: 'SLOW' });
    const grant = await seedGrant(fx, -60_000);
    const original = fakeMonitorProvider.refreshCredential.bind(fakeMonitorProvider);
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockImplementation(async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return original(args);
    });

    const credential = await monitorCredentialService.getAccessToken(grant.id);

    expect(credential.token).toBe('fake-access-token-1');
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('fake-access-token-1');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token-1');
    expect(row.health).toBe('connected');
  }, 30_000);

  it('gives the refresh LEASE a life that outlives the provider call it guards', () => {
    // MOTIR-8184 replaced the long transaction with a lease. A lease that expired
    // while its holder was still waiting on the provider would let a second
    // caller spend the same rotating refresh token. Pinned as arithmetic, so
    // neither constant can be edited alone into a gap.
    expect(MONITOR_REFRESH_LEASE_MS).toBeGreaterThan(MONITOR_REFRESH_TIMEOUT_MS);
  });
});

/**
 * A provider that behaves like Sentry where MOTIR-8184 bit: it ROTATES the
 * refresh token on every accepted refresh and REFUSES any refresh token but the
 * current one, with Sentry's own words. The repo's plain fake mints a new pair
 * whatever it is handed, so it cannot show a lost rotation at all.
 */
function rotatingProvider(opts: { delayMs?: number } = {}) {
  const state = { valid: 'stored-refresh', calls: 0, accepted: 0, seen: [] as string[] };
  const spy = vi
    .spyOn(fakeMonitorProvider, 'refreshCredential')
    .mockImplementation(async ({ refreshToken }) => {
      state.calls += 1;
      state.seen.push(refreshToken);
      if (refreshToken !== state.valid) {
        throw new MonitorProviderCallError(
          'refreshCredential',
          400,
          'Given refresh token does not exist',
        );
      }
      state.accepted += 1;
      state.valid = `rot-refresh-${state.accepted}`;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return {
        accessToken: `rot-access-${state.accepted}`,
        refreshToken: state.valid,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      };
    });
  return { state, spy };
}

async function expireStoredToken(id: string): Promise<void> {
  await adminDb.monitorInstallation.update({
    where: { id },
    data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
  });
}

describe('the ROTATED PAIR is committed first and alone (MOTIR-8184)', () => {
  it('stores a pair the provider answered slowly, and the NEXT refresh spends it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Rotate', identifier: 'ROTA' });
    const grant = await seedGrant(fx, -60_000);
    const { state } = rotatingProvider({ delayMs: 1_500 });

    const first = await monitorCredentialService.getAccessToken(grant.id);
    expect(first.token).toBe('rot-access-1');

    // The proof is the SECOND refresh: it presents the rotated token, which the
    // provider accepts. A pair that was lost would be refused here with
    // "Given refresh token does not exist" — the production symptom.
    await expireStoredToken(grant.id);
    const second = await monitorCredentialService.getAccessToken(grant.id);
    expect(second.token).toBe('rot-access-2');
    expect(state.seen).toEqual(['stored-refresh', 'rot-refresh-1']);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('rot-refresh-2');
    expect(row.refreshLeaseUntil).toBeNull();
  });

  it('has the new pair COMMITTED before the health write — a process stopped there loses nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Stopped', identifier: 'STPD' });
    const grant = await seedGrant(fx, -60_000);
    const { state } = rotatingProvider();
    // The machine "stops" at the first thing after the pair: the health write.
    vi.spyOn(monitorInstallationRepository, 'updateHealth').mockRejectedValueOnce(
      new Error('the machine stopped'),
    );

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow(
      'the machine stopped',
    );

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.accessTokenEncrypted)).toBe('rot-access-1');
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('rot-refresh-1');
    expect(row.refreshLeaseUntil).toBeNull();

    // And the connection is alive: the next refresh spends the stored pair.
    await expireStoredToken(grant.id);
    const next = await monitorCredentialService.getAccessToken(grant.id);
    expect(next.token).toBe('rot-access-2');
    expect(state.accepted).toBe(2);
  });

  it('holds NO row lock while the provider is answering', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoLock', identifier: 'NOLK' });
    const grant = await seedGrant(fx, -60_000);
    let writeDuringCall: unknown = 'not attempted';
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockImplementation(async () => {
      // Another connection writes the same row WHILE the call is in flight. Under
      // the old design the refresh held `FOR UPDATE` here, so this write waited
      // for the refresh, which was waiting for this write: a lock timeout.
      try {
        await adminDb.$transaction([
          adminDb.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`),
          adminDb.monitorInstallation.update({
            where: { id: grant.id },
            data: { healthCheckedAt: new Date() },
          }),
        ]);
        writeDuringCall = 'committed';
      } catch (err) {
        writeDuringCall = err;
      }
      return {
        accessToken: 'mid-access',
        refreshToken: 'mid-refresh',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      };
    });

    await monitorCredentialService.getAccessToken(grant.id);

    expect(writeDuringCall).toBe('committed');
  });

  it('records a refresh that got NO ANSWER as uncertain, and leaves the stored pair alone', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoAns', identifier: 'NOAN' });
    const grant = await seedGrant(fx, -60_000);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockRejectedValueOnce(
      new MonitorProviderCallError('refreshCredential', null, 'No response within 60000ms.'),
    );

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toBeInstanceOf(
      MonitorProviderCallError,
    );

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.refreshUncertainAt).not.toBeNull();
    expect(row.refreshLeaseUntil).toBeNull();
    // The provider may have rotated; overwriting or clearing the pair would only
    // destroy the one token that still works if it did NOT.
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('stored-refresh');

    // A later successful refresh is what clears the mark.
    await monitorCredentialService.getAccessToken(grant.id);
    const after = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(after.refreshUncertainAt).toBeNull();
  });

  it('retries the pair write through a transient database error rather than losing it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Retry', identifier: 'RTPW' });
    const grant = await seedGrant(fx, -60_000);
    const store = vi
      .spyOn(monitorInstallationRepository, 'storeRefreshedTokens')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const credential = await monitorCredentialService.getAccessToken(grant.id);

    expect(credential.token).toBe('fake-access-token-1');
    expect(store).toHaveBeenCalledTimes(2);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('fake-refresh-token-1');
  });

  it('surfaces a pair write that keeps failing, after its last attempt', async () => {
    const fx = await makeWorkItemFixture({ name: 'Down', identifier: 'DOWN' });
    const grant = await seedGrant(fx, -60_000);
    const store = vi
      .spyOn(monitorInstallationRepository, 'storeRefreshedTokens')
      .mockRejectedValue(new Error('the database is down'));

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow(
      'the database is down',
    );
    expect(store).toHaveBeenCalledTimes(3);
  });

  it('records a provider failure that is not a typed call error in our own words', async () => {
    const fx = await makeWorkItemFixture({ name: 'Untyped', identifier: 'UNTY' });
    const grant = await seedGrant(fx, -60_000);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockRejectedValueOnce(new Error('boom'));

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow('boom');

    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.healthReason).toBe('The refresh failed.');
    // Not a "no answer": nothing says the provider ever saw it.
    expect(row.refreshUncertainAt).toBeNull();
    expect(row.refreshLeaseUntil).toBeNull();
  });

  it('names the earlier lost answer on the refusal that follows it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Since', identifier: 'SNCE' });
    const grant = await seedGrant(fx, -60_000);
    const lostAt = new Date(Date.now() - 5 * 60_000);
    await adminDb.monitorInstallation.update({
      where: { id: grant.id },
      data: { refreshUncertainAt: lostAt },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockRejectedValueOnce(
      new MonitorProviderCallError('refreshCredential', 400, 'Given refresh token does not exist'),
    );

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      providerReason: 'Given refresh token does not exist',
      refreshUncertainSince: lostAt.toISOString(),
    });
  });

  it('writes ONE log line per refresh, with its duration and new expiry and no token', async () => {
    const fx = await makeWorkItemFixture({ name: 'LogOk', identifier: 'LGOK' });
    const grant = await seedGrant(fx, -60_000);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await monitorCredentialService.getAccessToken(grant.id);

    const lines = info.mock.calls.filter((c) => String(c[0]).includes('monitorCredentialService'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toMatchObject({
      installationRowId: grant.id,
      provider: 'sentry',
      durationMs: expect.any(Number),
      expiresAt: expect.any(String),
    });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('fake-access-token');
    expect(serialized).not.toContain('fake-refresh-token');
    expect(serialized).not.toContain('v1.');
  });

  it('a refusal also carries its duration on its one line', async () => {
    const fx = await makeWorkItemFixture({ name: 'LogNo', identifier: 'LGNO' });
    const grant = await seedGrant(fx, -60_000);
    fakeMonitorState().failNext.add('refreshCredential');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await expect(monitorCredentialService.getAccessToken(grant.id)).rejects.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ durationMs: expect.any(Number) });
    expect(info.mock.calls.filter((c) => String(c[0]).includes('monitorCredential'))).toEqual([]);
  });
});

describe('the refresh LEASE keeps it single-flight without an open lock (MOTIR-8184)', () => {
  it('waits on a LIVE lease and takes the holder’s pair, making no provider call', async () => {
    const fx = await makeWorkItemFixture({ name: 'Lease', identifier: 'LEAS' });
    const grant = await seedGrant(fx, -60_000);
    // Another process holds the lease and is mid-call.
    await adminDb.monitorInstallation.update({
      where: { id: grant.id },
      data: { refreshLeaseUntil: new Date(Date.now() + 30_000) },
    });
    // …and stores its pair a moment later, releasing the lease.
    const holder = (async () => {
      await new Promise((r) => setTimeout(r, 800));
      await adminDb.monitorInstallation.update({
        where: { id: grant.id },
        data: {
          accessTokenEncrypted: encryptToken('holder-access'),
          refreshTokenEncrypted: encryptToken('holder-refresh'),
          tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
          refreshLeaseUntil: null,
        },
      });
    })();

    const credential = await monitorCredentialService.getAccessToken(grant.id);
    await holder;

    expect(credential.token).toBe('holder-access');
    expect(fakeMonitorState().refreshCount).toBe(0);
  });

  it('takes over an EXPIRED lease — a process that died mid-call does not wedge the grant', async () => {
    const fx = await makeWorkItemFixture({ name: 'Stale', identifier: 'STAL' });
    const grant = await seedGrant(fx, -60_000);
    await adminDb.monitorInstallation.update({
      where: { id: grant.id },
      data: { refreshLeaseUntil: new Date(Date.now() - 1_000) },
    });

    const credential = await monitorCredentialService.getAccessToken(grant.id);

    expect(credential.token).toBe('fake-access-token-1');
    expect(fakeMonitorState().refreshCount).toBe(1);
  });

  it('a FORCED refresh that waited on another one spends no second refresh token', async () => {
    const fx = await makeWorkItemFixture({ name: 'Force', identifier: 'FORC' });
    const grant = await seedGrant(fx, 4 * 60 * 60 * 1000);
    const { state } = rotatingProvider({ delayMs: 800 });

    // Two callers both saw a 401 on a fresh-looking token and force a refresh
    // at once: one refreshes, the other waits on its lease and takes its pair.
    const [a, b] = await Promise.all([
      monitorCredentialService.forceRefresh(grant.id),
      monitorCredentialService.forceRefresh(grant.id),
    ]);

    expect(state.calls).toBe(1);
    expect(a.token).toBe('rot-access-1');
    expect(b.token).toBe('rot-access-1');
  });

  it('lets a stopping process wait for a refresh in flight to COMMIT its pair', async () => {
    const fx = await makeWorkItemFixture({ name: 'Drain', identifier: 'DRAN' });
    const grant = await seedGrant(fx, -60_000);
    rotatingProvider({ delayMs: 1_000 });

    const pending = monitorCredentialService.getAccessToken(grant.id);
    // Let the refresh take its lease and reach the provider.
    await new Promise((r) => setTimeout(r, 300));
    const drained = await monitorCredentialService.settleInFlightRefreshes(10_000);

    expect(drained.pending).toBe(0);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({ where: { id: grant.id } });
    expect(decryptToken(row.refreshTokenEncrypted)).toBe('rot-refresh-1');
    await pending;
  });

  it('answers at once when nothing is in flight', async () => {
    await expect(monitorCredentialService.settleInFlightRefreshes(10_000)).resolves.toEqual({
      pending: 0,
    });
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
      data: {
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        workspaceRole: 'member',
      },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
      },
    });
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');

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
