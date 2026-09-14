import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Plan proposals may NAME A FOLDER (Story MOTIR-5310 · Subtask MOTIR-5414), over
// the real MCP server and a real Postgres.
//
// What the card asks this file to prove, and where:
//   1  an `add` with `parentRef: folder:<id>` appends, and `get_plan` returns it
//      verbatim                                              → 'add_plan_items'
//   2  refused AT THE APPEND, naming the ref: an unknown folder, another
//      project's folder, a folder in `blockedByRefs` — and nothing is appended
//                                                            → 'refusals'
//   3  a filed `subtask` appends; the same subtask at the root does not → 'subtask'
//   4  a `modify` filing a committed item appends; `update_plan_proposal` re-points
//      an `add` work item → folder → work item, re-validated each time
//                                                            → 'modify + correction'
// The internal route motir-ai calls is `tests/integration/ai/planProposalFolderRefs.test.ts`.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'author-plan-folders', version: '0.0.0' });
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

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const result = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A plan that files work into folders',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  return struct(result).id;
}

function folder(fx: WorkItemFixture, name: string) {
  return foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name },
    fx.ctx,
  );
}

async function foreignFolder(fx: WorkItemFixture) {
  const other = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ctx.userId,
    name: 'Second project',
    identifier: 'SECND',
  });
  return foldersService.createFolder(
    { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
    fx.ctx,
  );
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — an `add` filed into a folder', () => {
  it('appends, stores the ref verbatim, and get_plan returns it verbatim', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await folder(fx, 'Backlog ideas');
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Parked story', kind: 'story' },
          parentRef: `folder:${backlog.id}`,
        },
      ],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const [itemId] = ids(appended);

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.parentRef).toBe(`folder:${backlog.id}`);

    const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
    expect(read.isError, text(read)).toBeFalsy();
    expect(struct(read).items.find((i) => i.id === itemId)?.parentRef).toBe(`folder:${backlog.id}`);

    // …and the close accepts it: the persist gate resolves folders too.
    const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [],
      final: true,
    });
    expect(closed.isError, text(closed)).toBeFalsy();
    expect(struct(closed).status).toBe('planned');
    await client.close();
  });
});

describe('add_plan_items — refused at the append, naming the ref', () => {
  it('an unknown folder id → INVALID_PLAN_REF_GRAPH, nothing appended', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Nowhere' },
          parentRef: 'folder:fold_does_not_exist',
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('folder:fold_does_not_exist');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it("another project's folder → PLAN_GRAMMAR_VIOLATION naming the folder", async () => {
    const fx = await makeWorkItemFixture();
    const elsewhere = await foreignFolder(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Wrong project' },
          parentRef: `folder:${elsewhere.id}`,
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('PLAN_GRAMMAR_VIOLATION');
    expect(text(refused)).toContain(`folder:${elsewhere.id}`);
    expect(text(refused)).toContain('Elsewhere');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('a `folder:` ref in blockedByRefs → INVALID_PLAN_REF_GRAPH, nothing appended', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await folder(fx, 'Backlog ideas');
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Blocked by a folder?' },
          blockedByRefs: [`folder:${backlog.id}`],
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('blockedByRefs');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('a blank `folder:` ref → INVALID_PROPOSAL', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Blank' }, parentRef: 'folder:' }],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PROPOSAL');
    await client.close();
  });
});

describe('a filed `subtask`', () => {
  it('appends under a folder; the same subtask at the root is refused at the close', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await folder(fx, 'Backlog ideas');
    const client = await connectClient(fx.ctx);

    const filedPlan = await openPlan(client, fx);
    const filed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId: filedPlan,
      final: true,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Filed subtask', kind: 'subtask' },
          parentRef: `folder:${backlog.id}`,
        },
      ],
    });
    expect(filed.isError, text(filed)).toBeFalsy();
    expect(struct(filed).status).toBe('planned');

    const rootPlan = await openPlan(client, fx);
    const root = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId: rootPlan,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Root subtask', kind: 'subtask' } }],
    });
    expect(root.isError).toBe(true);
    expect(text(root)).toContain('PLAN_GRAMMAR_VIOLATION');
    await client.close();
  });
});

describe('modify + correction', () => {
  it('a `modify` whose patch.parentRef files a committed item appends; an unknown folder does not', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await folder(fx, 'Backlog ideas');
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'An epic to park' });
    const other = await createTestWorkItem(fx, { kind: 'epic', title: 'Another epic' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const ok = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: epic.id, patch: { parentRef: `folder:${backlog.id}` } },
      ],
    });
    expect(ok.isError, text(ok)).toBeFalsy();
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids(ok)[0] } });
    expect((row.patch as { parentRef?: string }).parentRef).toBe(`folder:${backlog.id}`);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: other.id, patch: { parentRef: 'folder:fold_gone' } }],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
    await client.close();
  });

  it('update_plan_proposal re-points an `add` work item → folder → work item, re-validated each time', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await folder(fx, 'Backlog ideas');
    const elsewhere = await foreignFolder(fx);
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Home epic' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Movable story', kind: 'story' },
          parentRef: epic.id,
        },
      ],
    });
    const [itemId] = ids(appended);
    const stored = async () =>
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).parentRef;

    const toFolder = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      parentRef: `folder:${backlog.id}`,
    });
    expect(toFolder.isError, text(toFolder)).toBeFalsy();
    expect(await stored()).toBe(`folder:${backlog.id}`);

    // Re-validated: another project's folder and an unknown one are refused, and
    // the stored ref is left exactly as it was.
    const foreign = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      parentRef: `folder:${elsewhere.id}`,
    });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain('PLAN_GRAMMAR_VIOLATION');
    const unknown = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      parentRef: 'folder:fold_gone',
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(await stored()).toBe(`folder:${backlog.id}`);

    // …and back to a work item, by KEY — the adapter still resolves keys.
    const back = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      parentRef: epic.identifier,
    });
    expect(back.isError, text(back)).toBeFalsy();
    expect(await stored()).toBe(epic.id);
    await client.close();
  });
});
