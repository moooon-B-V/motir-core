import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan-edit suites,
// e.g. tests/mcp/expand-item.test.ts). Everything below it is real: a real
// Postgres, the real MCP server + transport, the real `planChangeSessionsService`
// (its row-locked `seq` allocation, its accumulated-intent build, its submit
// transaction) and the real Plan rows. So what these tests assert about the
// thread and the Plan is what production actually writes.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { getJob, streamJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { toolScope, TOKEN_SCOPES, type TokenScope } from '@/lib/mcp/scopes';
import { SCOPE_NOT_GRANTED_CODE } from '@/lib/mcp/scopeGate';
import {
  APPEND_PLAN_TURN_TOOL_NAME,
  OPEN_PLAN_SESSION_TOOL_NAME,
  SUBMIT_PLAN_SESSION_TOOL_NAME,
} from '@/lib/mcp/tools/planSession';
import {
  buildAccumulatedIntent,
  planChangeSessionsService,
} from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The plan-change CONVERSATION over MCP (Story 7.9 · MOTIR-1832) — the
// mechanism `motir plan` talks through, and the thing that makes terminal
// planning a dialogue rather than a one-shot prompt.
//
// The four contracts these lock, in the order a caller meets them:
//
//   1. ONE THREAD PER SCOPE, RESUMED — not forked. Re-opening a project (or the
//      same anchor set, in any order or case) returns the SAME row with its
//      turns; a DIFFERENT anchor set is a different conversation.
//   2. THE SAME THREAD THE WEB PANEL SEES. A turn added over MCP is on the row
//      the cookie routes read, and vice versa — asserted in BOTH directions
//      against the real Postgres, because "one substrate" is only true if the
//      two surfaces cannot drift apart.
//   3. ACCUMULATE ≠ SUBMIT. Appending starts no job. Submitting sends EVERY turn
//      as one intent (`buildAccumulatedIntent`'s numbered framing for N, byte-
//      identical pass-through for one), and an empty thread refuses with the
//      typed error rather than firing an empty job.
//   4. SUBMIT AND RETURN, AND IT PROPOSES. `{ jobId, planId }` comes back the
//      instant motir-ai accepts (asserted NEGATIVELY too — nothing streamed,
//      nothing polled), the marker turn records the job, and a FAILED submit
//      leaves the thread whole with no orphan Plan.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern), plus one scope-gated server for the read-only-token
// matrix. The bearer/auth plumbing is the story-roundtrip suite's job.

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const session = (r: CallToolResult) => r.structuredContent as unknown as PlanChangeSessionDto;
const text = (r: CallToolResult) => JSON.stringify(r.content);

/** Connect an in-memory client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext, scopes?: TokenScope[]): Promise<Client> {
  const server = scopes
    ? buildMcpServer(
        () => ctx,
        () => scopes,
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-session', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The ProjectContext the cookie routes hand the service — the "web panel" side. */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_change_turn", "plan_change_session", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_plan_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('plan-session tools — registration + scope + advertised contracts', () => {
  it('all three are registered; opening is a read, appending and submitting are writes', () => {
    expect(MCP_TOOL_NAMES).toContain(OPEN_PLAN_SESSION_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(APPEND_PLAN_TURN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(SUBMIT_PLAN_SESSION_TOOL_NAME);
    // Opening a thread spends nothing and changes no plan; extending one and
    // firing it are the acts a read-only token must not be able to perform.
    expect(toolScope(OPEN_PLAN_SESSION_TOOL_NAME)).toBe('read');
    expect(toolScope(APPEND_PLAN_TURN_TOOL_NAME)).toBe('work_items:write');
    expect(toolScope(SUBMIT_PLAN_SESSION_TOOL_NAME)).toBe('work_items:write');
  });

  it('the descriptions carry BOTH load-bearing contracts in as many words', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const append = tools.find((t) => t.name === APPEND_PLAN_TURN_TOOL_NAME);
    const submit = tools.find((t) => t.name === SUBMIT_PLAN_SESSION_TOOL_NAME);

    // (a) Appending does NOT submit — an agent that assumes otherwise polls a
    // job that was never created.
    expect(append?.description).toMatch(/does NOT submit/i);
    expect(append?.description).toMatch(new RegExp(SUBMIT_PLAN_SESSION_TOOL_NAME));
    // (b) A submit PROPOSES — approval in Motir is the only path to a work item.
    expect(submit?.description).toMatch(/does NOT create work items/i);
    expect(submit?.description).toMatch(/approv/i);
    await client.close();
  });
});

