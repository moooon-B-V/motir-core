import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

// Better-Auth's rate limiter buckets /sign-in|/sign-up per IP (window 10s, max 3),
// and every test here signs in to obtain the real session cookie the plugin's
// approve/deny endpoints read. Under vitest there is no client IP, so all of them
// land in ONE bucket and the fourth sign-in of a run would 429 — a flake that has
// nothing to do with the code under test. The opt-in flag `lib/auth` already honours
// is set in `vi.hoisted` so it lands BEFORE the auth module is imported and its
// config is frozen. Production never sets it (default: limiter on).
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_TOKEN_SCOPES } = await import('@/lib/mcp/scopes');
const { CLI_CLIENT_ID, CLI_TOKEN_EXPIRY_DAYS } = await import('@/lib/cliDevice/constants');
const {
  DeviceGrantDeniedError,
  DeviceGrantExpiredError,
  DeviceGrantForbiddenError,
  DeviceGrantNotClaimedError,
  DeviceGrantNotPendingError,
  DeviceGrantPendingError,
  DeviceGrantSlowDownError,
  InvalidDeviceGrantError,
} = await import('@/lib/cliDevice/errors');
const { NotAMemberError } = await import('@/lib/workspaces/errors');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

// Service-layer tests for the `motir login` device-authorization flow (Story
// MOTIR-1863 · Subtask MOTIR-1865, implementing docs/decisions/cli-login.md).
// Real Postgres and the REAL Better-Auth plugin — nothing is mocked, including the
// session: each test signs in for real and forwards the resulting cookie, because
// the plugin's claim/approve/deny endpoints read the session from the request
// themselves and a stubbed `getSession()` would not reach them.
//
// The three acts under test: `start` (the terminal opens a grant), the plugin's
// claim + approve/deny (the browser), and `poll` (the terminal exchanges the grant
// for a PAT). The `device_code` rows are reached by `truncateAuthTables`'s
// user/workspace CASCADE.

const BASE_URL = 'http://localhost:3000';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Sign in for real and return the headers a browser would send next — the only way
 * to exercise the plugin's session-gated endpoints. */
async function signIn(user: User): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE_URL }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token');
  return new Headers({ cookie, origin: BASE_URL });
}

/** The plugin's `GET /device?user_code=…` — stamps `userId` onto the grant. Approve
 * and deny both refuse an unclaimed code, so every browser path starts here. */
async function claim(userCode: string, headers: Headers): Promise<void> {
  await auth.api.deviceVerify({ query: { user_code: userCode }, headers });
}

async function poll(deviceCode: string) {
  return cliDeviceService.poll({ deviceCode, clientId: CLI_CLIENT_ID });
}

/** Clear the per-grant throttle so a test can poll twice in a row on purpose. The
 * alternative — a real 5-second wait per assertion — would add ~30s to the file. */
async function clearPollThrottle(deviceCode: string): Promise<void> {
  await db.deviceCode.update({ where: { deviceCode }, data: { lastPolledAt: null } });
}

/** Force the plugin's connection pool to open ≥ n physical connections so racing
 * transactions each get their own and run truly concurrently — the FOR UPDATE lock,
 * not a single shared connection, is then what serializes them. A cold pool would
 * serialize the writes and mask the double-mint race entirely. */
async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
}

describe('start', () => {
  it('issues an RFC 8628 grant, records the hostname, and persists a pending row', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    expect(grant.device_code).toHaveLength(40);
    expect(grant.user_code).toHaveLength(8);
    // The default charset excludes 0/O/1/I/L — no override needed, and this asserts
    // the plugin has not changed it under us.
    expect(grant.user_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    // Relative verificationUri resolved against Better-Auth's baseURL chain, with the
    // code pre-filled on the "complete" variant (what the CLI opens in a browser).
    expect(grant.verification_uri).toBe(`${BASE_URL}/device`);
    expect(grant.verification_uri_complete).toBe(`${BASE_URL}/device?user_code=${grant.user_code}`);
    expect(grant.expires_in).toBe(15 * 60); // the ADR's 15m, not the plugin's 30m
    expect(grant.interval).toBe(5);

    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.status).toBe('pending');
    expect(row.userId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.hostname).toBe('workbox');
    expect(row.clientId).toBe(CLI_CLIENT_ID);
    // The requested scope is recorded for RFC fidelity; the MINT reads the constant.
    expect(row.scope).toBe(CLI_TOKEN_SCOPES.join(' '));
    expect(row.pollingInterval).toBe(5000); // milliseconds, the plugin's unit
    expect(row.lastPolledAt).toBeNull();
  });

  it('falls back to a placeholder hostname so the token label is always valid', async () => {
    const grant = await cliDeviceService.start({ hostname: null });
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.hostname).toBe('unknown host');
  });

  it('caps an absurd hostname so `CLI · <host>` cannot exceed the 100-char label limit', async () => {
    const grant = await cliDeviceService.start({ hostname: 'h'.repeat(500) });
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(`CLI · ${row.hostname}`.length).toBeLessThanOrEqual(100);
  });
});

