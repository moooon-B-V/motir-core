import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { SprintValidityDto } from '@/lib/dto/sprints';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `validate_sprint` (Subtask 7.8.15) over real Postgres — the read that reports
// whether a sprint is FINISHABLE (the productized re-validate-the-active-sprint
// rule, plan-rules.md #94). We assert the validity engine
// (`sprintsService.validateSprint`) directly for the rule's branches — empty /
// all-satisfied / direct violation / parent-cascade / transitive / cross-project
// blocker / active-default vs explicit id / the two typed errors — and then the
// MCP tool round-trip + summary branches through the in-memory client.

beforeEach(async () => {
  await truncateAuthTables();
  // Keep hermetic: startSprint fires best-effort post-commit job events.
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] as string[] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'validate-sprint', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const mk = (
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  title: string,
  parentId?: string,
) =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: parentId ? 'subtask' : 'task', title, parentId },
    fx.ctx,
  );

const link = (fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const putInSprint = (id: string, sprintId: string) =>
  db.workItem.update({ where: { id }, data: { sprintId } });

const markDone = (id: string) => db.workItem.update({ where: { id }, data: { status: 'done' } });

async function planSprint(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  name = 'S1',
): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name }, fx.ctx);
  return sprint.id;
}

describe('sprintsService.validateSprint — the finishability rule', () => {
  it('an empty sprint is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result).toEqual({ sprintId, valid: true, blockers: [] });
  });

  it('a sprint whose blockers are all DONE or IN-SPRINT is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const a = await mk(fx, 'A');
    const inSprintBlocker = await mk(fx, 'C in sprint');
    const doneBlocker = await mk(fx, 'B done out of sprint');
    await putInSprint(a.id, sprintId);
    await putInSprint(inSprintBlocker.id, sprintId);
    await markDone(doneBlocker.id);
    // A is gated by a DONE out-of-sprint item and an IN-SPRINT (not-done) item —
    // both satisfy the rule, so the sprint is finishable.
    await link(fx, a.id, doneBlocker.id);
    await link(fx, a.id, inSprintBlocker.id);

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('an in-sprint item blocked_by a not-done OUT-OF-SPRINT item is INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const a = await mk(fx, 'A');
    const blocker = await mk(fx, 'B'); // stays in the backlog, status todo
    await putInSprint(a.id, sprintId);
    await link(fx, a.id, blocker.id);

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual([
      {
        item: a.identifier,
        blockedBy: blocker.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DONE in-sprint item needs no check; a finished sprint is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const a = await mk(fx, 'A done');
    const blocker = await mk(fx, 'B out of sprint todo');
    await putInSprint(a.id, sprintId);
    await link(fx, a.id, blocker.id);
    await markDone(a.id); // A is done — its open blocker no longer gates the sprint

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('PARENT CASCADE — an in-sprint subtask whose out-of-sprint parent is blocked is INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story (not in sprint)' },
      fx.ctx,
    );
    const child = await mk(fx, 'Child subtask', story.id);
    const blocker = await mk(fx, 'Foundation B'); // out of sprint, todo
    await putInSprint(child.id, sprintId); // only the child is in the sprint
    await link(fx, story.id, blocker.id); // the PARENT is blocked

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(false);
    // The violation is attributed to the in-sprint child (gated via its parent).
    expect(result.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: blocker.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('TRANSITIVE (multi-hop) — an in-sprint blocker chained to out-of-sprint not-done work is INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const a = await mk(fx, 'A');
    const b = await mk(fx, 'B (in sprint)');
    const c = await mk(fx, 'C (out of sprint, todo)');
    await putInSprint(a.id, sprintId);
    await putInSprint(b.id, sprintId);
    await link(fx, a.id, b.id); // A blocked_by B (in sprint → satisfied for A)
    await link(fx, b.id, c.id); // B blocked_by C (out of sprint → violation at B)

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(false);
    // A is satisfied (its blocker B is in-sprint); the chain surfaces at B → C.
    expect(result.blockers).toEqual([
      {
        item: b.identifier,
        blockedBy: c.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a blocker in ANOTHER sprint (not done) is reported with that sprint id', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx, 'S1');
    const otherSprintId = await planSprint(fx, 'S2');
    const a = await mk(fx, 'A');
    const blocker = await mk(fx, 'B in S2');
    await putInSprint(a.id, sprintId);
    await putInSprint(blocker.id, otherSprintId);
    await link(fx, a.id, blocker.id);

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(false);
    expect(result.blockers[0]).toMatchObject({
      item: a.identifier,
      blockedBy: blocker.identifier,
      blockerSprintId: otherSprintId,
    });
  });

  it('an ARCHIVED blocker never gates the sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const a = await mk(fx, 'A');
    const blocker = await mk(fx, 'B archived');
    await putInSprint(a.id, sprintId);
    await link(fx, a.id, blocker.id);
    await db.workItem.update({ where: { id: blocker.id }, data: { archivedAt: new Date() } });

    const result = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('null sprintId validates the ACTIVE sprint; an explicit id validates that one', async () => {
    const fx = await makeWorkItemFixture();
    const activeId = await planSprint(fx, 'Active');
    const plannedId = await planSprint(fx, 'Planned');
    await sprintsService.startSprint(activeId, {}, fx.ctx);

    const byDefault = await sprintsService.validateSprint(fx.projectId, null, fx.ctx);
    expect(byDefault.sprintId).toBe(activeId);
    expect(byDefault.valid).toBe(true);

    const explicit = await sprintsService.validateSprint(fx.projectId, plannedId, fx.ctx);
    expect(explicit.sprintId).toBe(plannedId);
  });

  it('no active sprint + no arg → NoActiveSprintError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(sprintsService.validateSprint(fx.projectId, null, fx.ctx)).rejects.toMatchObject({
      code: 'NO_ACTIVE_SPRINT',
    });
  });

  it('an unknown sprintId → SprintNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      sprintsService.validateSprint(fx.projectId, 'sprint_does_not_exist', fx.ctx),
    ).rejects.toMatchObject({ code: 'SPRINT_NOT_FOUND' });
  });
});

describe('workItemLinkRepository.findBlockerEdgesForItems', () => {
  it('short-circuits on an empty id set', async () => {
    expect(await workItemLinkRepository.findBlockerEdgesForItems([])).toEqual([]);
  });
});

describe('validate_sprint MCP tool round-trip', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as SprintValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('reports a VALID sprint via the client (lowercase key resolves)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx);
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_sprint',
      arguments: { projectKey: 'prod', sprintId },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(struct(res).valid).toBe(true);
    expect(text(res)).toContain('is VALID');
    await client.close();
  });

  it('reports an INVALID sprint with a backlog blocker and a cross-sprint blocker', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await planSprint(fx, 'S1');
    const otherSprintId = await planSprint(fx, 'S2');
    const a = await mk(fx, 'A');
    const backlogBlocker = await mk(fx, 'Backlog blocker');
    const otherSprintBlocker = await mk(fx, 'Other-sprint blocker');
    await putInSprint(a.id, sprintId);
    await putInSprint(otherSprintBlocker.id, otherSprintId);
    await link(fx, a.id, backlogBlocker.id);
    await link(fx, a.id, otherSprintBlocker.id);

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_sprint',
      arguments: { projectKey: 'PROD', sprintId },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(struct(res).valid).toBe(false);
    expect(struct(res).blockers).toHaveLength(2);
    // Both the "backlog" and the "sprint <id>" summary branches render.
    expect(text(res)).toContain('is INVALID');
    expect(text(res)).toContain('backlog');
    expect(text(res)).toContain(`sprint ${otherSprintId}`);
    await client.close();
  });

  it('validates the active sprint when sprintId is omitted', async () => {
    const fx = await makeWorkItemFixture();
    const activeId = await planSprint(fx, 'Active');
    await sprintsService.startSprint(activeId, {}, fx.ctx);
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_sprint',
      arguments: { projectKey: 'PROD' },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(struct(res).sprintId).toBe(activeId);
    await client.close();
  });

  it('surfaces NO_ACTIVE_SPRINT as a clean tool error (no active sprint, no id)', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_sprint',
      arguments: { projectKey: 'PROD' },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NO_ACTIVE_SPRINT');
    await client.close();
  });
});
