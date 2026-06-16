import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Branch-coverage companion to story-roundtrip.test.ts (Subtask 7.7.12). The
// round-trip suite proves the surface end-to-end over the real transport; THIS
// file walks the per-tool summary / optional-arg / edge branches that the
// happy-path round-trip doesn't reach, so the whole `lib/mcp/tools/**` + the
// registry clear the per-file ≥90% coverage gate this story extends to them.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern) — no scope gate, so the tool LOGIC is exercised in
// isolation from the separately-tested 7.7.17 scope narrowing.

/** Connect an in-memory client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-coverage', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call a tool, swallowing a transport-level rejection into an error result so
 * a branch that runs BEFORE a throw is still exercised without aborting. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err) }] };
  }
}

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const LONG = 'x'.repeat(900); // > the 500/800/280 excerpt thresholds

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('MCP tool branch coverage', () => {
  it('get_work_item — summarizes a parented, blocked, long-description item; a dashless key resolves', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Child',
        parentId: story.id,
        descriptionMd: LONG,
      },
      fx.ctx,
    );
    // A real is_blocked_by edge so readiness reads "blocked by …".
    await workItemsService.linkWorkItems(
      { fromId: child.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'get_work_item', { key: child.identifier });
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res.content);
    expect(text).toContain('Parent:');
    expect(text).toContain('blocked by');
    expect(text).toContain('…'); // description excerpt was truncated

    // A dashless key exercises projectKeyOf's no-dash branch (then not-found).
    const dashless = await call(client, 'get_work_item', { key: 'PROD' });
    expect(dashless.isError).toBe(true);
    await client.close();
  });

  it('next_ready — dispatches a parented, long-description item; the unassigned filter + empty set resolve', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ready child',
        parentId: story.id,
        descriptionMd: LONG,
      },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // unassigned filter → normalizeAssigneeId's null branch (readyFilters).
    const next = await call(client, 'next_ready', {
      projectKey: 'PROD',
      assigneeId: 'unassigned',
    });
    const item = struct(next).item as { parentKey?: string };
    expect(item.parentKey).toBeTruthy(); // the dispatched item carries its parent
    expect(JSON.stringify(next.content)).toContain('…'); // long description truncated

    // exclude every candidate → the "no ready items" branch.
    const drained = await call(client, 'next_ready', {
      projectKey: 'PROD',
      excludeIds: (await workItemsService.listReady(fx.projectId, {}, fx.ctx)).items.map(
        (i) => i.id,
      ),
    });
    expect(struct(drained).item).toBeNull();
    await client.close();
  });

  it('list_ready — an empty project shows the empty header; a small page exposes a cursor footer', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    // No items yet → the "No ready work items match." header branch.
    const empty = await call(client, 'list_ready', { projectKey: 'PROD' });
    expect(JSON.stringify(empty.content)).toContain('No ready work items');

    // Two ready items, page size 1 → a nextCursor + the "More available" footer.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'one' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'two' },
      fx.ctx,
    );
    const paged = await call(client, 'list_ready', { projectKey: 'PROD', limit: 1 });
    expect(struct(paged).nextCursor).toBeTruthy();
    expect(JSON.stringify(paged.content)).toContain('More available');
    await client.close();
  });

  it('update_work_item — patches every optional field, and a no-field call summarizes "nothing"', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Editable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const full = await call(client, 'update_work_item', {
      key: item.identifier,
      title: 'New title',
      descriptionMd: 'desc',
      explanationMd: 'why',
      priority: 'high',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      assigneeId: fx.ownerId,
      dueDate: '2030-01-01',
    });
    expect(full.isError).toBeFalsy();

    // No patchable field supplied → summary reads "Patched: nothing".
    const none = await call(client, 'update_work_item', { key: item.identifier });
    expect(JSON.stringify(none.content)).toContain('nothing');
    await client.close();
  });

  it('add_comment — a >280-char body is excerpted in the summary', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Commentable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'add_comment', { key: item.identifier, body: LONG });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain('…');
    await client.close();
  });

  it('transition_status — a no-op (same status) and an illegal move (enriched with legal targets)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Movable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // no-op: transition to the status it already holds (todo → todo).
    const noop = await call(client, 'transition_status', { key: item.identifier, status: 'todo' });
    expect(JSON.stringify(noop.content)).toContain('no-op');

    // illegal: the default workflow has no direct todo → done edge; the tool
    // enriches the error with the legal targets (the restricted-policy branch).
    const illegal = await call(client, 'transition_status', {
      key: item.identifier,
      status: 'done',
    });
    expect(illegal.isError).toBe(true);
    expect(JSON.stringify(illegal.content)).toContain('Allowed targets');
    await client.close();
  });

  it('delete_work_item — a LEAF deletes with no cascade phrase', async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Lonely' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'delete_work_item', { key: leaf.identifier });
    expect(res.isError).toBeFalsy();
    expect((struct(res) as { descendantCount: number }).descendantCount).toBe(0);
    expect(JSON.stringify(res.content)).not.toContain('descendant');
    await client.close();
  });

  it('complete_session — completed, then already-done, then an empty branch', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'On a branch' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // Put the item onto a session branch (in_review + session_branch). The
    // default workflow has no todo → in_review edge, so move it in_progress
    // first, then integrate.
    await call(client, 'transition_status', { key: item.identifier, status: 'in_progress' });
    const integrated = await call(client, 'mark_integrated', {
      key: item.identifier,
      sessionBranch: 'sess/a',
    });
    expect(integrated.isError).toBeFalsy();

    // First complete → the item finishes (counts.completed).
    const first = await call(client, 'complete_session', { sessionBranch: 'sess/a' });
    expect(first.isError).toBeFalsy();
    expect(JSON.stringify(first.content)).toContain('done');

    // Reaching done clears the branch, so a re-complete finds nothing on it.
    const second = await call(client, 'complete_session', { sessionBranch: 'sess/a' });
    expect(second.isError).toBeFalsy();

    // A never-used branch → the "no work items recorded" summary.
    const empty = await call(client, 'complete_session', { sessionBranch: 'sess/never' });
    expect(JSON.stringify(empty.content)).toContain('No work items');
    await client.close();
  });

  it('sprint helpers — goal + window + completed summaries; bulk-move success and empty; list empty', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Sprintable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // Empty list first (no sprints yet) — the "No sprints" branch.
    const emptyList = await call(client, 'list_sprints', { projectKey: 'PROD' });
    expect(JSON.stringify(emptyList.content)).toContain('No sprints');

    // create with goal + window → summarizeSprint's goal + window branches.
    const created = await call(client, 'create_sprint', {
      projectKey: 'PROD',
      name: 'Sprint G',
      goal: 'Ship it',
      startDate: '2030-01-01',
      endDate: '2030-01-14',
    });
    const sprintId = (struct(created) as { id: string }).id;
    const listed = await call(client, 'list_sprints', { projectKey: 'PROD' });
    expect(JSON.stringify(listed.content)).toContain('goal: Ship it');

    // update_sprint success summary.
    const updated = await call(client, 'update_sprint', { sprintId, name: 'Sprint G2' });
    expect(updated.isError).toBeFalsy();

    // move_to_sprint then move_to_backlog (the resolve + bulk-move paths).
    await call(client, 'move_to_sprint', { keys: [item.identifier], sprintId });
    const back = await call(client, 'move_to_backlog', { keys: [item.identifier] });
    expect(back.isError).toBeFalsy();

    // A second planned sprint to receive carry-over, then complete with the
    // {sprintId} disposition (not "backlog") + assert the completed summary.
    const target = await call(client, 'create_sprint', { projectKey: 'PROD', name: 'Next' });
    const targetId = (struct(target) as { id: string }).id;
    await call(client, 'move_to_sprint', { keys: [item.identifier], sprintId });
    await call(client, 'start_sprint', { sprintId });
    const completed = await call(client, 'complete_sprint', {
      sprintId,
      carryOverTo: { sprintId: targetId },
    });
    expect((struct(completed) as { state: string }).state).toBe('complete');
    expect(JSON.stringify(completed.content)).toContain('completed:');

    // delete_sprint success summary (delete the still-planned target).
    const deleted = await call(client, 'delete_sprint', { sprintId: targetId });
    expect(deleted.isError).toBeFalsy();
    await client.close();
  });

  it('delete_work_item — a parent with multiple descendants pluralizes the cascade phrase', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent' },
      fx.ctx,
    );
    for (const t of ['c1', 'c2']) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: t, parentId: story.id },
        fx.ctx,
      );
    }
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'delete_work_item', { key: story.identifier });
    expect(res.isError).toBeFalsy();
    expect((struct(res) as { descendantCount: number }).descendantCount).toBe(2);
    expect(JSON.stringify(res.content)).toContain('2 tasks'); // pluralized
    await client.close();
  });

  it('complete_session — a branch with completed + already-done + failed items yields all three outcomes', async () => {
    const fx = await makeWorkItemFixture();
    const branch = 'sess/multi';
    // Craft three items directly onto the branch in three statuses: in_review
    // (→ completed by done), done (→ already_done, a no-op), and todo (→ failed,
    // since the default workflow forbids a direct todo → done move).
    const mk = async (title: string, status: string) => {
      const dto = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      );
      await db.workItem.update({
        where: { id: dto.id },
        data: { status, sessionBranch: branch },
      });
      return dto.identifier;
    };
    await mk('to complete', 'in_review');
    await mk('already done', 'done');
    await mk('cannot move', 'todo');

    const client = await connectClient(fx.ctx);
    const res = await call(client, 'complete_session', { sessionBranch: branch });
    expect(res.isError).toBeFalsy();
    const outcomes = (struct(res).results as { outcome: string }[]).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['already_done', 'completed', 'failed']);
    // The summary reports the already-done + failed counts and a failure detail.
    const text = JSON.stringify(res.content);
    expect(text).toContain('already done');
    expect(text).toContain('failed');
    await client.close();
  });

  it('whoami — degrades gracefully when the active workspace is unresolvable, and errors on a missing user', async () => {
    const fx = await makeWorkItemFixture();

    // Valid user, BOGUS workspace id → getWorkspaceSummary returns null → the
    // no-workspace text branch.
    const noWs = await connectClient({ userId: fx.ownerId, workspaceId: 'ws_does_not_exist' });
    const res = await call(noWs, 'whoami', {});
    expect(res.isError).toBeFalsy();
    expect(struct(res).workspace).toBeNull();
    await noWs.close();

    // Unknown user → WhoamiUserMissingError → a clean tool error.
    const noUser = await connectClient({
      userId: 'user_does_not_exist',
      workspaceId: fx.workspaceId,
    });
    const missing = await call(noUser, 'whoami', {});
    expect(missing.isError).toBe(true);
    await noUser.close();
  });
});
