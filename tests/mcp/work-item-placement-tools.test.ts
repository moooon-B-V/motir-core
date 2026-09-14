import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runMoveToParent } from '@/lib/mcp/tools/moveToParent';
import { describePlacement } from '@/lib/mcp/tools/placement';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// MCP work-item PLACEMENT (Story MOTIR-5310 · MOTIR-5413) over real Postgres,
// driven through `buildMcpServer` + an in-memory client — the
// `move-to-parent.test.ts` pattern. `create_work_item` and `move_to_parent` place
// an item into a folder through the service's own doors, and `get_work_item`
// DECLARES the item's own placement as `folderId` + `folderPath`. This asserts
// the adapter half: every placement a write reports agrees with a following read,
// every folder refusal surfaces as a TYPED tool error naming its code, and the
// read carries exactly the two declared folder fields and no other.

beforeEach(async () => {
  await truncateAuthTables();
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function structured<T>(res: unknown): T {
  return (res as CallToolResult).structuredContent as T;
}

function expectToolError(res: unknown, code: string): void {
  expect((res as CallToolResult).isError).toBe(true);
  expect(textOf(res)).toContain(`${code}:`);
}

interface Placement {
  parentKey: string | null;
  folderId: string | null;
  folderPath: string[] | null;
}

interface PlacedWrite {
  identifier: string;
  parentId: string | null;
  placement: Placement;
}

interface DetailRead {
  folderId: string | null;
  folderPath: string[] | null;
  item: Record<string, unknown>;
  parent: { identifier: string } | null;
}

/** `Parked ▸ 2025` in PROD, and the id of each level. */
async function parkedTree(fx: WorkItemFixture) {
  const parked = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
    fx.ctx,
  );
  const year = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: parked.id, name: '2025' },
    fx.ctx,
  );
  return { parked, year };
}

function make(
  fx: WorkItemFixture,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

async function otherProjectFolder(fx: WorkItemFixture) {
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

async function read(client: Client, key: string) {
  const res = await client.callTool({ name: 'get_work_item', arguments: { key } });
  expect(res.isError, textOf(res)).toBeFalsy();
  return { res, detail: structured<DetailRead>(res) };
}

describe('create_work_item files into a folder', () => {
  it('creates an item filed, and get_work_item declares its folderId, folderPath and Folder line', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { year } = await parkedTree(fx);

    const res = await client.callTool({
      name: 'create_work_item',
      arguments: { projectKey: 'PROD', kind: 'story', title: 'Parked story', folderId: year.id },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const created = structured<PlacedWrite>(res);
    expect(created.parentId).toBeNull();
    expect(created.placement).toEqual({
      parentKey: null,
      folderId: year.id,
      folderPath: ['Parked', '2025'],
    });
    expect(textOf(res)).toContain('Placed in folder Parked ▸ 2025');

    const { res: got, detail } = await read(client, created.identifier);
    expect(detail.folderId).toBe(year.id);
    expect(detail.folderPath).toEqual(['Parked', '2025']);
    expect(textOf(got)).toContain('Folder: Parked ▸ 2025');
    await client.close();
  });

  it('files a SUBTASK — a folder satisfies its must-have-a-parent rule', async () => {
    const fx = await makeWorkItemFixture();
    const { parked } = await parkedTree(fx);
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: 'create_work_item',
      arguments: { projectKey: 'PROD', kind: 'subtask', title: 'Filed sub', folderId: parked.id },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<PlacedWrite>(res).placement.folderPath).toEqual(['Parked']);
    await client.close();
  });

  it('a parented create reports its parent and no folder', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, 'epic', 'Epic');
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: 'create_work_item',
      arguments: { projectKey: 'PROD', kind: 'story', title: 'Child', parentKey: epic.identifier },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<PlacedWrite>(res).placement).toEqual({
      parentKey: epic.identifier,
      folderId: null,
      folderPath: null,
    });
    expect(textOf(res)).toContain(`Placed under ${epic.identifier}`);
    await client.close();
  });

  it('refuses a parent AND a folder, an unknown folder and another project’s folder — typed', async () => {
    const fx = await makeWorkItemFixture();
    const { parked } = await parkedTree(fx);
    const epic = await make(fx, 'epic', 'Epic');
    const elsewhere = await otherProjectFolder(fx);
    const client = await connectClient(fx.ctx);
    const base = { projectKey: 'PROD', kind: 'story', title: 'Nope' };

    expectToolError(
      await client.callTool({
        name: 'create_work_item',
        arguments: { ...base, parentKey: epic.identifier, folderId: parked.id },
      }),
      'PLACEMENT_CONFLICT',
    );
    expectToolError(
      await client.callTool({
        name: 'create_work_item',
        arguments: { ...base, folderId: 'cm-no-such-folder' },
      }),
      'FOLDER_NOT_FOUND',
    );
    expectToolError(
      await client.callTool({
        name: 'create_work_item',
        arguments: { ...base, folderId: elsewhere.id },
      }),
      'CROSS_PROJECT_FOLDER',
    );
    // None of the three wrote a row: the project holds only the epic.
    const list = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(list.map((w) => w.title)).toEqual(['Epic']);
    await client.close();
  });
});

