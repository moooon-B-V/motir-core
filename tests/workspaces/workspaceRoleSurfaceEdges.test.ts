import { afterEach, describe, expect, it, vi } from 'vitest';

// The edges of the workspace-role HTTP surface and its catalog mapper (Story
// MOTIR-6168 · MOTIR-6467 — the story gate's coverage top-up), without a
// database: the happy paths and every mapped refusal are driven against real
// Postgres by `workspaceRoleRoutes.test.ts`, `memberRoleRoute.test.ts` and the
// story gate. What is left is what those cannot reach honestly:
//
//   * an error the route does NOT map is RETHROWN — never swallowed into a
//     200, never guessed into a 4xx — so Next's error boundary answers 500;
//   * the catalog counts a role nobody holds as ZERO, and orders custom roles
//     by name whatever order the repository returned them in.

const session = vi.hoisted(() => ({
  ctx: { userId: 'u1', workspaceId: 'ws1' } as { userId: string; workspaceId: string } | null,
  hold: null as Response | null,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => session.ctx };
});
vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>();
  return { ...actual, refuseIfNonCompliant: async () => session.hold };
});

const { workspaceRoleDefinitionService } =
  await import('@/lib/services/workspaceRoleDefinitionService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const rolesRoute = await import('@/app/api/workspaces/[workspaceId]/roles/route');
const roleRoute = await import('@/app/api/workspaces/[workspaceId]/roles/[roleId]/route');
const memberRoute = await import('@/app/api/workspaces/[workspaceId]/members/[userId]/route');
const { toWorkspaceRoleCatalogDTO } = await import('@/lib/mappers/workspaceRoleMappers');

afterEach(() => {
  vi.restoreAllMocks();
  session.ctx = { userId: 'u1', workspaceId: 'ws1' };
  session.hold = null;
});

const boom = new Error('an error no route maps');
const body = (b: unknown, method: string) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});
const ws = { params: Promise.resolve({ workspaceId: 'ws1' }) };
const role = { params: Promise.resolve({ workspaceId: 'ws1', roleId: 'r1' }) };
const member = { params: Promise.resolve({ workspaceId: 'ws1', userId: 'u2' }) };

describe('an unmapped error is RETHROWN by every workspace-role route', () => {
  it('GET /roles', async () => {
    vi.spyOn(workspaceRoleDefinitionService, 'listForWorkspace').mockRejectedValue(boom);
    await expect(rolesRoute.GET(new Request('http://x/r'), ws)).rejects.toBe(boom);
  });

  it('POST /roles', async () => {
    vi.spyOn(workspaceRoleDefinitionService, 'create').mockRejectedValue(boom);
    await expect(
      rolesRoute.POST(
        new Request('http://x/r', body({ name: 'R', basedOn: 'viewer' }, 'POST')),
        ws,
      ),
    ).rejects.toBe(boom);
  });

  it('PATCH /roles/{roleId}', async () => {
    vi.spyOn(workspaceRoleDefinitionService, 'update').mockRejectedValue(boom);
    await expect(
      roleRoute.PATCH(new Request('http://x/r', body({ name: 'R2' }, 'PATCH')), role),
    ).rejects.toBe(boom);
  });

  it('DELETE /roles/{roleId}', async () => {
    vi.spyOn(workspaceRoleDefinitionService, 'delete').mockRejectedValue(boom);
    await expect(
      roleRoute.DELETE(new Request('http://x/r?reassignToRole=viewer', { method: 'DELETE' }), role),
    ).rejects.toBe(boom);
  });

  it('PATCH /members/{userId}', async () => {
    vi.spyOn(workspacesService, 'setMemberRole').mockRejectedValue(boom);
    await expect(
      memberRoute.PATCH(new Request('http://x/m', body({ role: 'viewer' }, 'PATCH')), member),
    ).rejects.toBe(boom);
  });
});

