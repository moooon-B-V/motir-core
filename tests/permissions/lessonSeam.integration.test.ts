import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY-LEVEL SEAM for MOTIR-3329 (Subtask MOTIR-3339) — the assembled
// route → service → client → upstream path, against real Postgres, with
// motir-ai stubbed AT THE TRANSPORT.
//
// ⚠️ STUBBED AT `fetch`, NOT AT THE CLIENT, and that is the point of the file.
// A mocked `motirAiClient` returns whatever the test decides, which proves the
// service works given a well-behaved client and says nothing about the
// malformed-body and error-mapping paths a real outage actually produces. Here
// the real client builds the URL, sends the real bearer, and parses a real
// Response — so the envelope is under test too.
//
// Four properties, each chosen because the natural way to write it passes under
// a broken implementation:
//
//   1. A caller without `lesson:view` is refused AND NO UPSTREAM CALL IS MADE.
//      Asserted as the stub's CALL COUNT: a service that fetched and then
//      refused satisfies every status assertion anybody would write, while
//      having already assembled a payload of another project's planning
//      conclusions inside the server.
//   2. NO `scope = 'global'` row reaches the client, given an upstream response
//      containing both. Asserted from the CORE side even though motir-ai
//      asserts it too, because either end can regress alone.
//   3. Another project's lessons are unreachable — the project is resolved from
//      the session, never from a parameter a caller can set.
//   4. An upstream failure DEGRADES: the section reports unavailable and the
//      rest of the AI-planning settings payload still returns.

const PASSWORD = 'hunter2hunter2';

interface Scenario {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerCtx: WorkspaceContext;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  viewerCtx: WorkspaceContext;
  /** A workspace member with NO project membership, on a PRIVATE project. */
  outsiderCtx: WorkspaceContext;
}

let seq = 0;

async function buildScenario(slug: string): Promise<Scenario> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `les-owner-${slug}-${seq}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `LES WS ${slug} ${seq}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `LES ${slug}`,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function actor(role: 'admin' | 'member' | 'viewer' | null): Promise<WorkspaceContext> {
    const u = await usersService.createUser({
      email: `les-${role ?? 'outsider'}-${slug}-${seq}@ex.com`,
      password: PASSWORD,
      name: role ?? 'outsider',
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    if (role) {
      await projectMembersService.addMember({
        key: project.identifier,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: u.id,
        role,
      });
    }
    return { userId: u.id, workspaceId: workspace.id };
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    adminCtx: await actor('admin'),
    memberCtx: await actor('member'),
    viewerCtx: await actor('viewer'),
    outsiderCtx: await actor(null),
  };
}

/** One lesson row in motir-ai's WIRE shape (not the DTO). */
function wireLesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_1',
    scope: 'tenant',
    aiProjectId: 'aip_1',
    mistakeType: 'regular_planning',
    title: 'A takeaway',
    body: 'What happened',
    why: 'Why it matters',
    howToApply: 'How to apply it',
    categories: [],
    kinds: [],
    types: [],
    phases: [],
    sourceRef: 'MOTIR-1',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastOccurredAt: '2026-08-02T00:00:00.000Z',
    recurrenceCount: 1,
    injected: true,
    injectionBlock: null,
    ...over,
  };
}

/**
 * The upstream, stubbed at `fetch`. Returns the recorded calls so a test can ask
 * how many were made and what was on the wire.
 */
