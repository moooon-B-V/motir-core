import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { hashToken, TOKEN_PREFIX, DISPLAY_PREFIX_LENGTH } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenNotFoundError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
  InvalidApiTokenLabelError,
  InvalidTokenGrantError,
} from '@/lib/apiTokens/errors';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { LEGACY_SCOPE_PERMISSIONS } from '@/lib/mcp/scopes';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { truncateAuthTables } from '../helpers/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { projectsService } from '@/lib/services/projectsService';

// Service-layer lifecycle tests for the PAT substrate (Story 7.8 · Subtask
// 7.8.1, + bug 7.21 workspace-scoping), real Postgres (no mocks — the repo
// testing contract). RLS is inert under the BYPASSRLS test role, so the `db`
// singleton reads rows directly for the "did it land / what's stored"
// assertions; the service binds its owner/system GUCs as it would in
// production. A token is now BOUND to a workspace at mint (bug 7.21), so each
// test mints a real workspace (with the owner's membership) via the fixture.
// The `api_token` rows are reached by `truncateAuthTables`'s `user`/`workspace`
// CASCADE.

/** A fresh user + a workspace they own (membership wired by the fixture). */
/** A user + workspace + ONE project — the fixture a CHOSEN grant needs, since
 *  it must name the project its permissions apply to (MOTIR-2606). */
async function projectWs() {
  const ws = await makeUserWs();
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: ws.owner.id,
    name: 'Motir',
    identifier: `P${Math.floor(Math.random() * 100000)}`,
  });
  return { ...ws, project };
}

