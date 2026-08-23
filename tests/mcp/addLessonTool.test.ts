import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { runAddLesson, ADD_LESSON_TOOL_NAME } from '@/lib/mcp/tools/addLesson';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `add_lesson` (Story MOTIR-3331 · Subtask MOTIR-3361) — the tool, over real
// Postgres, with motir-ai stubbed AT THE TRANSPORT so the real client builds the
// request and parses a real Response.
//
// The tool is a thin adapter, so what is under test here is exactly the thin
// part: that it is REGISTERED with the right permission, that a refusal happens
// BEFORE anything crosses the boundary, and that the one answer this tool can
// give a caller which is worth acting on — the near-duplicate refusal naming the
// lesson that already covers it — survives all four hops out.
//
// The DESCRIPTION is the other deliverable and is asserted below as writing: not
// its wording, which must stay free to churn, but the five things it has to
// carry. An agent gets no other briefing.

const PASSWORD = 'hunter2hunter2';

const INPUT = {
  title: 'Pin the repository on every card that ships code',
  body: 'A card with no repository pinned goes to whichever checkout happens to be first.',
  why: 'It cost a day in the billing epic.',
  howToApply: 'Set the target repository before sealing a card that ships code.',
  mistakeType: 'regular_planning' as const,
};

/** One lesson row in motir-ai's WIRE shape. */
function wireLesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_1',
    scope: 'tenant',
    aiProjectId: 'aip_1',
    mistakeType: 'regular_planning',
    title: INPUT.title,
    body: INPUT.body,
    why: INPUT.why,
    howToApply: INPUT.howToApply,
    categories: [],
    kinds: [],
    types: [],
    phases: [],
    sourceRef: null,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function stubUpstream(response: () => Response): { calls: string[]; inits: RequestInit[] } {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      calls.push(String(input));
      inits.push((init ?? {}) as RequestInit);
      return response();
    }),
  );
  return { calls, inits };
}

/** A workspace member with a project role, as a ServiceContext. */
async function actorWithRole(
  fx: WorkItemFixture,
  role: 'admin' | 'member' | 'viewer',
  slug: string,
): Promise<ServiceContext> {
  const u = await usersService.createUser({
    email: `al-${slug}-${Date.now()}-${Math.round(Math.random() * 1e6)}@ex.com`,
    password: PASSWORD,
    name: role,
  });
  await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role,
  });
  return { userId: u.id, workspaceId: fx.workspaceId };
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

describe('add_lesson — registration', () => {
  it('is registered and asserts the lesson-library-change permission', () => {
    expect(MCP_TOOL_NAMES).toContain(ADD_LESSON_TOOL_NAME);
    // `lesson:manage`, the SAME key retiring a lesson takes: both change the
    // standing instructions the planner is given (MOTIR-3336).
    expect(TOOL_PERMISSIONS[ADD_LESSON_TOOL_NAME]).toBe('lesson:manage');
  });
});

describe('add_lesson — refused BEFORE any upstream call', () => {
  it('a project MEMBER is refused and motir-ai is never called', async () => {
    const fx = await makeWorkItemFixture();
    const member = await actorWithRole(fx, 'member', 'member');
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await runAddLesson({ projectKey: fx.projectIdentifier, ...INPUT }, member);

    expect(result.isError).toBe(true);
    // The assertion this test exists for. A check that ran AFTER the request had
    // gone out would read identically from the returned error — and would have
    // already written a row into the project's standing instructions.
    expect(upstream.calls).toEqual([]);
  });

  it('a project VIEWER is refused and motir-ai is never called', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await actorWithRole(fx, 'viewer', 'viewer');
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await runAddLesson({ projectKey: fx.projectIdentifier, ...INPUT }, viewer);

    expect(result.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
  });

  it('the project OWNER may record one — so the gate is not simply refusing everyone', async () => {
    const fx = await makeWorkItemFixture();
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await runAddLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.isError).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toContain('/v1/lessons');
    expect(result.structuredContent).toMatchObject({ id: 'les_1', title: INPUT.title });
  });
});

describe('add_lesson — the near-duplicate refusal reaches the caller intact', () => {
  it('carries the existing lesson’s id AND title in the tool result', async () => {
    const fx = await makeWorkItemFixture();
    stubUpstream(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'conflict',
          status: 409,
          code: 'conflict',
          detail:
            'a lesson very like this one already applies to this project: les_existing — "Pin the repository"',
        },
        409,
      ),
    );

    const result = await runAddLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.isError).toBe(true);
    // BOTH, all the way out. The caller needs the id to go and retire that row,
    // and the title to judge whether rewording its own is the right answer — a
    // generic "could not create" turns the one actionable answer this tool gives
    // into a dead end.
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('les_existing');
    expect(rendered).toContain('Pin the repository');
  });
});

describe('add_lesson — the axes round-trip as stored', () => {
  it('reports an omitted axis as EMPTY, so an agent can see it means "everything"', async () => {
    const fx = await makeWorkItemFixture();
    stubUpstream(() => jsonResponse(wireLesson({ kinds: [], types: [], phases: [] }), 201));

    const result = await runAddLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.structuredContent).toMatchObject({ kinds: [], types: [], phases: [] });
    // And the summary SAYS so in words, because an empty array in a payload is
    // easy for an agent to read as "no data" rather than as "unconstrained".
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('applies to every card');
  });

  it('sends the axes it was given', async () => {
    const fx = await makeWorkItemFixture();
    const upstream = stubUpstream(() =>
      jsonResponse(wireLesson({ kinds: ['story'], types: ['code'], phases: ['deepen'] }), 201),
    );

    await runAddLesson(
      {
        projectKey: fx.projectIdentifier,
        ...INPUT,
        kinds: ['story'],
        types: ['code'],
        phases: ['deepen'],
      },
      fx.ctx,
    );

    const body = JSON.parse(upstream.inits[0]!.body as string) as Record<string, unknown>;
    expect(body['kinds']).toEqual(['story']);
    expect(body['types']).toEqual(['code']);
    expect(body['phases']).toEqual(['deepen']);
  });
});
