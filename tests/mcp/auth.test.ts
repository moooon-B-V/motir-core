import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';

// MCP transport-level auth gate (Subtask 7.8.4) over real Postgres. `verifyMcpToken`
// is the function `withMcpAuth` calls per request; returning `undefined` is what
// makes the request a 401 BEFORE any tool dispatch. These tests assert the
// gate's decision + the resolved actor it stashes in `AuthInfo.extra`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function reqWithBearer(token?: string): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('verifyMcpToken', () => {
  it("resolves a live token to the owning user + the token's bound workspace", async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    // Explicit bearer (as mcp-handler passes it)…
    const info = await verifyMcpToken(reqWithBearer(), token);
    expect(info).toBeDefined();
    expect(info?.clientId).toBe(fx.ownerId);
    expect(info?.extra).toMatchObject({ userId: fx.ownerId, workspaceId: fx.workspaceId });

    // …and parsed off the Authorization header when no bearer is supplied.
    const fromHeader = await verifyMcpToken(reqWithBearer(token));
    expect(fromHeader?.extra).toMatchObject({ userId: fx.ownerId, workspaceId: fx.workspaceId });
  });

  it('resolves the workspace the token was minted in, NOT the owner’s default workspace (bug 7.21)', async () => {
    // The owner's first/default workspace is the fixture's; the token is bound
    // to a SECOND workspace. The gate must resolve the second, not the default.
    const fx = await makeWorkItemFixture();
    const { workspace: second } = await createTestWorkspace({
      ownerUserId: fx.ownerId,
      name: 'Second',
    });
    const { token } = await apiTokensService.create(fx.ownerId, second.id, {
      label: 'second-ws',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const info = await verifyMcpToken(reqWithBearer(), token);
    expect(info?.extra).toMatchObject({ userId: fx.ownerId, workspaceId: second.id });
    expect((info?.extra as { workspaceId: string }).workspaceId).not.toBe(fx.workspaceId);
  });

  it('carries the token’s resolved GRANT on AuthInfo.extra (MOTIR-2576)', async () => {
    const fx = await makeWorkItemFixture();
    const permissions = grantForLegacyScopes(['read', 'work_items:write']);
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'scoped',
      permissions,
      projectId: fx.projectId,
    });

    const info = await verifyMcpToken(reqWithBearer(), token);
    const grant = (info?.extra as { grant?: string[] }).grant ?? [];
    expect([...grant].sort()).toEqual([...permissions].sort());
  });

  it('carries an EXPANDED grant for a row written before MOTIR-2572', async () => {
    // The seam the whole compatibility promise passes through: by the time the
    // dispatch gate reads `extra`, a legacy scope string has already become the
    // permissions it conferred — so no gate downstream ever sees one.
    const fx = await makeWorkItemFixture();
    const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'legacy',
      fixedGrant: ['project:browse'],
    });
    await adminDb.apiToken.update({
      where: { id: dto.id },
      data: { scopes: ['read', 'sprints:write'] },
    });

    const info = await verifyMcpToken(reqWithBearer(), token);
    const grant = (info?.extra as { grant?: string[] }).grant ?? [];
    expect([...grant].sort()).toEqual(['project:browse', 'sprint:manage'].sort());
    expect(grant).not.toContain('read');
  });

  it('rejects an absent / malformed / unknown token (→ 401)', async () => {
    expect(await verifyMcpToken(reqWithBearer())).toBeUndefined();
    expect(await verifyMcpToken(reqWithBearer('not-a-motir-token'))).toBeUndefined();
    expect(await verifyMcpToken(reqWithBearer('motir_pat_deadbeef'))).toBeUndefined();
  });

  it('rejects a revoked token', async () => {
    const fx = await makeWorkItemFixture();
    const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'revoked',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.deleteToken(fx.ownerId, dto.id);
    expect(await verifyMcpToken(reqWithBearer(), token)).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    expect(await verifyMcpToken(reqWithBearer(), token)).toBeUndefined();
  });
});