async function makeUserWs(name?: string) {
  return createTestWorkspace(name ? { name } : {});
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('create', () => {
  it('returns the plaintext ONCE, persists only the hash + prefix, and binds the workspace', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    // Plaintext shape: the greppable prefix + a body.
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(TOKEN_PREFIX.length + 20);

    // The DTO never carries the secret or the hash; it labels the bound scope.
    expect(dto.label).toBe('claude-code');
    expect(dto.tokenPrefix).toBe(token.slice(0, DISPLAY_PREFIX_LENGTH));
    expect(dto.expiresAt).toBeNull();
    expect(dto.lastUsedAt).toBeNull();
    expect(dto.revokedAt).toBeNull();
    expect(dto.workspace.id).toBe(workspace.id);
    expect(dto.organization.id).toBe(workspace.organizationId);
    expect(JSON.stringify(dto)).not.toContain(token);

    // The row stores the HASH (never the plaintext) and the bound workspace.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenPrefix).toBe(token.slice(0, DISPLAY_PREFIX_LENGTH));
    expect(row.workspaceId).toBe(workspace.id);
  });

  it('rejects a workspace the user is NOT a member of (bug 7.21 — server is the authority)', async () => {
    const { owner } = await makeUserWs();
    // A workspace owned by someone else — `owner` has no membership in it.
    const { workspace: foreign } = await makeUserWs();
    await expect(
      apiTokensService.create(owner.id, foreign.id, {
        label: 'x',
        fixedGrant: DEFAULT_TOKEN_GRANT,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
    // Nothing was minted.
    expect(await db.apiToken.count()).toBe(0);
  });

  it('persists the provided expiry', async () => {
    const { owner, workspace } = await makeUserWs();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'ci',
      expiresAt,
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    expect(dto.expiresAt).toBe(expiresAt.toISOString());
  });

  it('mints distinct secrets across calls', async () => {
    const { owner, workspace } = await makeUserWs();
    const a = await apiTokensService.create(owner.id, workspace.id, {
      label: 'a',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const b = await apiTokensService.create(owner.id, workspace.id, {
      label: 'b',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    expect(a.token).not.toBe(b.token);
  });

  it('rejects a blank label', async () => {
    const { owner, workspace } = await makeUserWs();
    await expect(
      apiTokensService.create(owner.id, workspace.id, {
        label: '   ',
        fixedGrant: DEFAULT_TOKEN_GRANT,
      }),
    ).rejects.toBeInstanceOf(InvalidApiTokenLabelError);
  });

  it('rejects an over-length label', async () => {
    const { owner, workspace } = await makeUserWs();
    await expect(
      apiTokensService.create(owner.id, workspace.id, {
        label: 'x'.repeat(101),
        fixedGrant: DEFAULT_TOKEN_GRANT,
      }),
    ).rejects.toBeInstanceOf(InvalidApiTokenLabelError);
  });

  it('trims the label', async () => {
    const { owner, workspace } = await makeUserWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: '  claude-code  ',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    expect(dto.label).toBe('claude-code');
  });
});

describe('listForUser', () => {
  it('returns the user own tokens newest-first, no hash, scoped to the owner', async () => {
    const { owner: alice, workspace: aliceWs } = await makeUserWs();
    const { owner: bob, workspace: bobWs } = await makeUserWs();
    const first = await apiTokensService.create(alice.id, aliceWs.id, {
      label: 'first',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const second = await apiTokensService.create(alice.id, aliceWs.id, {
      label: 'second',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.create(bob.id, bobWs.id, {
      label: 'bob-token',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const list = await apiTokensService.listForUser(alice.id);
    expect(list.map((tk) => tk.label)).toEqual(['second', 'first']);
    expect(list.map((tk) => tk.id)).toEqual([second.dto.id, first.dto.id]);
    // No secret material crosses the boundary.
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('is account-level — returns tokens across ALL the user’s workspaces, each labelled with its bound workspace + org (bug 7.21)', async () => {
    const { owner, workspace: wsA } = await makeUserWs('Workspace A');
    const { workspace: wsB } = await createTestWorkspace({
      ownerUserId: owner.id,
      name: 'Workspace B',
    });
    const inA = await apiTokensService.create(owner.id, wsA.id, {
      label: 'in-a',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const inB = await apiTokensService.create(owner.id, wsB.id, {
      label: 'in-b',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const list = await apiTokensService.listForUser(owner.id);
    const byId = new Map(list.map((tk) => [tk.id, tk]));
    expect(byId.size).toBe(2);
    expect(byId.get(inA.dto.id)!.workspace.id).toBe(wsA.id);
    expect(byId.get(inB.dto.id)!.workspace.id).toBe(wsB.id);
  });

  it('returns an empty list for a user with no tokens', async () => {
    const { owner } = await makeUserWs();
    expect(await apiTokensService.listForUser(owner.id)).toEqual([]);
  });
});

describe('listScopeOptions', () => {
  it('returns each org the user belongs to with its workspaces (bug 7.21 — the create picker source)', async () => {
    const { owner, workspace: wsA } = await makeUserWs('Workspace A');
    const { workspace: wsB } = await createTestWorkspace({
      ownerUserId: owner.id,
      name: 'Workspace B',
    });

    const options = await apiTokensService.listScopeOptions(owner.id);
    // Both workspaces are reachable (createTestWorkspace nests a fresh org each).
    const allWorkspaceIds = options.flatMap((o) => o.workspaces.map((w) => w.id));
    expect(allWorkspaceIds).toContain(wsA.id);
    expect(allWorkspaceIds).toContain(wsB.id);
    // Every listed org has at least one workspace (empty orgs are omitted).
    expect(options.every((o) => o.workspaces.length > 0)).toBe(true);
  });
});

describe('revoke', () => {
  it('soft-revokes a token (row stays, revokedAt set), returning the scoped DTO', async () => {
    const { owner, workspace } = await makeUserWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const revoked = await apiTokensService.revoke(owner.id, dto.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.workspace.id).toBe(workspace.id);

    const row = await db.apiToken.findUnique({ where: { id: dto.id } });
    expect(row).not.toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });

  it('is idempotent — re-revoking keeps the original timestamp', async () => {
    const { owner, workspace } = await makeUserWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const first = await apiTokensService.revoke(owner.id, dto.id);
    const second = await apiTokensService.revoke(owner.id, dto.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('treats another user token as not-found (404-not-403, no leak)', async () => {
    const { owner: alice } = await makeUserWs();
    const { owner: bob, workspace: bobWs } = await makeUserWs();
    const { dto } = await apiTokensService.create(bob.id, bobWs.id, {
      label: 'bob-token',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await expect(apiTokensService.revoke(alice.id, dto.id)).rejects.toBeInstanceOf(
      ApiTokenNotFoundError,
    );
    // Bob's token is untouched.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('throws not-found for a missing id', async () => {
    const { owner } = await makeUserWs();
    await expect(apiTokensService.revoke(owner.id, 'nope')).rejects.toBeInstanceOf(
      ApiTokenNotFoundError,
    );
  });
});

describe('verify', () => {
  it('accepts a live token and returns the owning user + the bound workspace (bug 7.21)', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const resolved = await apiTokensService.verify(token);
    expect(resolved.user.id).toBe(owner.id);
    expect(resolved.user.email).toBe(owner.email);
    // The request workspace is the TOKEN's workspace, not the owner's default.
    expect(resolved.workspaceId).toBe(workspace.id);
  });

  it('resolves the workspace the token was minted in, even when it is not the owner’s first workspace (bug 7.21)', async () => {
    // The owner's FIRST (oldest) workspace is wsA; the token is minted in wsB.
    // The retired behaviour resolved wsA for every token; the fix resolves wsB.
    const { owner, workspace: wsA } = await makeUserWs('First');
    const { workspace: wsB } = await createTestWorkspace({ ownerUserId: owner.id, name: 'Second' });
    const { token } = await apiTokensService.create(owner.id, wsB.id, {
      label: 'second-ws',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const resolved = await apiTokensService.verify(token);
    expect(resolved.workspaceId).toBe(wsB.id);
    expect(resolved.workspaceId).not.toBe(wsA.id);
  });

  it('rejects an unknown token', async () => {
    await makeUserWs();
    await expect(apiTokensService.verify('motir_pat_doesnotexist')).rejects.toBeInstanceOf(
      InvalidApiTokenError,
    );
  });

  it('rejects a revoked token', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.revoke(owner.id, dto.id);
    await expect(apiTokensService.verify(token)).rejects.toBeInstanceOf(ApiTokenRevokedError);
  });

  it('rejects an expired token (boundary: expiry <= now is expired)', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await expect(apiTokensService.verify(token)).rejects.toBeInstanceOf(ApiTokenExpiredError);
  });

  it('accepts a token expiring in the future', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'future',
      expiresAt: new Date(Date.now() + 60_000),
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const resolved = await apiTokensService.verify(token);
    expect(resolved.user.id).toBe(owner.id);
  });

  it('touches lastUsedAt on first use, then throttles within the 5-minute window', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    await apiTokensService.verify(token);
    const afterFirst = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(afterFirst.lastUsedAt).not.toBeNull();

    // A second verify inside the window must NOT re-write lastUsedAt.
    await apiTokensService.verify(token);
    const afterSecond = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(afterSecond.lastUsedAt!.getTime()).toBe(afterFirst.lastUsedAt!.getTime());
  });

  it('re-touches lastUsedAt once the throttle window has passed', async () => {
    const { owner, workspace } = await makeUserWs();
    const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.verify(token);

    // Simulate the previous use being > 5 minutes ago.
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    await db.apiToken.update({ where: { id: dto.id }, data: { lastUsedAt: stale } });

    await apiTokensService.verify(token);
    const after = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(after.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe('the GRANT — persist and read (MOTIR-2575)', () => {
  it('the FIXED device grant persists verbatim', async () => {
    const { owner, workspace } = await makeUserWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'default',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect([...row.scopes].sort()).toEqual([...DEFAULT_TOKEN_GRANT].sort());
    expect(row.scopes).not.toContain('work_item:delete');
  });

  it('persists an explicit grant verbatim (de-duplicated)', async () => {
    const { owner, workspace, project } = await projectWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'narrow',
      permissions: ['project:browse', 'work_item:edit', 'project:browse'],
      projectId: project.id,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect([...row.scopes].sort()).toEqual(['project:browse', 'work_item:edit']);
  });

  it('can grant the irreversible key when explicitly requested', async () => {
    const { owner, workspace, project } = await projectWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'with-delete',
      permissions: ['project:browse', 'work_item:delete'],
      projectId: project.id,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.scopes).toContain('work_item:delete');
  });

  it('accepts an empty explicit grant (a token that can do nothing)', async () => {
    const { owner, workspace, project } = await projectWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'empty',
      permissions: [],
      projectId: project.id,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.scopes).toEqual([]);
  });

  it('REFUSES an unknown permission and mints nothing', async () => {
    const { owner, workspace, project } = await projectWs();
    await expect(
      apiTokensService.create(owner.id, workspace.id, {
        label: 'bad',
        permissions: ['project:browse', 'work_item:nuke'],
        projectId: project.id,
      }),
    ).rejects.toBeInstanceOf(InvalidTokenGrantError);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('REFUSES a real catalog key that is not GRANTABLE, and mints nothing', async () => {
    // The case a plain `isPermissionKey` check would wave through: a genuine
    // permission that no token-reachable operation asserts. Granting it would
    // put a switch on a token that gates nothing.
    const { owner, workspace, project } = await projectWs();
    await expect(
      apiTokensService.create(owner.id, workspace.id, {
        label: 'ungrantable',
        permissions: ['project:browse', 'board:configure'],
        projectId: project.id,
      }),
    ).rejects.toBeInstanceOf(InvalidTokenGrantError);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('names the offending keys on the typed error, so a 422 can say which', async () => {
    const { owner, workspace, project } = await projectWs();
    await expect(
      apiTokensService.create(owner.id, workspace.id, {
        label: 'bad',
        permissions: ['work_item:nuke', 'board:configure'],
        projectId: project.id,
      }),
    ).rejects.toMatchObject({
      code: 'API_TOKEN_INVALID_PERMISSION',
      invalidPermissions: ['work_item:nuke', 'board:configure'],
    });
  });

  it('verify returns the resolved grant alongside the user + workspace', async () => {
    const { owner, workspace, project } = await projectWs();
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'verify-grant',
      permissions: ['project:browse', 'sprint:manage'],
      projectId: project.id,
    });
    const resolved = await apiTokensService.verify(token);
    expect([...resolved.grant].sort()).toEqual(['project:browse', 'sprint:manage']);
    expect(resolved.user.id).toBe(owner.id);
    expect(resolved.workspaceId).toBe(workspace.id);
  });

  it('the DTO exposes the resolved grant', async () => {
    const { owner, workspace, project } = await projectWs();
    const { dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'dto',
      permissions: ['project:browse'],
      projectId: project.id,
    });
    expect(dto.permissions).toEqual(['project:browse']);
  });
});

describe('the compatibility promise — a row written BEFORE MOTIR-2572', () => {
  // The seam most worth a real database behind it. Every token already minted
  // holds legacy strings, nothing rewrites them, and the promise is that they
  // keep exactly the authority they had. These seed the OLD values directly —
  // the only way to test a row `create` can no longer produce.

  async function seedLegacyRow(scopes: string[]) {
    const { owner, workspace } = await makeUserWs();
    const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'legacy',
      fixedGrant: ['project:browse'],
    });
    await db.apiToken.update({ where: { id: dto.id }, data: { scopes } });
    return { token, id: dto.id, owner, workspace };
  }

  it("['read','work_items:write'] reads back as exactly what those two conferred", async () => {
    const { token } = await seedLegacyRow(['read', 'work_items:write']);
    const resolved = await apiTokensService.verify(token);
    // Asserted against the shipped forward map, key by key — not against a
    // list retyped here, which would pass even if the map were wrong.
    const expected = [
      ...new Set([
        ...LEGACY_SCOPE_PERMISSIONS.read,
        ...LEGACY_SCOPE_PERMISSIONS['work_items:write'],
      ]),
    ];
    expect([...resolved.grant].sort()).toEqual([...expected].sort());
  });

  it('all six legacy strings read back as the whole grantable set', async () => {
    const { token } = await seedLegacyRow([
      'read',
      'work_items:write',
      'work_items:archive',
      'work_items:delete',
      'sprints:write',
      'integration',
    ]);
    const resolved = await apiTokensService.verify(token);
    expect(resolved.grant.length).toBeGreaterThan(0);
    for (const key of resolved.grant) expect(typeof key).toBe('string');
    expect(resolved.grant).toContain('work_item:delete');
    expect(resolved.grant).toContain('ai:plan');
  });

  it('an unrecognised stored value yields NO authority and does not throw', async () => {
    // The asymmetry that matters: a malformed row must degrade to LESS access.
    const { token } = await seedLegacyRow(['read', 'work_items:nuke', 'utter-nonsense']);
    const resolved = await apiTokensService.verify(token);
    expect(resolved.grant).toEqual(['project:browse']);
  });

  it('a row that is ENTIRELY unrecognised verifies to an empty grant', async () => {
    const { token } = await seedLegacyRow(['nonsense']);
    const resolved = await apiTokensService.verify(token);
    expect(resolved.grant).toEqual([]);
  });

  it('the DTO never exposes a legacy string as a permission', async () => {
    const { owner } = await seedLegacyRow(['read', 'work_items:write']);
    const [listed] = await apiTokensService.listForUser(owner.id);
    for (const key of listed!.permissions) {
      expect(key).not.toBe('read');
      expect(key).not.toBe('work_items:write');
    }
    expect(listed!.permissions).toContain('project:browse');
  });

  it('a MIXED row — one legacy string, one permission key — resolves both', async () => {
    // Exactly what a real account looks like mid-life: old tokens and new ones
    // side by side, and nothing migrating between them.
    const { token } = await seedLegacyRow(['sprints:write', 'project:browse']);
    const resolved = await apiTokensService.verify(token);
    expect([...resolved.grant].sort()).toEqual(['project:browse', 'sprint:manage'].sort());
  });
});

describe('repository guards', () => {
  it('findByTokenHash returns null for an unknown hash', async () => {
    const result = await db.$transaction((tx) =>
      apiTokenRepository.findByTokenHash(hashToken('nope'), tx),
    );
    expect(result).toBeNull();
  });
});

describe('the PROJECT binding and what a caller may confer (MOTIR-2606)', () => {
  // The rule: the binding is REQUIRED where the GRANT IS CHOSEN, and absent
  // where it is fixed (`docs/decisions/token-permissions.md` Amendment 1 §A.5).
  // Before this card `create` validated a chosen grant against the STATIC
  // grantable set, so a project VIEWER could mint `work_item:delete` and hold a
  // grant they cannot exercise anywhere — a token whose stated authority is a
  // fiction. These are the four combinations, two of which are bugs.

  async function projectFixture() {
    return makeWorkItemFixture();
  }

  /** A real project VIEWER in the fixture's project — the actor whose offer this
   *  card caps. Built through the shipped services so the role resolves exactly
   *  as it does in production, rather than by writing a membership row. */
  async function addProjectViewer(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>) {
    const u = await usersService.createUser({
      email: `viewer-${fx.projectIdentifier}-${Date.now()}@example.com`,
      password: 'correct-horse-battery-staple',
      name: 'Viewer',
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: { userId: fx.ownerId, workspaceId: fx.workspaceId },
      targetUserId: u.id,
      role: 'viewer',
    });
    return { userId: u.id };
  }

  it('CHOSEN + project — the legal shape — persists the grant and the binding', async () => {
    const fx = await projectFixture();
    const { dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'bound',
      permissions: ['project:browse', 'work_item:edit'],
      projectId: fx.projectId,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.projectId).toBe(fx.projectId);
    expect([...row.scopes].sort()).toEqual(['project:browse', 'work_item:edit']);
    expect(dto.project?.id).toBe(fx.projectId);
  });

  it('FIXED + no project — the device shape — persists a NULL binding', async () => {
    const fx = await projectFixture();
    const { dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'device',
      fixedGrant: CLI_TOKEN_GRANT,
    });
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.projectId).toBeNull();
    expect([...row.scopes].sort()).toEqual([...CLI_TOKEN_GRANT].sort());
    expect(dto.project).toBeNull();
  });

  it('CHOSEN without a project is REFUSED — the question has no answer', async () => {
    const fx = await projectFixture();
    await expect(
      apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'unbound',
        permissions: ['work_item:edit'],
      }),
    ).rejects.toMatchObject({ code: 'API_TOKEN_INVALID_BINDING' });
    expect(await db.apiToken.count()).toBe(0);
  });

  it('FIXED with a project is REFUSED — the device flow must not acquire a binding', async () => {
    const fx = await projectFixture();
    await expect(
      apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'over-bound',
        fixedGrant: CLI_TOKEN_GRANT,
        projectId: fx.projectId,
      }),
    ).rejects.toMatchObject({ code: 'API_TOKEN_INVALID_BINDING' });
    expect(await db.apiToken.count()).toBe(0);
  });

  it('omitting permissions WITH a project means "the default for this project"', async () => {
    // The modal's convenience, resolved against the OFFER rather than against
    // the static default — so it can never exceed what the caller could confer.
    const fx = await projectFixture();
    const { dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'project-default',
      projectId: fx.projectId,
    });
    expect(dto.permissions).not.toContain('work_item:delete');
    expect(dto.permissions).toContain('project:browse');
    expect(dto.project?.id).toBe(fx.projectId);
  });

  it('…and for a VIEWER that default is their own, smaller offer', async () => {
    const fx = await projectFixture();
    const viewer = await addProjectViewer(fx);
    const { dto } = await apiTokensService.create(viewer.userId, fx.workspaceId, {
      label: 'viewer-default',
      projectId: fx.projectId,
    });
    expect(dto.permissions).toContain('project:browse');
    expect(dto.permissions).not.toContain('work_item:edit');
  });

  it('neither is REFUSED — a token without a grant is not a thing', async () => {
    const fx = await projectFixture();
    await expect(
      apiTokensService.create(fx.ownerId, fx.workspaceId, { label: 'grantless' }),
    ).rejects.toMatchObject({ code: 'API_TOKEN_INVALID_BINDING' });
  });

  it('a project OWNER may confer the whole grantable set — the layer-2 rail', async () => {
    // `resolvePermissions` layer 2 hands a workspace owner/admin the entire
    // role-gated catalog in every project. Asserted so the rail's effect is
    // VISIBLE: it is why this card changes nothing for most people who mint
    // tokens, and everything for members and viewers.
    const fx = await projectFixture();
    const conferrable = await apiTokensService.listGrantablePermissions(
      fx.ownerId,
      fx.workspaceId,
      fx.projectId,
    );
    expect([...conferrable].sort()).toEqual([...GRANTABLE_PERMISSIONS].sort());
  });

  it('a token that grants MORE than the caller holds is refused, naming the keys', async () => {
    // The defect this card closes. The actor is a VIEWER in the project, so
    // `work_item:delete` is not theirs to give — and before MOTIR-2606 the
    // static check waved it through.
    const fx = await projectFixture();
    const viewer = await addProjectViewer(fx);
    await expect(
      apiTokensService.create(viewer.userId, fx.workspaceId, {
        label: 'over-grant',
        permissions: ['project:browse', 'work_item:delete'],
        projectId: fx.projectId,
      }),
    ).rejects.toMatchObject({
      code: 'API_TOKEN_INVALID_PERMISSION',
      invalidPermissions: ['work_item:delete'],
    });
    expect(await db.apiToken.count()).toBe(0);
  });

  it('…and the same viewer CAN grant what they do hold', async () => {
    const fx = await projectFixture();
    const viewer = await addProjectViewer(fx);
    const conferrable = await apiTokensService.listGrantablePermissions(
      viewer.userId,
      fx.workspaceId,
      fx.projectId,
    );
    expect(conferrable).toContain('project:browse');
    expect(conferrable).not.toContain('work_item:delete');

    const { dto } = await apiTokensService.create(viewer.userId, fx.workspaceId, {
      label: 'viewer-token',
      permissions: ['project:browse'],
      projectId: fx.projectId,
    });
    expect(dto.permissions).toEqual(['project:browse']);
  });

  it('a project the caller cannot browse is NOT-FOUND — never a 403 that confirms it', async () => {
    // The 404-not-403 contract. `getPermissions` throws and the error is allowed
    // to propagate rather than being swallowed into an empty set: "not found" and
    // "you may confer nothing" are different sentences, and the second one
    // confirms the request was well-formed.
    const mine = await projectFixture();
    const theirs = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    await expect(
      apiTokensService.listGrantablePermissions(mine.ownerId, mine.workspaceId, theirs.projectId),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('…and binding a token to that project is a 404 too, not a partial mint', async () => {
    const mine = await projectFixture();
    const theirs = await makeWorkItemFixture({ name: 'Rival2', identifier: 'YYY' });
    await expect(
      apiTokensService.create(mine.ownerId, mine.workspaceId, {
        label: 'cross-tenant',
        permissions: ['project:browse'],
        projectId: theirs.projectId,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(await db.apiToken.count()).toBe(0);
  });
});
