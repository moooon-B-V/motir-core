import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// MOTIR-5320 — a project looked up BY KEY answers a non-browser exactly as it
// answers a key that does not exist.
//
// `projectsService.getByKey` / `resolveByKey` documented that contract and did
// not keep it: the browse gate inside them raises `ProjectAccessDeniedError`,
// which extends `Error`, not `ProjectNotFoundError`. Every route that maps only
// the documented class let it escape as a 500; every route whose shared mapper
// DID know the class answered 403. Both tell a workspace member who is not on a
// private project that the key is real — the 500 by accident, the 403 by name.
//
// Two halves, and neither is enough alone:
//   1. THE OWNER — the lookup itself refuses with the not-found error, for a live
//      key and for a retired alias, with the SAME message a missing key gets.
//   2. THE ROUTES — every `/api/projects/[key]/*` route that resolves through it
//      answers the non-browser with the same status AND body it gives a key that
//      was never created. That is the observable no-existence-leak property, so
//      it is asserted as a comparison rather than as a bare `404`.
// `tests/permissions/storyGate.test.ts` guard 4 is the structural third: a route
// added later that resolves by key must map the not-found error at all.
//
// The session is the one thing stubbed — a route test has no cookie jar, so the
// compliance gate hands back the actor. Everything after it is the shipped path.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const PASSWORD = 'key-lookup-browse-denial-123';
const NEVER_CREATED = 'NOPE';

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectKey: string;
  owner: WorkspaceContext;
  member: WorkspaceContext;
  /** In the workspace, no role on the PRIVATE project — cannot browse it. */
  outsider: WorkspaceContext;
}

/**
 * A PRIVATE project, so the non-browser is a real one. The access level is set
 * before anyone else joins (going private seeds only the then-current members),
 * then a project member and a role-less workspace member are added — the order
 * `approval-gate-settings-access.test.ts` uses.
 */
async function seed(slug: string): Promise<Seeded> {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const ownerUser = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: ownerUser.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ownerUser.id,
    name: `Project ${slug}`,
    identifier: 'PRIV',
  });
  const owner = ctxFor(ownerUser.id, workspace.id);
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: ownerUser.id,
    ctx: owner,
    level: 'private',
  });

  const memberUser = await user(`member-${slug}@ex.com`, 'Member');
  await workspacesService.addMember({ userId: memberUser.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: ownerUser.id,
    ctx: owner,
    targetUserId: memberUser.id,
    role: 'member',
  });

  const outsiderUser = await user(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: outsiderUser.id, workspaceId: workspace.id });

  return {
    projectKey: project.identifier,
    owner,
    member: ctxFor(memberUser.id, workspace.id),
    outsider: ctxFor(outsiderUser.id, workspace.id),
  };
}

/** The rejection a call produces, so two can be compared field by field. */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the lookup to refuse, and it resolved');
}

describe('the OWNER — a non-browser gets the not-found error a missing key gets', () => {
  it('getByKey on a LIVE key: ProjectNotFoundError, same message shape as a never-created key', async () => {
    const s = await seed('owner-live');

    const denied = await rejectionOf(projectsService.getByKey(s.projectKey, s.outsider));
    const missing = await rejectionOf(projectsService.getByKey(NEVER_CREATED, s.outsider));

    expect(denied).toBeInstanceOf(ProjectNotFoundError);
    expect(denied).not.toBeInstanceOf(ProjectAccessDeniedError);
    // The message echoes the key the caller TYPED and nothing else — no project id.
    expect(denied.message).toBe(missing.message.replace(NEVER_CREATED, s.projectKey));
  });

  it('resolveByKey on a RETIRED alias: the same refusal, echoing the alias', async () => {
    const s = await seed('owner-alias');
    await projectsService.changeKey({ key: s.projectKey, newKey: 'MOVED', ctx: s.owner });

    const denied = await rejectionOf(projectsService.resolveByKey(s.projectKey, s.outsider));
    const missing = await rejectionOf(projectsService.resolveByKey(NEVER_CREATED, s.outsider));

    expect(denied).toBeInstanceOf(ProjectNotFoundError);
    expect(denied.message).toBe(missing.message.replace(NEVER_CREATED, s.projectKey));
    // …and the issue-page redirect helper still declines to redirect them.
    await expect(resolveAliasedIssueKey(`${s.projectKey}-1`, s.outsider)).resolves.toBeNull();
  });

  it('CONTROL: a project MEMBER resolves the same key — the refusal is about browse, not the fixture', async () => {
    const s = await seed('owner-control');
    const project = await projectsService.getByKey(s.projectKey, s.member);
    expect(project.identifier).toBe(s.projectKey);
  });
});