describe('poll — the five states', () => {
  it('answers authorization_pending before approval, and COMMITS the poll clock', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantPendingError);

    // The regression guard for the trap this service is shaped around: the poll's
    // writes live inside a transaction, so THROWING from inside it would roll the
    // `lastPolledAt` stamp back and leave slow_down permanently unreachable. The
    // outcome is returned out of the transaction and thrown after it commits.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.lastPolledAt).not.toBeNull();
    expect(row.status).toBe('pending');
  });

  it('answers slow_down when polled inside the interval, WITHOUT pushing the window forward', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantPendingError);
    const firstStamp = (
      await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })
    ).lastPolledAt;

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantSlowDownError);

    // A throttled poll must NOT re-stamp the clock — otherwise a hot-looping client
    // would never escape slow_down.
    const afterStamp = (
      await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })
    ).lastPolledAt;
    expect(afterStamp?.getTime()).toBe(firstStamp?.getTime());
  });

  it('answers access_denied after a deny, and reaps the row', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await auth.api.deviceDeny({ body: { userCode: grant.user_code }, headers });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantDeniedError);

    // Denied grants are deleted on discovery: not re-pollable, and nothing minted.
    expect(await db.deviceCode.count({ where: { deviceCode: grant.device_code } })).toBe(0);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('answers expired_token past the expiry, and reaps the row', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantExpiredError);
    expect(await db.deviceCode.count({ where: { deviceCode: grant.device_code } })).toBe(0);
  });

  it('answers invalid_grant for an unknown device code', async () => {
    await expect(poll('no-such-device-code')).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });

  it('answers invalid_grant for a client_id that is not the CLI', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await expect(
      cliDeviceService.poll({ deviceCode: grant.device_code, clientId: 'someone-else' }),
    ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });
});

describe('approve → poll — the mint', () => {
  it('mints exactly ONE CLI-scoped PAT the bearer gate accepts, and consumes the grant', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    // Approval records a DECISION and mints nothing — the invariant that makes
    // "approve then kill the CLI" leave no credential behind.
    expect(await db.apiToken.count()).toBe(0);
    const approved = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(approved.status).toBe('approved');
    expect(approved.workspaceId).toBe(workspace.id);
    expect(approved.userId).toBe(owner.id);

    const granted = await poll(grant.device_code);

    expect(granted.access_token.startsWith('motir_pat_')).toBe(true);
    expect(granted.token_type).toBe('Bearer');
    expect(granted.scope).toBe('read work_items:write integration');
    // 90 days, derived from the token's own expiresAt (never from the constant).
    expect(granted.expires_in).toBeGreaterThan(CLI_TOKEN_EXPIRY_DAYS * 86400 - 60);
    expect(granted.expires_in).toBeLessThanOrEqual(CLI_TOKEN_EXPIRY_DAYS * 86400);
    expect(granted.user).toEqual({ id: owner.id, name: owner.name, email: owner.email });
    expect(granted.workspace).toEqual({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    });

    // Exactly one token row, with the ADR's label / scopes / expiry / binding.
    const tokens = await db.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe('CLI · workbox');
    expect(tokens[0]!.scopes.sort()).toEqual([...CLI_TOKEN_SCOPES].sort());
    expect(tokens[0]!.workspaceId).toBe(workspace.id);
    expect(tokens[0]!.userId).toBe(owner.id);
    const daysOut = (tokens[0]!.expiresAt!.getTime() - Date.now()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(CLI_TOKEN_EXPIRY_DAYS - 1);
    expect(daysOut).toBeLessThanOrEqual(CLI_TOKEN_EXPIRY_DAYS);

    // The whole point: this plaintext is a credential the bearer gates accept, bound
    // to the chosen workspace (never the owner's default).
    const verified = await apiTokensService.verify(granted.access_token);
    expect(verified.user.id).toBe(owner.id);
    expect(verified.workspaceId).toBe(workspace.id);
    expect(verified.scopes.sort()).toEqual([...CLI_TOKEN_SCOPES].sort());

    // Single-use: the grant is gone, so a second poll cannot re-issue.
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('does NOT re-issue on a second poll of the same device code', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    await poll(grant.device_code);

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(InvalidDeviceGrantError);
    expect(await db.apiToken.count()).toBe(1);
  });

  it('mints a NARROWER grant than a settings-minted token (never the default set)', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    const granted = await poll(grant.device_code);

    const scopes = (await apiTokensService.verify(granted.access_token)).scopes;
    // The three the CLI's sixteen tools need — and none of the destructive ones the
    // default set would have handed to a credential living unattended on a box.
    expect(scopes).not.toContain('work_items:delete');
    expect(scopes).not.toContain('work_items:archive');
    expect(scopes).not.toContain('sprints:write');
  });

  it('accepts a dash-grouped, lowercase user code (both sides normalise identically)', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    const typed = `${grant.user_code.slice(0, 4)}-${grant.user_code.slice(4)}`.toLowerCase();
    await cliDeviceService.approve({
      userCode: typed,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    const granted = await poll(grant.device_code);
    expect(granted.access_token.startsWith('motir_pat_')).toBe(true);
  });
});

describe('approve — the gates', () => {
  it('refuses a workspace the approver is not a member of, and writes NO binding', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const { workspace: foreign } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: foreign.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);

    // The membership gate runs BEFORE the binding write, so nothing was recorded and
    // the grant is still approvable against a legitimate workspace.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.workspaceId).toBeNull();
    expect(row.status).toBe('pending');

    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } }))
        .workspaceId,
    ).toBe(workspace.id);
  });

  it('refuses a code no verifying session has claimed yet', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    // No claim() — the /device page skipped GET /api/auth/device?user_code=…

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotClaimedError);
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } }))
        .workspaceId,
    ).toBeNull();
  });

  it('refuses an approver who is not the session that claimed the code', async () => {
    const { owner: alice } = await createTestWorkspace();
    const { owner: bob, workspace: bobWs } = await createTestWorkspace();
    const aliceHeaders = await signIn(alice);
    const bobHeaders = await signIn(bob);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, aliceHeaders); // Alice claimed it

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: bobWs.id,
        actorUserId: bob.id,
        headers: bobHeaders,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses an already-approved grant rather than replaying it', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotPendingError);
  });

  it('refuses an expired code', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantExpiredError);
  });
});

