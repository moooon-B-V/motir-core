import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import {
  runReinforceLesson,
  registerReinforceLesson,
  REINFORCE_LESSON_TOOL_NAME,
} from '@/lib/mcp/tools/reinforceLesson';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `reinforce_lesson` (Subtask MOTIR-3553 · Bug MOTIR-3547) — the tool, over real
// Postgres, with motir-ai stubbed AT THE TRANSPORT so the real client builds the
// request and parses a real Response.
//
// The tool is a thin adapter, so what is under test is exactly the thin part:
// that it is REGISTERED under its OWN key, that a refusal happens BEFORE
// anything crosses the boundary, and that the one answer worth acting on —
// whether this call COUNTED — survives every hop out.
//
// ⚠️ THE KEY IS THE POINT OF THIS CARD, and it is asserted in both directions.
// Reusing `lesson:manage` would have been one word cheaper and would have handed
// every device-minted token the ability to RETIRE a lesson in order to record
// that one applied. So: the tool takes `lesson:reinforce`, the CLI grant carries
// that and NOT `lesson:manage`, and both halves are pinned below.
//
// The DESCRIPTION is the other deliverable and is asserted as writing: not its
// wording, which must stay free to churn, but the discriminator it has to carry.
// An agent gets no other briefing, and the store cannot tell whether an
// occurrence really happened — only the caller was there.

const PASSWORD = 'hunter2hunter2';

const INPUT = { lessonId: 'les_1', occurrenceRef: 'MOTIR-4242' };