describe('move_to_parent places into and out of folders', () => {
  it('files, unfiles and re-parents — each placement agrees with a following get_work_item', async () => {
    const fx = await makeWorkItemFixture();
    const { year } = await parkedTree(fx);
    const epic = await make(fx, 'epic', 'Epic');
    const story = await make(fx, 'story', 'Story', epic.id);
    const client = await connectClient(fx.ctx);

    // { folderId } files it — the work-item parent is cleared.
    const filed = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: story.identifier, folderId: year.id },
    });
    expect(filed.isError, textOf(filed)).toBeFalsy();
    const filedOut = structured<PlacedWrite>(filed);
    expect(filedOut.parentId).toBeNull();
    expect(filedOut.placement).toEqual({
      parentKey: null,
      folderId: year.id,
      folderPath: ['Parked', '2025'],
    });
    expect(textOf(filed)).toContain('in folder Parked ▸ 2025');
    let { detail } = await read(client, story.identifier);
    expect([detail.folderId, detail.folderPath]).toEqual([year.id, ['Parked', '2025']]);
    expect(detail.parent).toBeNull();

    // { parentKey: null } on a filed item keeps the folder.
    const promoted = await runMoveToParent({ key: story.identifier, parentKey: null }, fx.ctx);
    expect(promoted.isError, textOf(promoted)).toBeFalsy();
    expect(structured<PlacedWrite>(promoted).placement.folderId).toBe(year.id);

    // { parentKey } on a filed item puts it under the parent and out of the folder.
    const reparented = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: story.identifier, parentKey: epic.identifier },
    });
    expect(reparented.isError, textOf(reparented)).toBeFalsy();
    expect(structured<PlacedWrite>(reparented).placement).toEqual({
      parentKey: epic.identifier,
      folderId: null,
      folderPath: null,
    });
    ({ detail } = await read(client, story.identifier));
    expect([detail.folderId, detail.folderPath]).toEqual([null, null]);
    expect(detail.parent?.identifier).toBe(epic.identifier);

    // File it again, then { folderId: null } takes it out to the root.
    await runMoveToParent({ key: story.identifier, folderId: year.id }, fx.ctx);
    const unfiled = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: story.identifier, folderId: null },
    });
    expect(unfiled.isError, textOf(unfiled)).toBeFalsy();
    expect(structured<PlacedWrite>(unfiled).placement).toEqual({
      parentKey: null,
      folderId: null,
      folderPath: null,
    });
    expect(textOf(unfiled)).toContain('at the top level');
    ({ detail } = await read(client, story.identifier));
    expect([detail.folderId, detail.folderPath]).toEqual([null, null]);
    await client.close();
  });

  it('refuses both placements, neither, an unknown folder and another project’s folder — typed', async () => {
    const fx = await makeWorkItemFixture();
    const { parked } = await parkedTree(fx);
    const epic = await make(fx, 'epic', 'Epic');
    const story = await make(fx, 'story', 'Story', epic.id);
    const elsewhere = await otherProjectFolder(fx);

    const both = await runMoveToParent(
      { key: story.identifier, parentKey: epic.identifier, folderId: parked.id },
      fx.ctx,
    );
    expectToolError(both, 'PLACEMENT_CONFLICT');
    expect(textOf(both)).toContain('EXACTLY ONE');
    const neither = await runMoveToParent({ key: story.identifier }, fx.ctx);
    expectToolError(neither, 'INVALID_REQUEST');
    expect(textOf(neither)).toContain('EXACTLY ONE');
    expectToolError(
      await runMoveToParent({ key: story.identifier, folderId: 'cm-no-such-folder' }, fx.ctx),
      'FOLDER_NOT_FOUND',
    );
    expectToolError(
      await runMoveToParent({ key: story.identifier, folderId: elsewhere.id }, fx.ctx),
      'CROSS_PROJECT_FOLDER',
    );
    // Nothing moved.
    const after = await workItemsService.getWorkItem(story.id, fx.ctx);
    expect(after.parentId).toBe(epic.id);
  });
});

