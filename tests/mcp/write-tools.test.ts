import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { runAddComment } from '@/lib/mcp/tools/addComment';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP write tools (Subtask 7.8.5) over real Postgres. `create_work_item`,
// `transition_status`, `add_comment` — each a thin adapter over an
// already-shipped service. We assert: attribution to the token's user, the
// kind-parent matrix, the legal-vs-illegal transition (incl. the allowed-
// targets enrichment + the revision row shape), the comment mention + job
// event, and the 404-not-403 cross-tenant contract on every tool.
//
// The server is built with a fixed-context resolver (the bearer auth gate is
// tested in auth.test.ts), so these exercise the tool surface directly. Inngest
// is spied so the post-commit events never reach the network AND so the comment
// event is assertable (the commentsService.test.ts pattern).

interface CapturedEvent {
  name: string;
  data: Record<string, unknown>;
}

function captureEvents(): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      const evt = entry as { name?: string; data?: Record<string, unknown> };
      if (evt?.name && evt.data) events.push({ name: evt.name, data: evt.data });
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return events;
}

let events: CapturedEvent[];

beforeEach(async () => {
  await truncateAuthTables();
  events = captureEvents();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Add a fresh workspace member to `fx`, returning the user. */
async function addMember(fx: WorkItemFixture, email: string, name: string): Promise<User> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user;
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

describe('create_work_item', () => {
  it('creates a task via the client round-trip with the token owner as reporter', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({
      name: 'create_work_item',
      arguments: { projectKey: 'PROD', kind: 'task', title: 'Wire the MCP', priority: 'high' },
    });
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      identifier: string;
      kind: string;
      reporterId: string;
      priority: string;
      status: string;
    };
    expect(dto.kind).toBe('task');
    expect(dto.reporterId).toBe(fx.ownerId);
    expect(dto.priority).toBe('high');
    // Lands in the workflow's initial status, like any UI create.
    expect(dto.status).toBe('todo');

    // It is readable back through the tree (it actually persisted).
    const list = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(list.map((i) => i.identifier)).toContain(dto.identifier);
    await client.close();
  });

  it('logs a bug under a story with the reporter set (the bug-logging protocol)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );

    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'bug',
        title: 'It crashes on save',
        parentKey: story.identifier,
        descriptionMd: 'Steps: …',
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as { kind: string; parentId: string; reporterId: string };
    expect(dto.kind).toBe('bug');
    expect(dto.parentId).toBe(story.id);
    expect(dto.reporterId).toBe(fx.ownerId);
  });

  it('rejects an illegal kind/parent pair with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A task' },
      fx.ctx,
    );
    // A story may not be parented to a task (matrix: task → [bug, subtask]).
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'Nope', parentKey: task.identifier },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });
});

describe('transition_status', () => {
  it('makes a legal move by key AND by display name, writing the revision row', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Movable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // By status KEY.
    const res = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { status: string }).status).toBe('in_progress');

    // The revision row is shaped exactly like the board drag's (status from→to).
    const revisions = await workItemsService.listRevisions(item.id, fx.ctx);
    const statusRev = revisions.find((r) => r.diff.status)!;
    expect(statusRev.changeKind).toBe('updated');
    expect(statusRev.diff.status).toEqual({ from: 'todo', to: 'in_progress' });
    expect(statusRev.changedById).toBe(fx.ownerId);

    // By display NAME ("In Progress" is current; move to "Blocked").
    const byName = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'Blocked' },
    });
    expect(byName.isError).toBeFalsy();
    expect((byName.structuredContent as { status: string }).status).toBe('blocked');

    // The transitioned event fired (post-commit, best-effort).
    expect(events.some((e) => e.name === 'work-item/transitioned')).toBe(true);
    await client.close();
  });

  it('surfaces the allowed targets on an illegal transition', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stuck' },
      fx.ctx,
    );
    // todo → done is not a legal transition in the default (restricted) workflow.
    const res = await runTransitionStatus({ key: item.identifier, status: 'done' }, fx.ctx);
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('ILLEGAL_TRANSITION');
    // The legal targets from "To Do" are listed so the agent self-corrects.
    expect(text).toContain('in_progress');
    expect(text).toContain('blocked');
  });

  it('an unknown status surfaces UnknownStatusError', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const res = await runTransitionStatus({ key: item.identifier, status: 'nonsense' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('UNKNOWN_STATUS');
  });
});

describe('add_comment', () => {
  it('posts a comment as the token owner and fires the mention + job event', async () => {
    const fx = await makeWorkItemFixture();
    const mentionee = await addMember(fx, 'mentionee@ex.com', 'Mention Target');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Discuss me' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({
      name: 'add_comment',
      arguments: { key: item.identifier, body: `Looks good ${mentionToken(mentionee)}` },
    });
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      author: { id: string };
      mentionedUserIds: string[];
    };
    expect(dto.author.id).toBe(fx.ownerId);
    expect(dto.mentionedUserIds).toContain(mentionee.id);

    // The post-commit comment.created event fired with the parsed mention.
    const created = events.find((e) => e.name === 'work-item/comment.created');
    expect(created).toBeTruthy();
    expect(created!.data.authorId).toBe(fx.ownerId);
    expect(created!.data.mentionedUserIds).toContain(mentionee.id);
    await client.close();
  });

  it('rejects an empty comment body with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Y' },
      fx.ctx,
    );
    const res = await runAddComment({ key: item.identifier, body: '   ' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('EMPTY_COMMENT_BODY');
  });
});

describe('cross-tenant — every write tool is 404-not-403', () => {
  it('a non-member context cannot create / transition / comment on another tenant', async () => {
    const a = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'Tenant A secret' },
      a.ctx,
    );
    // A second, independent tenant whose context will probe tenant A's project.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    const create = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'sneaky' },
      b.ctx,
    );
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('PROJECT_NOT_FOUND');

    const move = await runTransitionStatus({ key: item.identifier, status: 'in_progress' }, b.ctx);
    expect(move.isError).toBe(true);
    expect(JSON.stringify(move.content)).toContain('PROJECT_NOT_FOUND');

    const comment = await runAddComment({ key: item.identifier, body: 'hi' }, b.ctx);
    expect(comment.isError).toBe(true);
    expect(JSON.stringify(comment.content)).toContain('PROJECT_NOT_FOUND');
  });
});
