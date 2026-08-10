import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { truncateAuthTables } from '../helpers/db';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { projectsService } from '@/lib/services/projectsService';

// Transport tests for the API-tokens settings routes (Story 7.8 · Subtask
// 7.8.3, + bug 7.21 scope): GET/POST `/api/me/api-tokens` + DELETE
// `/api/me/api-tokens/[tokenId]`. Real Postgres (no mocks — the repo testing
// contract); only `getSession` is stubbed (the cookie the test env can't supply
// — the sanctioned exception). The routes are SESSION-only (the mint surface
// must never be PAT-reachable); the GET lists the user's tokens account-level
// and the POST binds the new token to a CHOSEN `workspaceId` (the user must be a
// member — else 403). RLS is inert under the BYPASSRLS test role, so the `db`
// singleton reads rows directly for the "what landed" assertions.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

// Import the handlers AFTER the mock is registered.
const { GET, POST } = await import('@/app/api/me/api-tokens/route');
const { DELETE } = await import('@/app/api/me/api-tokens/[tokenId]/route');

const BASE = 'http://localhost:3000/api/me/api-tokens';

/** A fresh user + a workspace they own (membership wired by the fixture). */
/**
 * A user + workspace + ONE project.
 *
 * The project is not scenery: since MOTIR-2606 a hand-minted token must name the
 * project its chosen grant applies to, so a workspace with no projects cannot
 * mint one at all — which is correct (a grant of project permissions where there
 * are no projects grants nothing) and is why this fixture now creates one.
 */
