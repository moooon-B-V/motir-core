import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/me/route';
import { REQUEST_ID_HEADER } from '@/lib/api/v1/route';
import { createV1Caller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/me (Story 11.1 · Subtask 11.1.2 — MOTIR-1858). Real Postgres,
// real PATs. The wrapper's own branches are covered in `wrapper.test.ts`
// against a fixture route; this file asserts the ENDPOINT's contract — the
// identity payload, the granted scopes, and that no Prisma column leaks.

const URL = 'http://localhost:3000/api/v1/me';

function req(headers: Record<string, string> = {}) {
  return new Request(URL, { headers });
}

describe('GET /api/v1/me', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it("returns the token owner's identity, bound workspace and granted scopes", async () => {
    const caller = await createV1Caller({ scopes: ['read', 'work_items:write'] });

    const res = await GET(req(caller.headers));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      user: { id: caller.user.id, name: caller.user.name, email: caller.user.email },
      workspaceId: caller.workspace.id,
      scopes: ['read', 'work_items:write'],
    });
  });

  // The scopes are what a client uses to discover its own capabilities without
  // probing endpoints for 403s — so a NARROWER token must report the narrower
  // grant, not the default set.
  it('reports the token’s ACTUAL grant, not a default', async () => {
    const caller = await createV1Caller({ scopes: ['read'] });

    const body = (await (await GET(req(caller.headers))).json()) as { scopes: string[] };

    expect(body.scopes).toEqual(['read']);
  });

  it('scopes the answer to the TOKEN, not the user — two tokens, two workspaces', async () => {
    const first = await createV1Caller({ workspaceName: 'Alpha' });
    // The same user, a second workspace, a second token bound to it.
    const secondWorkspace = await createV1Caller({
      workspaceName: 'Beta',
    });
    const crossToken = await withTokenFor(secondWorkspace.user, secondWorkspace.workspace);

    const a = (await (await GET(req(first.headers))).json()) as { workspaceId: string };
    const b = (await (await GET(req(crossToken.headers))).json()) as { workspaceId: string };

    expect(a.workspaceId).toBe(first.workspace.id);
    expect(b.workspaceId).toBe(secondWorkspace.workspace.id);
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });

  it('leaks no Prisma column beyond id / name / email', async () => {
    const caller = await createV1Caller();

    const body = (await (await GET(req(caller.headers))).json()) as Record<string, unknown> & {
      user: Record<string, unknown>;
    };

    // Shaped by `presentMe` (MOTIR-2202), so a later migration adding a column
    // to `user` cannot silently make it public API. Asserted on the REAL
    // response the route returned, not on a fixture built from the schema.
    expect(Object.keys(body).sort()).toEqual(['scopes', 'user', 'workspaceId']);
    expect(Object.keys(body.user).sort()).toEqual(['email', 'id', 'name']);
  });

  it('carries the request id and refuses an unauthenticated caller', async () => {
    const ok = await GET(req((await createV1Caller()).headers));
    expect(ok.headers.get(REQUEST_ID_HEADER)).toBeTruthy();

    const anon = await GET(req());
    expect(anon.status).toBe(401);
    await expect(anon.json()).resolves.toEqual({
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });
  });

  it('refuses a token without the read scope with 403', async () => {
    const caller = await createV1Caller({ scopes: ['integration'] });

    const res = await GET(req(caller.headers));

    expect(res.status).toBe(403);
  });
});