describe('concurrency (real Postgres, warm pool)', () => {
  it('two SIMULTANEOUS polls of one approved grant mint exactly ONE token', async () => {
    // The race this guards: the CLI polls on an interval, so two requests can observe
    // the same `approved` row and both mint — two credentials for one approval. The
    // guard is that the single-use DELETE is the claim, taken under a FOR UPDATE lock
    // (notes.html #35), so the loser re-reads nothing. Without the lock + re-read this
    // test yields two api_token rows under a warm pool.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    // Both racers must clear the throttle check, or the loser would answer slow_down
    // for the wrong reason and the double-mint window would never be probed.
    await clearPollThrottle(grant.device_code);

    await warmPool();
    const results = await Promise.allSettled([poll(grant.device_code), poll(grant.device_code)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof poll>>
    >[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Either legitimate outcome for the loser: the row was already consumed
    // (invalid_grant) or it lost the throttle check (slow_down) — never a second token.
    expect(
      rejected[0]!.reason instanceof InvalidDeviceGrantError ||
        rejected[0]!.reason instanceof DeviceGrantSlowDownError,
    ).toBe(true);

    const tokens = await db.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    // The winner's plaintext is the one that works; there is no second credential.
    const verified = await apiTokensService.verify(fulfilled[0]!.value.access_token);
    expect(verified.workspaceId).toBe(workspace.id);
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('two SIMULTANEOUS approvals of one grant approve it once and mint NOTHING', async () => {
    // Approval is the other read-derived write on this row (read status, write the
    // workspace binding + the flip). It mints nothing by design, so the invariant here
    // is weaker than the poll's: at most one approval succeeds, the row ends up
    // approved exactly once with a workspace the approver chose, and no credential
    // exists until someone polls.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await warmPool();
    const results = await Promise.allSettled([
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ]);

    // At least one must succeed; a loser (if any) is refused as already-processed —
    // never with a second credential and never leaving the row unapproved.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(DeviceGrantNotPendingError);
      }
    }
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.status).toBe('approved');
    expect(row.workspaceId).toBe(workspace.id);
    expect(await db.apiToken.count()).toBe(0);

    // And the grant still mints exactly once afterwards.
    await clearPollThrottle(grant.device_code);
    await poll(grant.device_code);
    expect(await db.apiToken.count()).toBe(1);
  });
});