async function makeUserWs(name?: string) {
  const ws = await createTestWorkspace(name ? { name } : {});
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: ws.owner.id,
    name: 'Motir',
    identifier: `P${Math.floor(Math.random() * 100000)}`,
  });
  return { ...ws, project };
}
function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}
function postReq(body: unknown) {
  return new Request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function deleteReq(tokenId: string) {
  return {
    req: new Request(`${BASE}/${tokenId}`, { method: 'DELETE' }),
    ctx: { params: Promise.resolve({ tokenId }) },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/me/api-tokens', () => {
  it('401 when signed out', async () => {
    expect((await GET()).status).toBe(401);
  });

  it("lists ONLY the session user's tokens, newest first, never the hash", async () => {
    const { owner: alice, workspace: aliceWs } = await makeUserWs();
    const { owner: bob, workspace: bobWs } = await makeUserWs();
    await apiTokensService.create(alice.id, aliceWs.id, {
      label: 'a1',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.create(alice.id, aliceWs.id, {
      label: 'a2',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.create(bob.id, bobWs.id, {
      label: 'b1',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    signInAs(alice);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ label: string }> };
    expect(body.tokens.map((t) => t.label)).toEqual(['a2', 'a1']);
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });
});

describe('POST /api/me/api-tokens', () => {
  it('401 when signed out', async () => {
    expect((await POST(postReq({ label: 'x', workspaceId: 'w' }))).status).toBe(401);
  });

  it('creates a token bound to the chosen workspace, returns the plaintext ONCE + the row, persists only a hash', async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);

    const res = await POST(
      postReq({
        label: 'claude-code',
        expiresInDays: 90,
        workspaceId: workspace.id,
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      dto: { id: string; label: string; expiresAt: string | null; workspace: { id: string } };
    };
    expect(body.token.startsWith('motir_pat_')).toBe(true);
    expect(body.dto.label).toBe('claude-code');
    expect(body.dto.expiresAt).not.toBeNull();
    expect(body.dto.workspace.id).toBe(workspace.id);

    const row = await db.apiToken.findUniqueOrThrow({ where: { id: body.dto.id } });
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.workspaceId).toBe(workspace.id);
    expect(await apiTokensService.listForUser(alice.id)).toHaveLength(1);
  });

  it('null expiresInDays mints a never-expiring token', async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);
    const res = await POST(
      postReq({
        label: 'forever',
        expiresInDays: null,
        workspaceId: workspace.id,
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { dto: { expiresAt: string | null } }).dto.expiresAt).toBeNull();
  });

  it('403 binding a token to a workspace the user is not a member of', async () => {
    const { owner: alice } = await makeUserWs();
    // Someone else's workspace AND its project — so the refusal is the
    // MEMBERSHIP check's, reached before any project resolution.
    const { workspace: foreign, project: foreignProject } = await makeUserWs();
    signInAs(alice);
    const res = await POST(
      postReq({ label: 'x', workspaceId: foreign.id, projectId: foreignProject.id }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('WORKSPACE_FORBIDDEN');
    expect(await db.apiToken.count()).toBe(0);
  });

  it('400 on a missing workspaceId', async () => {
    const { owner: alice } = await makeUserWs();
    signInAs(alice);
    expect((await POST(postReq({ label: 'x', expiresInDays: 90 }))).status).toBe(400);
  });

  it('422 (typed) on a blank label', async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);
    const res = await POST(
      postReq({ label: '   ', workspaceId: workspace.id, projectId: project.id }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_TOKEN_INVALID_LABEL');
  });

  it('400 on a non-allowed expiry horizon', async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);
    expect(
      (
        await POST(
          postReq({
            label: 'x',
            expiresInDays: 7,
            workspaceId: workspace.id,
            projectId: project.id,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('400 on a missing label', async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);
    expect(
      (await POST(postReq({ expiresInDays: 90, workspaceId: workspace.id, projectId: project.id })))
        .status,
    ).toBe(400);
  });
});

describe('POST /api/me/api-tokens — the GRANT contract (MOTIR-2575)', () => {
  it('omitting `permissions` mints the default grant', async () => {
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({ label: 'default', workspaceId: workspace.id, projectId: project.id }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dto: { permissions: string[] } };
    expect([...body.dto.permissions].sort()).toEqual([...DEFAULT_TOKEN_GRANT].sort());
  });

  it('an explicit grant round-trips through the response DTO', async () => {
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({
        label: 'narrow',
        workspaceId: workspace.id,
        permissions: ['project:browse'],
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dto: { permissions: string[] } };
    expect(body.dto.permissions).toEqual(['project:browse']);
  });

  it('a permission that is not GRANTABLE is 422, and nothing is minted', async () => {
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({
        label: 'bad',
        workspaceId: workspace.id,
        permissions: ['project:browse', 'board:configure'],
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('API_TOKEN_INVALID_PERMISSION');
    expect(await db.apiToken.count()).toBe(0);
  });

  it('an unknown permission string is 422, and nothing is minted', async () => {
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({ label: 'bad', workspaceId: workspace.id, permissions: ['work_item:nuke'] }),
    );
    expect(res.status).toBe(422);
    expect(await db.apiToken.count()).toBe(0);
  });

  it('a non-array `permissions` is a 400 SHAPE error, not a 422', async () => {
    // The route owns the shape; the service owns which strings are acceptable.
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({ label: 'bad', workspaceId: workspace.id, permissions: 'project:browse' }),
    );
    expect(res.status).toBe(400);
  });

  it('a LEGACY scope string posted to the new field is refused, not silently accepted', async () => {
    // The field rename is a contract change. A client still posting the six-scope
    // vocabulary must get a loud 422 rather than a token whose grant is not what
    // it asked for.
    const { owner, workspace, project } = await makeUserWs();
    signInAs(owner);
    const res = await POST(
      postReq({ label: 'legacy', workspaceId: workspace.id, permissions: ['work_items:write'] }),
    );
    expect(res.status).toBe(422);
    expect(await db.apiToken.count()).toBe(0);
  });
});

describe('DELETE /api/me/api-tokens/[tokenId]', () => {
  it('401 when signed out', async () => {
    const { req, ctx } = deleteReq('whatever');
    expect((await DELETE(req, ctx)).status).toBe(401);
  });

  it("soft-revokes the user's own token and returns the revoked DTO", async () => {
    const { owner: alice, workspace, project } = await makeUserWs();
    signInAs(alice);
    const { dto } = await apiTokensService.create(alice.id, workspace.id, {
      label: 'to-revoke',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    const { req, ctx } = deleteReq(dto.id);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { token: { revokedAt: string | null } }).token.revokedAt,
    ).not.toBeNull();

    // Soft revoke — the row stays for the audit trail.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("404 (not 403) revoking another user's token — no existence leak", async () => {
    const { owner: alice } = await makeUserWs();
    const { owner: bob, workspace: bobWs } = await makeUserWs();
    const { dto } = await apiTokensService.create(bob.id, bobWs.id, {
      label: 'bobs',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    signInAs(alice);
    const { req, ctx } = deleteReq(dto.id);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('API_TOKEN_NOT_FOUND');

    // Bob's token is untouched.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.revokedAt).toBeNull();
  });
});