describe('open_plan_session — one thread per scope, resumed not forked', () => {
  it('opens the project thread, and a second open RESUMES it with its turns', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const first = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(first.isError).toBeFalsy();
    const opened = session(first);
    expect(opened.turnCount).toBe(0);
    expect(opened.targetKeys).toEqual([]);
    expect(opened.lastSubmittedAt).toBeNull();
    expect(text(first)).toContain('Opened planning conversation');

    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add a billing epic.',
    });

    // Re-opening is the resume: the SAME row, carrying the turn already on it —
    // which is what lets a terminal client render the thread it is rejoining.
    const again = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    expect(again.id).toBe(opened.id);
    expect(again.turnCount).toBe(1);
    expect(again.turns.map((t) => t.body)).toEqual(['Add a billing epic.']);
    expect(await db.planChangeSession.count()).toBe(1);
    await client.close();
  });

  it('a distinct anchor set is a distinct thread; the SAME set — any order or case — resumes it', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story B' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const wide = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    const onA = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier],
      }),
    );
    const onAB = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier, b.identifier],
      }),
    );

    // Three anchor sets → three conversations. The project-wide thread is not
    // the {A} thread, and {A} is not {A,B}.
    expect(new Set([wide.id, onA.id, onAB.id]).size).toBe(3);
    expect(onA.targetKeys).toEqual([a.identifier]);
    expect(onAB.targetKeys).toEqual([a.identifier, b.identifier].sort());

    // The anchor SET is the identity: reversed, lower-cased and duplicated, it
    // is the same conversation — a CLI must not fork a second thread about the
    // same items just because it listed them differently.
    const resumed = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'prod',
        targetKeys: [b.identifier.toLowerCase(), a.identifier, b.identifier],
      }),
    );
    expect(resumed.id).toBe(onAB.id);
    expect(await db.planChangeSession.count()).toBe(3);
    await client.close();
  });

  it('an anchor the caller cannot see 404s — it never becomes a scope key', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'story', title: 'Acme story' },
      a.ctx,
    );
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    // Another tenant's item, aimed at the outsider's OWN project: resolution
    // runs through the 6.4 authority, so it is a not-found, not a silent anchor.
    const res = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'ZZZ',
      targetKeys: [theirs.identifier],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NOT_FOUND');
    expect(await db.planChangeSession.count()).toBe(0);

    // And the project itself: a project outside the caller's workspace is a
    // not-found, never a 403 leak.
    const foreign = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain('NOT_FOUND');
    await client.close();
  });
});

describe('append_plan_turn — accumulation, and the SAME thread the web panel sees', () => {
  it('appends without submitting: turns pile up, no job is fired', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const first = await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add auth to the billing epic.',
    });
    expect(first.isError).toBeFalsy();
    // A first turn opens the thread on its own — a terminal client has no mount
    // step, so it must not need a separate open call to say something.
    expect(session(first).turnCount).toBe(1);
    expect(text(first)).toContain('NOT submitted');

    const second = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
        projectKey: 'PROD',
        body: 'Keep every subtask under 3 points.',
      }),
    );
    expect(second.turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(second.turns.every((t) => t.role === 'user')).toBe(true);
    // Nothing left for the planner, and the thread reports itself unsubmitted.
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(second.lastJobId).toBeNull();
    expect(second.lastSubmittedAt).toBeNull();
    expect(await db.plan.count()).toBe(0);
    await client.close();
  });

  it('an empty body is refused with the service’s typed error', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: '   ',
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('MCP turns and web-panel turns land on ONE row — asserted in both directions', async () => {
    const fx = await makeWorkItemFixture();
    const pctx = projectCtx(fx);
    const client = await connectClient(fx.ctx);

    // Web panel first (exactly what the cookie routes call), then MCP.
    const fromPanel = await planChangeSessionsService.getOrCreateForProject(pctx);
    await planChangeSessionsService.appendTurn('Typed in the browser.', pctx);
    const fromCli = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
        projectKey: 'PROD',
        body: 'Typed in the terminal.',
      }),
    );

    // Same row, and the CLI sees the browser's turn.
    expect(fromCli.id).toBe(fromPanel.id);
    expect(fromCli.turns.map((t) => t.body)).toEqual([
      'Typed in the browser.',
      'Typed in the terminal.',
    ]);

    // …and the browser sees the CLI's — one `(project_id, scope_key)` row, not
    // two surfaces with two conversations.
    const backInPanel = await planChangeSessionsService.getOrCreateForProject(pctx);
    expect(backInPanel.id).toBe(fromPanel.id);
    expect(backInPanel.turns.map((t) => t.body)).toEqual([
      'Typed in the browser.',
      'Typed in the terminal.',
    ]);
    expect(await db.planChangeSession.count()).toBe(1);
    await client.close();
  });
});