/** Every handler of the surface, called with a well-formed request. */
const CALLS: [string, () => Promise<Response>][] = [
  ['GET /roles', () => rolesRoute.GET(new Request('http://x/r'), ws)],
  [
    'POST /roles',
    () =>
      rolesRoute.POST(
        new Request('http://x/r', body({ name: 'R', basedOn: 'viewer' }, 'POST')),
        ws,
      ),
  ],
  [
    'PATCH /roles/{roleId}',
    () => roleRoute.PATCH(new Request('http://x/r', body({ name: 'R2' }, 'PATCH')), role),
  ],
  [
    'DELETE /roles/{roleId}',
    () =>
      roleRoute.DELETE(new Request('http://x/r?reassignToRole=viewer', { method: 'DELETE' }), role),
  ],
  [
    'PATCH /members/{userId}',
    () => memberRoute.PATCH(new Request('http://x/m', body({ role: 'viewer' }, 'PATCH')), member),
  ],
];

describe('the session doors', () => {
  it.each(CALLS)('%s — no session is a 401 and reaches no service', async (_name, call) => {
    session.ctx = null;
    const spies = [
      vi.spyOn(workspaceRoleDefinitionService, 'listForWorkspace'),
      vi.spyOn(workspaceRoleDefinitionService, 'create'),
      vi.spyOn(workspaceRoleDefinitionService, 'update'),
      vi.spyOn(workspaceRoleDefinitionService, 'delete'),
      vi.spyOn(workspacesService, 'setMemberRole'),
    ];
    expect((await call()).status).toBe(401);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it.each(CALLS.filter(([name]) => name !== 'GET /roles'))(
    '%s — a WRITE by someone held for two-factor answers the hold, and writes nothing',
    async (_name, call) => {
      session.hold = new Response(JSON.stringify({ code: 'TWO_FACTOR_REQUIRED' }), { status: 403 });
      const spies = [
        vi.spyOn(workspaceRoleDefinitionService, 'create'),
        vi.spyOn(workspaceRoleDefinitionService, 'update'),
        vi.spyOn(workspaceRoleDefinitionService, 'delete'),
        vi.spyOn(workspacesService, 'setMemberRole'),
      ];
      const res = await call();
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ code: 'TWO_FACTOR_REQUIRED' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );
});

describe('PATCH /roles/{roleId} sends only the fields it was given', () => {
  it('a permissions-only edit carries no name, and a name-only edit no permissions', async () => {
    const update = vi
      .spyOn(workspaceRoleDefinitionService, 'update')
      .mockResolvedValue({ id: 'r1', name: 'R', builtIn: false, permissions: [], holderCount: 0 });
    await roleRoute.PATCH(
      new Request('http://x/r', body({ permissions: ['project:browse'] }, 'PATCH')),
      role,
    );
    await roleRoute.PATCH(new Request('http://x/r', body({ name: 'R3' }, 'PATCH')), role);
    expect(update.mock.calls.map(([input]) => input)).toEqual([
      { workspaceId: 'ws1', roleId: 'r1', permissions: ['project:browse'] },
      { workspaceId: 'ws1', roleId: 'r1', name: 'R3' },
    ]);
  });
});

describe('the workspace role catalog mapper', () => {
  it('a role nobody holds counts ZERO, built-in or custom; custom roles sort by name', () => {
    const catalog = toWorkspaceRoleCatalogDTO(
      'ws1',
      { member: 3 },
      [
        { id: 'z', name: 'Zeta', permissions: ['project:browse'] },
        { id: 'a', name: 'Alpha', permissions: ['project:browse', 'retired:key'] },
      ],
      new Map([['z', 2]]),
    );
    const counts = Object.fromEntries(
      catalog.roles.map((r) => ['key' in r ? r.key : r.name, r.holderCount]),
    );
    expect(counts).toEqual({ manager: 0, member: 3, viewer: 0, Alpha: 0, Zeta: 2 });
    expect(catalog.roles.slice(3).map((r) => ('name' in r ? r.name : ''))).toEqual([
      'Alpha',
      'Zeta',
    ]);
    // A key the catalog no longer offers is neither shown nor counted.
    expect(catalog.roles[3]!.permissions).toEqual(['project:browse']);
  });
});
