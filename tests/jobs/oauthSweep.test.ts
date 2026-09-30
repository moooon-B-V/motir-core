import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The OAuth sweep (Story MOTIR-6973 · Subtask MOTIR-6984), against the real
// database: what it deletes, what it must never delete, that a second run finds
// nothing, and that each kind is capped per run. Rows are written the way the
// provider writes them — through the real OAuth flow where a live connection is
// needed, directly with `adminDb` where only an expiry or an age is under test.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { jobSchedules } = await import('@/lib/jobs/schedules');
const { OAUTH_SWEEP_CRON } = await import('@/lib/jobs/definitions/oauthSweep');
const { OAUTH_CLIENT_UNUSED_DAYS, OAUTH_SWEEP_MAX_BATCHES, oauthSweepService } =
  await import('@/lib/services/oauthSweepService');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const { connect, exchange, pkce, registeredClientId } = await import('../helpers/oauthFlow');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 60 * 60_000);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

/** A dynamically registered client (no user), created `ageDays` ago. */
async function client(ageDays = 0): Promise<string> {
  const clientId = uid('client');
  await adminDb.oauthClient.create({
    data: {
      clientId,
      name: 'Probe',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      createdAt: new Date(Date.now() - ageDays * DAY_MS),
    },
  });
  return clientId;
}

/** A live connection with a live access + refresh token, through the real flow. */
async function liveConnection() {
  const clientId = await registeredClientId();
  const keys = pkce();
  const c = await connect({ clientId, keys });
  await exchange(clientId, c.code, keys.verifier);
  return { ...c, clientId };
}

async function authorizationCode(expiresAt: Date): Promise<void> {
  await adminDb.verification.create({
    data: {
      identifier: uid('code'),
      value: JSON.stringify({ type: 'authorization_code', query: {}, userId: 'u' }),
      expiresAt,
    },
  });
}

describe('registration', () => {
  it('is registered with a daily cron and appears in the schedule table', () => {
    expect(jobDefinitions.some((d) => d.id === 'system.oauth-sweep')).toBe(true);
    expect(jobSchedules()).toContainEqual(
      expect.objectContaining({ functionId: 'system.oauth-sweep', cron: OAUTH_SWEEP_CRON }),
    );
    expect(OAUTH_SWEEP_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('oauthSweepService.sweep', () => {
  it('deletes expired codes and tokens and keeps unexpired ones and live connections’ tokens', async () => {
    const live = await liveConnection();
    await authorizationCode(PAST());
    await authorizationCode(FUTURE());
    // An unrelated verification row past its expiry is not the sweep's.
    await adminDb.verification.create({
      data: { identifier: uid('reset'), value: 'someone', expiresAt: PAST() },
    });
    // A second, EXPIRED access + refresh pair on the live connection.
    const refresh = await adminDb.oauthRefreshToken.create({
      data: {
        token: uid('rt'),
        clientId: live.clientId,
        userId: live.user.id,
        referenceId: live.connectionId,
        expiresAt: PAST(),
        scopes: ['offline_access'],
      },
    });
    await adminDb.oauthAccessToken.create({
      data: {
        token: uid('at'),
        clientId: live.clientId,
        userId: live.user.id,
        referenceId: live.connectionId,
        expiresAt: PAST(),
        scopes: [],
      },
    });

    const result = await oauthSweepService.sweep();
    expect(result).toMatchObject({ refreshTokens: 1, accessTokens: 1, authorizationCodes: 1 });
    expect(await adminDb.oauthRefreshToken.findUnique({ where: { id: refresh.id } })).toBeNull();
    // The live connection's own tokens survive.
    expect(await adminDb.oauthAccessToken.count()).toBe(1);
    expect(await adminDb.oauthRefreshToken.count()).toBe(1);
    expect(await adminDb.apiToken.count({ where: { id: live.connectionId } })).toBe(1);
    // The unexpired code and the unrelated row survive.
    expect(await adminDb.verification.count()).toBe(2);
  });

  it('a revoked connection leaves nothing, and a token with no connection is swept', async () => {
    const live = await liveConnection();
    await oauthConnectionsService.revoke(live.user.id, live.connectionId);
    expect(await adminDb.oauthAccessToken.count()).toBe(0);
    // A token carrying no connection — the gate refuses it — is dead weight.
    await adminDb.oauthAccessToken.create({
      data: {
        token: uid('at'),
        clientId: live.clientId,
        userId: live.user.id,
        expiresAt: FUTURE(),
        scopes: [],
      },
    });
    const result = await oauthSweepService.sweep();
    expect(result.accessTokens).toBe(1);
    expect(await adminDb.oauthAccessToken.count()).toBe(0);
  });

  it(`deletes a client older than ${OAUTH_CLIENT_UNUSED_DAYS} days with no connection, and keeps a young one or one with a connection`, async () => {
    const stale = await client(OAUTH_CLIENT_UNUSED_DAYS + 1);
    const young = await client(OAUTH_CLIENT_UNUSED_DAYS - 1);
    const live = await liveConnection();
    await adminDb.oauthClient.update({
      where: { clientId: live.clientId },
      data: { createdAt: new Date(Date.now() - (OAUTH_CLIENT_UNUSED_DAYS + 5) * DAY_MS) },
    });

    const result = await oauthSweepService.sweep();
    expect(result.clients).toBe(1);
    const left = (await adminDb.oauthClient.findMany()).map((c) => c.clientId).sort();
    expect(left).toEqual([young, live.clientId].sort());
    expect(left).not.toContain(stale);
    expect(await adminDb.apiToken.count({ where: { id: live.connectionId } })).toBe(1);
  });

  it('a second run in a row deletes nothing', async () => {
    await liveConnection();
    await authorizationCode(PAST());
    await client(OAUTH_CLIENT_UNUSED_DAYS + 1);
    const first = await oauthSweepService.sweep();
    expect(first.authorizationCodes + first.clients).toBe(2);
    expect(await oauthSweepService.sweep()).toEqual({
      refreshTokens: 0,
      accessTokens: 0,
      authorizationCodes: 0,
      clients: 0,
    });
  });

  it('caps each delete per run, and the next run carries on', async () => {
    const batch = 2;
    const cap = batch * OAUTH_SWEEP_MAX_BATCHES;
    for (let i = 0; i < cap + 3; i += 1) await authorizationCode(PAST());
    const first = await oauthSweepService.sweep(new Date(), batch);
    expect(first.authorizationCodes).toBe(cap);
    const second = await oauthSweepService.sweep(new Date(), batch);
    expect(second.authorizationCodes).toBe(3);
  });
});
