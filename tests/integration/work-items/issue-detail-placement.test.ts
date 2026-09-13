import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { buildMcpServer } from '@/lib/mcp/registry';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The work item page's PLACEMENT read (Story MOTIR-5309 · MOTIR-5375), on a REAL
// Postgres through the real services:
//   · `getIssueDetail.placementFolder` is the item's EFFECTIVE folder — its own,
//     else its root ancestor's — with the name path root first and `via` naming
//     the ancestor it is inherited from; an unfiled item reads no folder at all;
//   · `getWorkItemPlacement` answers the same placement through the same mapper,
//     behind the same not-found;
//   · neither MCP `get_work_item` nor the `/api/v1` read publishes the field —
//     how agents learn folders is Story MOTIR-5310's.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function make(
  fx: WorkItemFixture,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

function detail(fx: WorkItemFixture, identifier: string) {
  return workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx);
}

/**
 * The spec's fixture: `Later ▸ 2025`, a task filed in `Later`, a task filed in
 * `2025`, and epic → story → subtask with the epic filed in `2025`.
 */
async function placementTree(fx: WorkItemFixture) {
  const later = await folder(fx, 'Later');
  const y2025 = await folder(fx, '2025', later.id);
  const atRoot = await make(fx, 'task', 'Filed in a root folder');
  const deep = await make(fx, 'task', 'Filed two levels down');
  const loose = await make(fx, 'task', 'Not filed');
  const epic = await make(fx, 'epic', 'Old import');
  const story = await make(fx, 'story', 'Map legacy fields', epic.id);
  const subtask = await make(fx, 'subtask', 'Field table', story.id);
  await foldersService.fileWorkItem(atRoot.id, { folderId: later.id }, fx.ctx);
  await foldersService.fileWorkItem(deep.id, { folderId: y2025.id }, fx.ctx);
  await foldersService.fileWorkItem(epic.id, { folderId: y2025.id }, fx.ctx);
  return { later, y2025, atRoot, deep, loose, epic, story, subtask };
}

describe('getIssueDetail — placementFolder', () => {
  it('an unfiled root item carries no placement folder, and reads no folder path', async () => {
    const fx = await makeWorkItemFixture();
    const loose = await make(fx, 'task', 'Loose');
    const pathRead = vi.spyOn(folderRepository, 'findPathNames');

    const d = await detail(fx, loose.identifier);

    expect(d.placementFolder).toBeNull();
    expect(d.folderId).toBeNull();
    expect(pathRead).not.toHaveBeenCalled();
  });

  it('an unfiled item under an unfiled root reads no folder path either', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, 'epic', 'Q3 launch');
    const story = await make(fx, 'story', 'Pricing page', epic.id);
    const pathRead = vi.spyOn(folderRepository, 'findPathNames');

    const d = await detail(fx, story.identifier);

    expect(d.placementFolder).toBeNull();
    expect(pathRead).not.toHaveBeenCalled();
  });

  it('a directly filed item carries its path, root first, with no `via` — in one path read', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);
    const pathRead = vi.spyOn(folderRepository, 'findPathNames');

    const inRoot = await detail(fx, t.atRoot.identifier);
    expect(inRoot.placementFolder).toEqual({ folderId: t.later.id, path: ['Later'], via: null });
    expect(pathRead).toHaveBeenCalledTimes(1);

    const twoDown = await detail(fx, t.deep.identifier);
    expect(twoDown.placementFolder).toEqual({
      folderId: t.y2025.id,
      path: ['Later', '2025'],
      via: null,
    });
    // `folderId` stays the item's OWN folder.
    expect(twoDown.folderId).toBe(t.y2025.id);
  });

  it('a story and a subtask under a filed epic inherit its folder, `via` the epic', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);

    for (const item of [t.story, t.subtask]) {
      const d = await detail(fx, item.identifier);
      expect(d.folderId).toBeNull();
      expect(d.placementFolder).toMatchObject({
        folderId: t.y2025.id,
        path: ['Later', '2025'],
        via: { id: t.epic.id, identifier: t.epic.identifier, kind: 'epic' },
      });
    }
  });

  it('taking the epic out of its folder takes the story out with it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);

    await foldersService.fileWorkItem(t.epic.id, { folderId: null }, fx.ctx);

    expect((await detail(fx, t.story.identifier)).placementFolder).toBeNull();
    expect((await detail(fx, t.epic.identifier)).placementFolder).toBeNull();
  });
});

describe('getWorkItemPlacement', () => {
  it('answers exactly the placement slice getIssueDetail renders, for every fixture shape', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);

    for (const item of [t.atRoot, t.deep, t.loose, t.epic, t.story, t.subtask]) {
      const d = await detail(fx, item.identifier);
      await expect(
        workItemsService.getWorkItemPlacement(fx.projectId, item.id, fx.ctx),
      ).resolves.toEqual({
        folderId: d.folderId,
        parent: d.parent,
        ancestors: d.ancestors,
        placementFolder: d.placementFolder,
      });
    }
  });

  it('follows a move: after a parent change the item reads its new parent and no folder', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);
    const q3 = await make(fx, 'epic', 'Q3 launch');

    await workItemsService.updateWorkItem(t.story.id, { parentId: q3.id }, fx.ctx);

    const placement = await workItemsService.getWorkItemPlacement(fx.projectId, t.story.id, fx.ctx);
    expect(placement.parent).toMatchObject({ id: q3.id });
    expect(placement.placementFolder).toBeNull();
  });

  it('refuses an unknown id, another project’s item and another workspace’s item with the not-found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other workspace', identifier: 'OTH' });
    const foreign = await make(other, 'task', 'Foreign');
    const mine = await make(fx, 'task', 'Mine');

    await expect(
      workItemsService.getWorkItemPlacement(fx.projectId, 'no-such-id', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      workItemsService.getWorkItemPlacement(fx.projectId, foreign.id, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      workItemsService.getWorkItemPlacement(other.projectId, mine.id, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('the published reads do not carry placementFolder', () => {
  async function connectClient(ctx: ServiceContext): Promise<Client> {
    const server = buildMcpServer(() => ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('MCP get_work_item for a filed item returns no placementFolder key', async () => {
    const fx = await makeWorkItemFixture();
    const t = await placementTree(fx);
    const client = await connectClient(fx.ctx);

    for (const item of [t.atRoot, t.story]) {
      const res = await client.callTool({
        name: 'get_work_item',
        arguments: { key: item.identifier },
      });
      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as Record<string, unknown>;
      expect(structured.item).toMatchObject({ id: item.id });
      expect(structured).not.toHaveProperty('placementFolder');
    }
  });

  it('the /api/v1 work item read for a filed item returns no placementFolder key', async () => {
    const caller = await createV1ProjectCaller();
    const fx = caller.fixture;
    const t = await placementTree(fx);
    const { GET } = await import('@/app/api/v1/work-items/[key]/route');

    for (const item of [t.atRoot, t.story]) {
      const res = await GET(
        new Request(`http://localhost/api/v1/work-items/${item.identifier}`, {
          headers: caller.headers,
        }),
        { params: Promise.resolve({ key: item.identifier }) },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('placementFolder');
      expect(JSON.stringify(body)).not.toContain('placementFolder');
    }
  });
});
