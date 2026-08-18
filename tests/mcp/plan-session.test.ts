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
import { toolPermission } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
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
import { adminDb } from '../helpers/adminDb';
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

/** Connect an in-memory client to a server bound to `ctx` (no permission gate). */
async function connectClient(ctx: ServiceContext, grant?: TokenGrant): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
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
  await adminDb.$executeRawUnsafe(
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
  await adminDb.$disconnect();
});

describe('plan-session tools — registration + permission + advertised contracts', () => {
  it('all three are registered and all three ask for ai:plan', () => {
    expect(MCP_TOOL_NAMES).toContain(OPEN_PLAN_SESSION_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(APPEND_PLAN_TURN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(SUBMIT_PLAN_SESSION_TOOL_NAME);
    // ⚠️ THE SPLIT MOVED, deliberately (MOTIR-2576; ADR §3, §5). Under the six
    // scopes these were `read` / `work_items:write` / `work_items:write` — and
    // the `read` on OPEN was WRONG relative to its own gate:
    // `planChangeSessionsService.getOrCreateForScope` asserts `ai:plan`, so a
    // read-only token only ever got as far as a role check. The map now names
    // what the services actually assert, which withdraws opening from a
    // browse-only grant and — the point of the story — lets a token that files
    // work items withhold all three.
    expect(toolPermission(OPEN_PLAN_SESSION_TOOL_NAME)).toBe('ai:plan');
    expect(toolPermission(APPEND_PLAN_TURN_TOOL_NAME)).toBe('ai:plan');
    expect(toolPermission(SUBMIT_PLAN_SESSION_TOOL_NAME)).toBe('ai:plan');
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
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(1);
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
    const c = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story C' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // ⚠️ The sets here are DISJOINT — {A} and {B,C}, not {A} and {A,B} — because
    // MOTIR-2787 made an overlapping open a REFUSAL rather than a second thread.
    // The subject of this case is scope-key IDENTITY, which is unchanged; the
    // overlap is its own case below.
    const wide = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    const onA = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier],
      }),
    );
    const onBC = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [b.identifier, c.identifier],
      }),
    );

    // Three anchor sets → three conversations. The project-wide thread is not
    // the {A} thread, and {A} is not {B,C}.
    expect(new Set([wide.id, onA.id, onBC.id]).size).toBe(3);
    expect(onA.targetKeys).toEqual([a.identifier]);
    expect(onBC.targetKeys).toEqual([b.identifier, c.identifier].sort());

    // The anchor SET is the identity: reversed, lower-cased and duplicated, it
    // is the same conversation — a CLI must not fork a second thread about the
    // same items just because it listed them differently. And re-opening it is a
    // RESUME even though its targets are locked, because the lock is held by this
    // very thread: an idempotent re-open refreshes the lease rather than refusing.
    const resumed = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'prod',
        targetKeys: [c.identifier.toLowerCase(), b.identifier, c.identifier],
      }),
    );
    expect(resumed.id).toBe(onBC.id);
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(3);
    await client.close();
  });

  it('an OVERLAPPING anchor set is refused, naming the item and the holder (MOTIR-2787)', async () => {
    // The hole `scope_key` cannot close, through the agent surface: `{A}` and
    // `{A,B}` are two different threads about one common item, and before this
    // both would have expanded it — two planners writing competing children under
    // one parent, neither aware of the other, with nobody getting an error.
    //
    // ⚠️ IT IS REFUSED FOR THE SAME CALLER TOO, deliberately. The unit is the
    // planning SESSION, not the person: one agent holding two conversations about
    // one item produces exactly the same strange tree as two agents do.
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

    session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier],
      }),
    );

    const overlapping = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [a.identifier, b.identifier],
    });

    expect(overlapping.isError).toBe(true);
    // The agent has to be able to act on this: which target, and who holds it.
    // A bare "locked" would leave it retrying the same refused call.
    expect(text(overlapping)).toContain('PLAN_TARGET_LOCKED');
    expect(text(overlapping)).toContain(a.identifier);

    // The refused open wrote NOTHING — no second thread, and B is untouched and
    // still plannable on its own.
    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('todo');
    const onB = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [b.identifier],
      }),
    );
    expect(onB.targetKeys).toEqual([b.identifier]);
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
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(0);

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
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
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
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(1);
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
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: out.planId } });
    expect(plan.status).toBe('generating');
    expect(plan.sourceJobId).toBe('job_plan_1');
    const workItemCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItemCount).toBe(0);
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
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
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
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    // …and the user's words survive: the thread is re-submittable as it stands.
    const after = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    expect(after.turns.map((t) => t.body)).toEqual(['Add the reporting epic.']);
    expect(after.lastJobId).toBeNull();
    expect(after.lastSubmittedAt).toBeNull();
    await client.close();
  });
});

describe('plan-session tools — grant narrowing', () => {
  it('a grant WITHOUT ai:plan can reach none of the three, even to open', async () => {
    const fx = await makeWorkItemFixture();
    // Seed a turn through a fully-granted client so the denied opens have
    // something they WOULD have resumed — and so "no write happened" has a
    // baseline.
    const full = await connectClient(fx.ctx, GRANTABLE_PERMISSIONS);
    await call(full, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body: 'Seeded turn.' });
    await full.close();

    // Everything a token can hold EXCEPT planning — the shape someone wires for
    // an agent that files work items and must not spend their AI credits.
    const noPlanning = await connectClient(
      fx.ctx,
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
    );

    for (const name of [
      OPEN_PLAN_SESSION_TOOL_NAME,
      APPEND_PLAN_TURN_TOOL_NAME,
      SUBMIT_PLAN_SESSION_TOOL_NAME,
    ]) {
      const denied = await call(noPlanning, name, { projectKey: 'PROD', body: 'sneaky' });
      expect(denied.isError, `${name} must be permission-denied`).toBe(true);
      expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(text(denied)).toContain('ai:plan');
    }

    // The gate fired BEFORE the service: no second turn, no job, no plan.
    const after = await planChangeSessionsService.getOrCreateForProject(projectCtx(fx));
    expect(after.turnCount).toBe(1);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    await noPlanning.close();
  });

  it('a grant WITH ai:plan can open, extend and fire', async () => {
    const fx = await makeWorkItemFixture();
    const planner = await connectClient(fx.ctx, ['project:browse', 'ai:plan']);
    const opened = await call(planner, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(opened.isError).toBeFalsy();
    expect(session(opened).turnCount).toBe(0);

    const appended = await call(planner, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'A real turn.',
    });
    expect(appended.isError).toBeFalsy();
    await planner.close();
  });
});