// ── THE ROUTES ──────────────────────────────────────────────────────────────
//
// Every `/api/projects/[key]/*` route that calls `projectsService.getByKey`,
// enumerated on `origin/main` at f36f9b17e with
//   git grep -l "projectsService.getByKey" -- app/api/projects
// Each call carries a body that passes the route's own validation, so the
// request REACHES the lookup — asserted by the never-created key answering 404
// first, which makes a route that 400s or 422s before the lookup fail loudly
// instead of comparing two identical validation errors.

type Call = (key: string) => Promise<Response>;

const get = (url = 'https://app.motir.co/x') => new Request(url);
const json = (method: string, body: unknown) =>
  new Request('https://app.motir.co/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

const ROUTES: { route: string; call: Call }[] = [
  {
    route: 'GET approval-gates',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/approval-gates/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET estimation-config',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/estimation-config/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET lessons',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/lessons/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET lessons/[lessonId]',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/lessons/[lessonId]/route')).GET(
        get(),
        p({ key, lessonId: 'lesson-1' }),
      ),
  },
  {
    route: 'PUT lessons/[lessonId]/applied',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/lessons/[lessonId]/applied/route')).PUT(
        json('PUT', { applied: true }),
        p({ key, lessonId: 'lesson-1' }),
      ),
  },
  {
    route: 'GET monitors',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/monitors/route')).GET(get(), p({ key })),
  },
  {
    route: 'DELETE monitors/[connectionId]',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/monitors/[connectionId]/route')).DELETE(
        json('DELETE', {}),
        p({ key, connectionId: 'connection-1' }),
      ),
  },
  {
    // MOTIR-5579: the minimum-level write. A valid level, so the request reaches
    // the lookup rather than 400ing on the value.
    route: 'PATCH monitors/[connectionId]',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/monitors/[connectionId]/route')).PATCH(
        json('PATCH', { minimumLevel: 'error' }),
        p({ key, connectionId: 'connection-1' }),
      ),
  },
  {
    route: 'GET monitors/available',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/monitors/available/route')).GET(get(), p({ key })),
  },
  {
    // MOTIR-5181: the merge-mode card's write door. The body is a valid mode, so
    // the request reaches the lookup rather than 400ing on the value.
    route: 'PATCH pr-merge-mode',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/pr-merge-mode/route')).PATCH(
        json('PATCH', { prMergeMode: 'auto' }),
        p({ key }),
      ),
  },
  {
    // MOTIR-4938: the Bugs room's write door. `null` is a valid destination (the
    // project root), and the route resolves the key before the service reads the
    // value, so the request reaches the lookup rather than 400ing on the body.
    route: 'PATCH bug-destination',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/bug-destination/route')).PATCH(
        json('PATCH', { folderId: null }),
        p({ key }),
      ),
  },
  {
    route: 'GET repositories',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET repositories/access',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/access/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET repositories/access/team',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/access/team/route')).GET(
        get(),
        p({ key }),
      ),
  },
  {
    route: 'POST repositories/add',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/add/route')).POST(
        json('POST', { role: 'web', githubRepoId: 'repo-1' }),
        p({ key }),
      ),
  },
  {
    route: 'GET repositories/available',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/available/route')).GET(
        get(),
        p({ key }),
      ),
  },
  {
    route: 'POST repositories/establish',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/repositories/establish/route')).POST(
        json('POST', { rowId: 'row-1' }),
        p({ key }),
      ),
  },
  {
    route: 'GET roadmap',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/roadmap/route')).GET(get(), p({ key })),
  },
  {
    route: 'GET velocity',
    call: async (key) =>
      (await import('@/app/api/projects/[key]/velocity/route')).GET(get(), p({ key })),
  },
];

/** A response reduced to what a caller can observe, with the typed key normalised. */
async function observed(res: Response, typedKey: string) {
  const text = await res.text();
  return { status: res.status, body: text.split(typedKey).join('<KEY>') };
}

describe('the ROUTES — a non-browser cannot tell a private project from a missing one', () => {
  it('covers every /api/projects/[key]/* route that resolves by key (the enumeration is not stale)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '..', '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const f = join(dir, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (e === 'route.ts' && readFileSync(f, 'utf8').includes('projectsService.getByKey'))
          found.push(
            relative(join(root, 'app/api/projects/[key]'), f).replace(/\/?route\.ts$/, ''),
          );
      }
    };
    walk(join(root, 'app', 'api', 'projects', '[key]'));
    const covered = new Set(ROUTES.map((r) => r.route.split(' ')[1]));
    expect(found.filter((f) => !covered.has(f))).toEqual([]);
  });

  it.each(ROUTES)(
    '$route answers the non-browser exactly as it answers a never-created key',
    async ({ call }) => {
      const s = await seed('routes');
      requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: s.outsider });

      const missing = await observed(await call(NEVER_CREATED), NEVER_CREATED);
      expect(missing.status, 'the request did not reach the lookup — fix the fixture body').toBe(
        404,
      );

      const denied = await observed(await call(s.projectKey), s.projectKey);
      expect(denied).toEqual(missing);
    },
  );
});