describe('submit_plan_session — one job for the whole thread', () => {
  it('sends N turns as ONE accumulated intent, and returns { jobId, planId } without waiting', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add auth to the billing epic.',
    });
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Keep every subtask under 3 points.',
    });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBeFalsy();
    const out = struct(res) as unknown as {
      jobId: string;
      planId: string;
      session: PlanChangeSessionDto;
    };
    expect(out.jobId).toBe('job_plan_1');
    expect(out.planId).toBeTruthy();

    // ONE job, of the SHIPPED augment kind, carrying the ACCUMULATED intent —
    // the numbered framing that tells the engine later turns REFINE earlier ones.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('augment');
    const prompt = (context as { prompt: string }).prompt;
    expect(prompt).toBe(
      buildAccumulatedIntent([
        { role: 'user', body: 'Add auth to the billing epic.' },
        { role: 'user', body: 'Keep every subtask under 3 points.' },
      ]),
    );
    expect(prompt).toContain('1. Add auth to the billing epic.');
    expect(prompt).toContain('2. Keep every subtask under 3 points.');
    expect(prompt).toMatch(/REFINE/);

    // Submit-and-return, asserted negatively: nothing streamed, nothing polled.
    expect(vi.mocked(streamJob)).not.toHaveBeenCalled();
    expect(vi.mocked(getJob)).not.toHaveBeenCalled();

    // The submission is recorded ON the thread: a `system` marker turn carrying
    // the job id, plus the stamps a resumed client re-attaches from.
    const marker = out.session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.jobId).toBe('job_plan_1');
    expect(marker.body).toBe(prompt);
    expect(out.session.lastJobId).toBe('job_plan_1');
    expect(out.session.lastSubmittedAt).toBeTruthy();

    // The proposal sink is open and bound to the job (MOTIR-1743) — and it is a
    // PLAN: the tree is untouched.
    const plan = await db.plan.findUniqueOrThrow({ where: { id: out.planId } });
    expect(plan.status).toBe('generating');
    expect(plan.sourceJobId).toBe('job_plan_1');
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    await client.close();
  });

  it('a SINGLE turn passes through verbatim — no framing is added to a one-shot change', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Split the onboarding story.',
    });

    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect((context as { prompt: string }).prompt).toBe('Split the onboarding story.');
    await client.close();
  });

  it('an ANCHORED thread submits contextually — the thread’s own scope decides', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Anchor me' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
      body: 'Re-plan this story into smaller subtasks.',
    });
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
    });

    // Still ONE job kind and one submit surface — the anchor set rides along as
    // context, and motir-ai classifies expand / augment / replan against it.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect((context as { targetKeys?: string[] }).targetKeys).toEqual([story.identifier]);
    await client.close();
  });

  it('an EMPTY thread refuses with the typed error, and fires nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PLAN_CHANGE_EMPTY_INTENT');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(await db.plan.count()).toBe(0);
    await client.close();
  });

  it('a thread that was never opened refuses with the typed not-found', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PLAN_CHANGE_SESSION_NOT_FOUND');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    await client.close();
  });

  it('a FAILED submit leaves the thread intact and opens NO orphan plan', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(submitJob).mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add the reporting epic.',
    });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    // The distinct, non-retryable code — an agent must not read this as a
    // generic outage and retry forever.
    expect(text(res)).toContain('MOTIR_AI_OUT_OF_CREDITS');
    // The plan is opened only AFTER a successful submit, so a refused job leaves
    // nothing behind…
    expect(await db.plan.count()).toBe(0);
    // …and the user's words survive: the thread is re-submittable as it stands.
    const after = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    expect(after.turns.map((t) => t.body)).toEqual(['Add the reporting epic.']);
    expect(after.lastJobId).toBeNull();
    expect(after.lastSubmittedAt).toBeNull();
    await client.close();
  });
});

describe('plan-session tools — token scope narrowing', () => {
  it('a READ-ONLY token can open a thread but can neither extend nor fire one', async () => {
    const fx = await makeWorkItemFixture();
    // Seed a turn through a full-scope client so the read-only open has
    // something to resume — and so the "no write happened" check has a baseline.
    const full = await connectClient(fx.ctx, [...TOKEN_SCOPES]);
    await call(full, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body: 'Seeded turn.' });
    await full.close();

    const readOnly = await connectClient(fx.ctx, ['read']);

    const opened = await call(readOnly, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(opened.isError).toBeFalsy();
    expect(session(opened).turnCount).toBe(1);

    for (const name of [APPEND_PLAN_TURN_TOOL_NAME, SUBMIT_PLAN_SESSION_TOOL_NAME]) {
      const denied = await call(readOnly, name, { projectKey: 'PROD', body: 'sneaky' });
      expect(denied.isError, `${name} must be scope-denied`).toBe(true);
      expect(text(denied)).toContain(SCOPE_NOT_GRANTED_CODE);
    }

    // The gate fired BEFORE the service: no second turn, no job, no plan.
    const after = await planChangeSessionsService.getOrCreateForProject(projectCtx(fx));
    expect(after.turnCount).toBe(1);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(await db.plan.count()).toBe(0);
    await readOnly.close();
  });
});
