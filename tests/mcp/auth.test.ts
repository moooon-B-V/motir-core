import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP transport-level auth gate (Subtask 7.8.4) over real Postgres. `verifyMcpToken`
// is the function `withMcpAuth` calls per request; returning `undefined` is what
// makes the request a 401 BEFORE any tool dispatch. These tests assert the
// gate's decision + the resolved actor it stashes in `AuthInfo.extra`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function reqWithBearer(token?: string): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('verifyMcpToken', () => {
  it('resolves a live token to the owning user + active workspace', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, { label: 'claude-code' });

    // Explicit bearer (as mcp-handler passes it)…
    const info = await verifyMcpToken(reqWithBearer(), token);
    expect(info).toBeDefined();
    expect(info?.clientId).toBe(fx.ownerId);
    expect(info?.extra).toMatchObject({ userId: fx.ownerId, workspaceId: fx.workspaceId });

    // …and parsed off the Authorization header when no bearer is supplied.
    const fromHeader = await verifyMcpToken(reqWithBearer(token));
    expect(fromHeader?.extra).toMatchObject({ userId: fx.ownerId, workspaceId: fx.workspaceId });
  });

  it('rejects an absent / malformed / unknown token (→ 401)', async () => {
    expect(await verifyMcpToken(reqWithBearer())).toBeUndefined();
    expect(await verifyMcpToken(reqWithBearer('not-a-motir-token'))).toBeUndefined();
    expect(await verifyMcpToken(reqWithBearer('motir_pat_deadbeef'))).toBeUndefined();
  });

  it('rejects a revoked token', async () => {
    const fx = await makeWorkItemFixture();
    const { token, dto } = await apiTokensService.create(fx.ownerId, { label: 'revoked' });
    await apiTokensService.revoke(fx.ownerId, dto.id);
    expect(await verifyMcpToken(reqWithBearer(), token)).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, {
      label: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await verifyMcpToken(reqWithBearer(), token)).toBeUndefined();
  });
});