describe('get_work_item declares exactly folderId + folderPath', () => {
  it('carries both null for an unfiled item AND for a child of a filed item — and no other folder field', async () => {
    const fx = await makeWorkItemFixture();
    const { parked } = await parkedTree(fx);
    const epic = await make(fx, 'epic', 'Filed epic');
    await workItemsService.fileWorkItem(epic.id, { folderId: parked.id }, fx.ctx);
    const child = await make(fx, 'story', 'Child of filed', epic.id);
    const client = await connectClient(fx.ctx);

    for (const key of [epic.identifier, child.identifier]) {
      const { res, detail } = await read(client, key);
      // The seam assertion: the payload's folder-ish fields are EXACTLY the two
      // it declares — an effective placement, or any other folder column riding
      // the aggregate spread, fails here by name.
      const folderish = (o: Record<string, unknown>) =>
        Object.keys(o).filter((k) => /folder|placement/i.test(k));
      expect(folderish(detail as unknown as Record<string, unknown>).sort()).toEqual([
        'folderId',
        'folderPath',
      ]);
      expect(folderish(detail.item)).toEqual([]);
      if (key === epic.identifier) {
        expect([detail.folderId, detail.folderPath]).toEqual([parked.id, ['Parked']]);
        expect(textOf(res)).toContain('Folder: Parked');
      } else {
        expect([detail.folderId, detail.folderPath]).toEqual([null, null]);
        expect(textOf(res)).not.toContain('Folder:');
      }
    }
    await client.close();
  });
});

describe('describePlacement', () => {
  it('names the parent, the folder path, or the top level', () => {
    expect(describePlacement({ parentKey: 'PROD-1', folderId: null, folderPath: null })).toBe(
      'under PROD-1',
    );
    expect(describePlacement({ parentKey: null, folderId: 'f', folderPath: ['A', 'B'] })).toBe(
      'in folder A ▸ B',
    );
    // A folder side with no path read still says it is a folder.
    expect(describePlacement({ parentKey: null, folderId: 'f', folderPath: null })).toBe(
      'in a folder',
    );
    expect(describePlacement({ parentKey: null, folderId: null, folderPath: null })).toBe(
      'at the top level',
    );
  });
});

describe('workItemsService.getWorkItemPlacement', () => {
  it('is 404-not-403 on an unknown id and across workspaces', async () => {
    const a = await makeWorkItemFixture();
    const item = await make(a, 'task', 'A task');
    await expect(
      workItemsService.getWorkItemPlacement('cm-no-such-item', a.ctx),
    ).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
    });
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    await expect(workItemsService.getWorkItemPlacement(item.id, b.ctx)).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
    });
  });
});