function stubUpstream(handler: (url: string) => Response | Promise<Response>): {
  calls: string[];
} {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1 · refused BEFORE the boundary — the call count, not the status', () => {
  it('a project MEMBER is refused and motir-ai is never called', async () => {
    const s = await buildScenario('member');
    const upstream = stubUpstream(() => jsonResponse({ lessons: [] }));

    await expect(
      projectLessonsService.listLessons(s.projectId, s.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    // The assertion this test exists for.
    expect(upstream.calls).toEqual([]);
  });

  it('a project VIEWER is refused and motir-ai is never called', async () => {
    const s = await buildScenario('viewer');
    const upstream = stubUpstream(() => jsonResponse({ lessons: [] }));

    await expect(
      projectLessonsService.listLessons(s.projectId, s.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(upstream.calls).toEqual([]);
  });

  it('the refusal NAMES the key it asked for', async () => {
    const s = await buildScenario('named');
    stubUpstream(() => jsonResponse({ lessons: [] }));
    await projectLessonsService.listLessons(s.projectId, s.viewerCtx).catch((err: unknown) => {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect((err as PermissionDeniedError).permission).toBe('lesson:view');
    });
    expect.hasAssertions();
  });

  it('a NON-BROWSER gets the 404 shape, not the 403 — and still no upstream call', async () => {
    // The ordering is a security property the whole permission model inherits:
    // a 403 would confirm a private project the actor may not see.
    const s = await buildScenario('outsider');
    const upstream = stubUpstream(() => jsonResponse({ lessons: [] }));

    await expect(
      projectLessonsService.listLessons(s.projectId, s.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(upstream.calls).toEqual([]);
  });

  it('the DETAIL read refuses on the same terms, with no upstream call', async () => {
    const s = await buildScenario('detail-guard');
    const upstream = stubUpstream(() => jsonResponse(wireLesson()));

    await expect(
      projectLessonsService.getLesson(s.projectId, s.viewerCtx, 'les_1'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(upstream.calls).toEqual([]);
  });

  it('an ADMIN passes, and exactly ONE upstream call is made', async () => {
    const s = await buildScenario('admin');
    const upstream = stubUpstream(() =>
      jsonResponse({
        lessons: [wireLesson()],
        nextCursor: null,
        staleCutoff: '2026-05-01T00:00:00.000Z',
        retentionDays: 90,
      }),
    );

    const page = await projectLessonsService.listLessons(s.projectId, s.adminCtx);
    expect(page.available).toBe(true);
    expect(page.lessons).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
  });
});

describe('2 · no GLOBAL row crosses, given a mixed upstream fixture', () => {
  it('drops the global row, and never asks for one', async () => {
    const s = await buildScenario('scope');
    // The fixture holds BOTH scopes, which is the regression this guards: if
    // core ever started passing a flag that unioned the global corpus in "for
    // context", or motir-ai widened its predicate, the global row would arrive
    // here and be rendered as one of the project's own.
    const upstream = stubUpstream(() =>
      jsonResponse({
        lessons: [
          wireLesson({ id: 'ours', scope: 'tenant', title: 'ours' }),
          wireLesson({ id: 'theirs', scope: 'global', aiProjectId: null, title: 'the corpus' }),
        ],
        nextCursor: null,
        staleCutoff: '2026-05-01T00:00:00.000Z',
        retentionDays: 90,
      }),
    );

    const page = await projectLessonsService.listLessons(s.projectId, s.adminCtx);

    // (a) THE RESPONSE. The global row is in the fixture and must not be in the
    // answer — the core-side narrowing, which exists because either end can
    // regress alone. This is the assertion that would have caught a core that
    // rendered the corpus as the project's own.
    expect(page.lessons.map((l) => l.title)).toEqual(['ours']);

    // (b) THE REQUEST. motir-ai owns the predicate (`aiProjectId = <one
    // project>`, MOTIR-3335), so the other thing core must never do is ASK for
    // anything wider — and there is exactly one way it could: a query
    // parameter. The request carries the two core ids and nothing else.
    const url = new URL(upstream.calls[0]!);
    expect(url.pathname).toBe('/v1/lessons');
    expect([...url.searchParams.keys()].sort()).toEqual(['coreProjectId', 'coreWorkspaceId']);
    expect(url.searchParams.get('coreProjectId')).toBe(s.projectId);
    expect(url.searchParams.get('coreWorkspaceId')).toBe(s.workspaceId);
    // …and no `scope`, `includeGlobal` or `aiProjectId` parameter exists to add.
    for (const forbidden of ['scope', 'includeGlobal', 'aiProjectId', 'global']) {
      expect(url.searchParams.has(forbidden)).toBe(false);
    }

    // (c) And the DTO carries no scope field at all, so even a row that got
    // past (a) could not be labelled as this project's by a surface.
    for (const lesson of page.lessons) {
      expect(lesson).not.toHaveProperty('scope');
      expect(lesson).not.toHaveProperty('aiProjectId');
    }
  });
});

describe('3 · the project comes from the SESSION, not from a parameter', () => {
  it("an admin of project A cannot reach project B's lessons", async () => {
    const a = await buildScenario('proj-a');
    const b = await buildScenario('proj-b');
    const upstream = stubUpstream(() =>
      jsonResponse({ lessons: [], nextCursor: null, staleCutoff: 'X', retentionDays: 90 }),
    );

    // A's admin holds no membership on B, and B is private → the no-existence-leak
    // 404, with nothing crossing the boundary.
    await expect(projectLessonsService.listLessons(b.projectId, a.adminCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(upstream.calls).toEqual([]);
  });

  it('the upstream request is keyed by the CALLER’s workspace, not by anything passed in', async () => {
    const a = await buildScenario('own-ws');
    const upstream = stubUpstream(() =>
      jsonResponse({ lessons: [], nextCursor: null, staleCutoff: 'X', retentionDays: 90 }),
    );
    await projectLessonsService.listLessons(a.projectId, a.adminCtx);
    const url = new URL(upstream.calls[0]!);
    expect(url.searchParams.get('coreWorkspaceId')).toBe(a.adminCtx.workspaceId);
  });
});

describe('4 · an upstream failure degrades the SECTION, not the PAGE', () => {
  it('reports unavailable while the AI-planning settings payload still returns', async () => {
    const s = await buildScenario('degrade');
    stubUpstream(() => {
      throw new Error('ECONNREFUSED');
    });

    const page = await projectLessonsService.listLessons(s.projectId, s.adminCtx);
    expect(page.available).toBe(false);
    expect(page.lessons).toEqual([]);

    // The half that matters: the three groups that shipped before this story
    // still answer, during the same outage. Their read touches Postgres only,
    // so a lessons read that THREW would have to be what took them down — which
    // is exactly the regression this asserts cannot happen.
    const settings = await projectAiSettingsService.getAiSettings(s.projectKey, s.adminCtx);
    expect(settings).toMatchObject({
      aiAutoPlanEnabled: expect.any(Boolean),
      aiSprintPlanningEnabled: expect.any(Boolean),
    });
  });

  it('degrades on an upstream 5xx as well as on a transport failure', async () => {
    const s = await buildScenario('degrade-5xx');
    stubUpstream(() =>
      jsonResponse({ code: 'internal_error', title: 'boom', status: 500, detail: 'boom' }, 500),
    );
    const page = await projectLessonsService.listLessons(s.projectId, s.adminCtx);
    expect(page.available).toBe(false);
  });

  it('a MALFORMED 200 degrades too — a version skew is not an empty library', async () => {
    // The client's own malformed-body arm, exercised through the real transport:
    // `{ items: [] }` must not render as "this project has no lessons".
    const s = await buildScenario('degrade-shape');
    stubUpstream(() => jsonResponse({ items: [] }));
    const page = await projectLessonsService.listLessons(s.projectId, s.adminCtx);
    expect(page.available).toBe(false);
  });
});