/** The reinforce route's WIRE shape. */
function wireReinforced(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_1',
    title: 'Pin the repository on every card that ships code',
    scope: 'global',
    lastOccurredAt: '2026-08-26T00:00:00.000Z',
    recurrenceCount: 4,
    counted: true,
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

async function actorWithRole(
  fx: WorkItemFixture,
  role: 'admin' | 'member' | 'viewer',
  slug: string,
): Promise<ServiceContext> {
  const u = await usersService.createUser({
    email: `rl-${slug}-${Date.now()}-${Math.round(Math.random() * 1e6)}@ex.com`,
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

function textOf(result: Awaited<ReturnType<typeof runReinforceLesson>>): string {
  return (result.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n');
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

// ───────────────────────────────────────────────────────────────────────────
// 1. ITS OWN KEY — the decision this card turns on
// ───────────────────────────────────────────────────────────────────────────
describe('reinforce_lesson — registration', () => {
  it('is registered and asserts `lesson:reinforce`, NOT `lesson:manage`', () => {
    expect(MCP_TOOL_NAMES).toContain(REINFORCE_LESSON_TOOL_NAME);
    expect(TOOL_PERMISSIONS[REINFORCE_LESSON_TOOL_NAME]).toBe('lesson:reinforce');
    // The half that matters: recording an occurrence must not require the
    // ability to change or retire a lesson.
    expect(TOOL_PERMISSIONS[REINFORCE_LESSON_TOOL_NAME]).not.toBe('lesson:manage');
  });

  it('a CLI-minted token can reinforce and CANNOT retire or add', () => {
    expect(CLI_TOKEN_GRANT).toContain('lesson:reinforce');
    // `lesson:manage` is what `add_lesson` and retiring take. A remote,
    // unattended credential holds neither.
    expect(CLI_TOKEN_GRANT).not.toContain('lesson:manage');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE GATE IS UPSTREAM OF THE BOUNDARY
// ───────────────────────────────────────────────────────────────────────────
describe('reinforce_lesson — refused BEFORE any upstream call', () => {
  it('a project MEMBER is refused and motir-ai is never called', async () => {
    const fx = await makeWorkItemFixture();
    const member = await actorWithRole(fx, 'member', 'member');
    const upstream = stubUpstream(() => jsonResponse(wireReinforced()));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, member);

    expect(result.isError).toBe(true);
    // A caller without the permission causes NO WORK AT ALL, not merely no
    // write — the same placement `search_lessons` uses for its own gate.
    expect(upstream.calls).toEqual([]);
  });

  it('a project VIEWER is refused and motir-ai is never called', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await actorWithRole(fx, 'viewer', 'viewer');
    const upstream = stubUpstream(() => jsonResponse(wireReinforced()));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, viewer);

    expect(result.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. THE ROUND TRIP
// ───────────────────────────────────────────────────────────────────────────
describe('reinforce_lesson — the call', () => {
  it('posts the occurrence to the reinforce route and reports what counted', async () => {
    const fx = await makeWorkItemFixture();
    const upstream = stubUpstream(() => jsonResponse(wireReinforced()));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.isError).toBeFalsy();
    expect(upstream.calls[0]).toContain('/v1/lessons/les_1/reinforce');
    const body = JSON.parse(String(upstream.inits[0]?.body ?? '{}')) as Record<string, unknown>;
    // The occurrence ref MUST travel: it is what makes the call idempotent, and
    // a server-invented one would make every call a fresh occurrence.
    expect(body['occurrenceRef']).toBe('MOTIR-4242');

    const text = textOf(result);
    expect(text).toContain('Reinforced');
    expect(text).toContain('4');
  });

  // `counted: false` is a NORMAL answer. A caller that cannot tell it from a
  // fresh record will either retry forever or report a recurrence that did not
  // happen — so it survives to BOTH channels.
  it('a REPLAY reads as already-recorded, in the prose AND the payload', async () => {
    const fx = await makeWorkItemFixture();
    stubUpstream(() => jsonResponse(wireReinforced({ counted: false, recurrenceCount: 3 })));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/already recorded/i);
    expect(text).not.toMatch(/\bReinforced\b/);
    expect((result.structuredContent as Record<string, unknown> | undefined)?.['counted']).toBe(
      false,
    );
  });

  it('carries the lesson id and `counted` in the STRUCTURED payload', async () => {
    const fx = await makeWorkItemFixture();
    stubUpstream(() => jsonResponse(wireReinforced()));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload['id']).toBe('les_1');
    expect(payload['counted']).toBe(true);
    expect(payload['recurrenceCount']).toBe(4);
  });

  // An upstream failure must NOT read as a recorded occurrence. `listLessons`
  // degrades to an empty section so a settings page stays usable; a caller here
  // asked to RECORD something, and a lost occurrence is a corpus that quietly
  // stops counting.
  it('surfaces an upstream refusal as an error rather than a silent success', async () => {
    const fx = await makeWorkItemFixture();
    stubUpstream(() => jsonResponse({ type: 'about:blank', title: 'not_found', status: 404 }, 404));

    const result = await runReinforceLesson({ projectKey: fx.projectIdentifier, ...INPUT }, fx.ctx);

    expect(result.isError).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE DESCRIPTION IS THE ENFORCEMENT MECHANISM
// ───────────────────────────────────────────────────────────────────────────
describe('reinforce_lesson — the briefing', () => {
  // Asserted as WRITING, not as wording: the text must stay free to churn, and
  // these are the things it cannot stop carrying. The rule this tool installs is
  // a discriminator no schema can express, so if the description stops teaching
  // it there is nowhere else it lives.
  function description(): string {
    // Read the description the SERVER actually registers, not a copy of the
    // constant: the thing under test is what an agent is handed.
    const registered: Record<string, string> = {};
    const server = {
      registerTool(name: string, config: { description?: string }) {
        registered[name] = config.description ?? '';
      },
    } as unknown as McpServer;
    registerReinforceLesson(server, () => ({ userId: 'u', workspaceId: 'w' }));
    return registered[REINFORCE_LESSON_TOOL_NAME] ?? '';
  }

  it('says a hit counts WHETHER OR NOT the lesson is then changed', () => {
    expect(description()).toMatch(/whether or not/i);
  });

  it('says an editorial pass with no incident records NOTHING', () => {
    const d = description();
    expect(d).toMatch(/reword|retag|tidy/i);
    expect(d).toMatch(/nothing/i);
  });

  it('says a search merely RETURNING rows is not a hit', () => {
    expect(description()).toMatch(/not a hit/i);
  });

  it('says the call is idempotent and names what the ref identifies', () => {
    const d = description();
    expect(d).toMatch(/idempotent/i);
    expect(d).toMatch(/counted: false/);
  });
});
