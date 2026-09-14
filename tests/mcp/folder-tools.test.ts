import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { renderFolderTree } from '@/lib/mcp/tools/folderRef';
import { toToolError } from '@/lib/mcp/toolResult';
import { PlacementConflictError } from '@/lib/folders/errors';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { TokenGrant } from '@/lib/tokens/grant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { removeSeededBugsFolder } from '../fixtures/projectFixtures';

// MCP FOLDER TOOLS (Story MOTIR-5310 · MOTIR-5409) over real Postgres, driven
// through `buildMcpServer` + an in-memory client — the `move-to-parent.test.ts`
// pattern. Each tool is a thin adapter over `foldersService`, so this asserts
// the adapter half: the round-trip of every tool, every folder refusal surfacing
// as a TYPED tool error with its code, the rename-or-placement split refused
// before either write, and the permission gate under a CLI and a browse-only
// grant.

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

/** Connect an in-memory MCP client bound to `ctx` — and, when given, narrowed to `grant`. */
async function connectClient(ctx: ServiceContext, grant?: TokenGrant): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
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

interface FolderOut {
  id: string;
  projectKey: string;
  parentFolderId: string | null;
  name: string;
  path: string[];
  position: string;
  createdAt: string;
  updatedAt: string;
}

async function create(
  client: Client,
  name: string,
  parentFolderId?: string | null,
): Promise<FolderOut> {
  const res = await client.callTool({
    name: 'create_folder',
    arguments: { projectKey: 'PROD', name, ...(parentFolderId ? { parentFolderId } : {}) },
  });
  expect(res.isError, textOf(res)).toBeFalsy();
  return structured<FolderOut>(res);
}

async function listRows(client: Client) {
  const res = await client.callTool({ name: 'list_folders', arguments: { projectKey: 'PROD' } });
  expect(res.isError, textOf(res)).toBeFalsy();
  return structured<{
    projectKey: string;
    folders: { id: string; parentFolderId: string | null; name: string; path: string[] }[];
    truncated: boolean;
  }>(res);
}

function expectToolError(res: unknown, code: string): void {
  expect((res as CallToolResult).isError).toBe(true);
  expect(textOf(res)).toContain(`${code}:`);
}

function secondProject(fx: WorkItemFixture) {
  return projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ctx.userId,
    name: 'Second project',
    identifier: 'SECND',
  });
}

describe('folder tools — round-trip', () => {
  it('creates, lists with paths, renames, moves, reorders and deletes a folder tree', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx);

    // An empty project says so.
    const empty = await client.callTool({
      name: 'list_folders',
      arguments: { projectKey: 'prod' },
    });
    expect(structured<{ folders: unknown[] }>(empty).folders).toEqual([]);
    expect(textOf(empty)).toContain('has no folders');

    const parked = await create(client, 'Parked');
    const year = await create(client, '2025', parked.id);
    expect(parked).toMatchObject({
      projectKey: 'PROD',
      parentFolderId: null,
      name: 'Parked',
      path: ['Parked'],
    });
    expect(year).toMatchObject({ parentFolderId: parked.id, path: ['Parked', '2025'] });

    const listed = await listRows(client);
    expect(listed.truncated).toBe(false);
    expect(listed.folders).toEqual([
      { id: parked.id, parentFolderId: null, name: 'Parked', path: ['Parked'] },
      { id: year.id, parentFolderId: parked.id, name: '2025', path: ['Parked', '2025'] },
    ]);

    // Rename.
    const renamed = await client.callTool({
      name: 'update_folder',
      arguments: { projectKey: 'PROD', folderId: year.id, name: '2026' },
    });
    expect(renamed.isError, textOf(renamed)).toBeFalsy();
    expect(structured<FolderOut>(renamed).name).toBe('2026');
    expect(textOf(renamed)).toContain('Renamed');

    // Move into a sibling: `Ideas` goes inside `Parked`, beside `2026`.
    const ideas = await create(client, 'Ideas');
    const moved = await client.callTool({
      name: 'update_folder',
      arguments: { projectKey: 'PROD', folderId: ideas.id, parentFolderId: parked.id },
    });
    expect(moved.isError, textOf(moved)).toBeFalsy();
    expect(structured<FolderOut>(moved).parentFolderId).toBe(parked.id);
    expect(textOf(moved)).toContain('Placed folder Parked ▸ Ideas');

    // Reorder with `afterId`: `Ideas` (appended last) moves to sort before `2026`…
    const reordered = await client.callTool({
      name: 'update_folder',
      arguments: {
        projectKey: 'PROD',
        folderId: ideas.id,
        parentFolderId: parked.id,
        afterId: year.id,
      },
    });
    expect(reordered.isError, textOf(reordered)).toBeFalsy();
    expect((await listRows(client)).folders.map((f) => f.name)).toEqual([
      'Parked',
      'Ideas',
      '2026',
    ]);
    // …and `beforeId` puts it back after `2026`.
    const reorderedBack = await client.callTool({
      name: 'update_folder',
      arguments: {
        projectKey: 'PROD',
        folderId: ideas.id,
        parentFolderId: parked.id,
        beforeId: year.id,
      },
    });
    expect(reorderedBack.isError, textOf(reorderedBack)).toBeFalsy();
    expect((await listRows(client)).folders.map((f) => f.name)).toEqual([
      'Parked',
      '2026',
      'Ideas',
    ]);

    // Move back to the root.
    const rooted = await client.callTool({
      name: 'update_folder',
      arguments: { projectKey: 'PROD', folderId: ideas.id, parentFolderId: null },
    });
    expect(structured<FolderOut>(rooted).parentFolderId).toBeNull();
    expect(structured<FolderOut>(rooted).path).toEqual(['Ideas']);

    // Delete `Parked`, which holds a folder and a filed work item: both move up.
    const filed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Filed story', folderId: parked.id },
      fx.ctx,
    );
    const deleted = await client.callTool({
      name: 'delete_folder',
      arguments: { projectKey: 'PROD', folderId: parked.id },
    });
    expect(deleted.isError, textOf(deleted)).toBeFalsy();
    expect(structured(deleted)).toEqual({
      deletedFolderId: parked.id,
      destinationFolderId: null,
      movedFolderIds: [year.id],
      movedWorkItemIds: [filed.id],
    });
    expect(textOf(deleted)).toContain('to the project root');
    const after = await listRows(client);
    expect(after.folders.map((f) => f.path)).toEqual([['Ideas'], ['2026']]);

    await client.close();
  });

  it('delete into a parent folder names the destination', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx);
    const outer = await create(client, 'Outer');
    const inner = await create(client, 'Inner', outer.id);
    const res = await client.callTool({
      name: 'delete_folder',
      arguments: { projectKey: 'PROD', folderId: inner.id },
    });
    expect(structured<{ destinationFolderId: string }>(res).destinationFolderId).toBe(outer.id);
    expect(textOf(res)).toContain(`into ${outer.id}`);
    await client.close();
  });

  it('says a truncated tree is truncated', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx);
    await create(client, 'Only');
    vi.spyOn(foldersService, 'listProjectFolders').mockResolvedValueOnce({
      folders: [{ id: 'f1', parentFolderId: null, name: 'Only', position: 'a0', path: ['Only'] }],
      truncated: true,
    });
    const res = await client.callTool({ name: 'list_folders', arguments: { projectKey: 'PROD' } });
    expect(structured<{ truncated: boolean }>(res).truncated).toBe(true);
    expect(textOf(res)).toContain('TRUNCATED');
    await client.close();
  });
});

describe('folder tools — typed refusals', () => {
  it('surfaces every folder code as a typed tool error', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx);
    const parked = await create(client, 'Parked');
    const child = await create(client, 'Child', parked.id);

    // FOLDER_NOT_FOUND — including a retried delete on a folder already gone.
    const gone = await create(client, 'Gone');
    await client.callTool({
      name: 'delete_folder',
      arguments: { projectKey: 'PROD', folderId: gone.id },
    });
    expectToolError(
      await client.callTool({
        name: 'delete_folder',
        arguments: { projectKey: 'PROD', folderId: gone.id },
      }),
      'FOLDER_NOT_FOUND',
    );

    // INVALID_FOLDER_NAME.
    expectToolError(
      await client.callTool({
        name: 'create_folder',
        arguments: { projectKey: 'PROD', name: '   ' },
      }),
      'INVALID_FOLDER_NAME',
    );

    // FOLDER_NAME_TAKEN — a retried create names the folder already there.
    const retried = await client.callTool({
      name: 'create_folder',
      arguments: { projectKey: 'PROD', name: 'Parked' },
    });
    expectToolError(retried, 'FOLDER_NAME_TAKEN');
    expect(textOf(retried)).toContain('Parked');

    // FOLDER_CYCLE — a folder moved into its own child.
    expectToolError(
      await client.callTool({
        name: 'update_folder',
        arguments: { projectKey: 'PROD', folderId: parked.id, parentFolderId: child.id },
      }),
      'FOLDER_CYCLE',
    );

    // CROSS_PROJECT_FOLDER — another project's folder as the destination.
    const other = await secondProject(fx);
    const elsewhere = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );
    expectToolError(
      await client.callTool({
        name: 'create_folder',
        arguments: { projectKey: 'PROD', name: 'Stray', parentFolderId: elsewhere.id },
      }),
      'CROSS_PROJECT_FOLDER',
    );
    // The folder ACTED ON in another project is a not-found (only a destination is
    // the named mistake) — on the id-addressed update and the delete alike.
    expectToolError(
      await client.callTool({
        name: 'update_folder',
        arguments: { projectKey: 'PROD', folderId: elsewhere.id, name: 'Hijacked' },
      }),
      'FOLDER_NOT_FOUND',
    );
    expectToolError(
      await client.callTool({
        name: 'delete_folder',
        arguments: { projectKey: 'PROD', folderId: elsewhere.id },
      }),
      'FOLDER_NOT_FOUND',
    );
    expect((await foldersService.getFolder(elsewhere.id, fx.ctx)).name).toBe('Elsewhere');

    // SUBTASK_NEEDS_PLACEMENT — deleting a root folder would leave a filed subtask
    // with neither a parent nor a folder.
    const holder = await create(client, 'Holder');
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Filed subtask', folderId: holder.id },
      fx.ctx,
    );
    expectToolError(
      await client.callTool({
        name: 'delete_folder',
        arguments: { projectKey: 'PROD', folderId: holder.id },
      }),
      'SUBTASK_NEEDS_PLACEMENT',
    );

    // An unknown project is a plain not-found, before any folder is looked at.
    expectToolError(
      await client.callTool({ name: 'list_folders', arguments: { projectKey: 'NOPE' } }),
      'PROJECT_NOT_FOUND',
    );

    await client.close();
  });

  it('maps PLACEMENT_CONFLICT for the work-item tools that reach the same service', () => {
    const res = toToolError(new PlacementConflictError());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PLACEMENT_CONFLICT:');
  });

  it('refuses a rename and a placement in one call, changing nothing', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx);
    const target = await create(client, 'Target');
    const folder = await create(client, 'Folder');

    const both = await client.callTool({
      name: 'update_folder',
      arguments: {
        projectKey: 'PROD',
        folderId: folder.id,
        name: 'Renamed',
        parentFolderId: target.id,
      },
    });
    expectToolError(both, 'INVALID_REQUEST');
    expect(textOf(both)).toContain('separate requests');

    const rows = (await listRows(client)).folders;
    expect(rows.find((r) => r.id === folder.id)).toMatchObject({
      name: 'Folder',
      parentFolderId: null,
    });

    expectToolError(
      await client.callTool({
        name: 'update_folder',
        arguments: { projectKey: 'PROD', folderId: folder.id },
      }),
      'INVALID_REQUEST',
    );

    // A pure reorder — neighbours with no `parentFolderId` — keeps the parent.
    const reorder = await client.callTool({
      name: 'update_folder',
      arguments: { projectKey: 'PROD', folderId: folder.id, afterId: target.id },
    });
    expect(reorder.isError, textOf(reorder)).toBeFalsy();
    expect((await listRows(client)).folders.map((r) => r.name)).toEqual(['Folder', 'Target']);
    await client.close();
  });
});

describe('renderFolderTree', () => {
  it('indents each folder by its depth', () => {
    expect(
      renderFolderTree([
        { id: 'a', parentFolderId: null, name: 'A', position: 'a0', path: ['A'] },
        { id: 'b', parentFolderId: 'a', name: 'B', position: 'a0', path: ['A', 'B'] },
      ]),
    ).toBe('- A (a)\n  - B (b)');
  });
});

describe('folder tools — permissions', () => {
  it('a CLI-grant token calls all four tools', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const client = await connectClient(fx.ctx, CLI_TOKEN_GRANT as TokenGrant);
    const folder = await create(client, 'CLI folder');
    expect((await listRows(client)).folders).toHaveLength(1);
    const renamed = await client.callTool({
      name: 'update_folder',
      arguments: { projectKey: 'PROD', folderId: folder.id, name: 'CLI renamed' },
    });
    expect(renamed.isError, textOf(renamed)).toBeFalsy();
    const deleted = await client.callTool({
      name: 'delete_folder',
      arguments: { projectKey: 'PROD', folderId: folder.id },
    });
    expect(deleted.isError, textOf(deleted)).toBeFalsy();
    await client.close();
  });

  it('a browse-only token reads folders and is refused the three writes', async () => {
    const fx = await makeWorkItemFixture();
    await removeSeededBugsFolder(fx.projectId); // these specs control the folder set
    const existing = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Existing' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx, ['project:browse']);

    const read = await client.callTool({ name: 'list_folders', arguments: { projectKey: 'PROD' } });
    expect(read.isError, textOf(read)).toBeFalsy();

    const writes = [
      { name: 'create_folder', arguments: { projectKey: 'PROD', name: 'Nope' } },
      {
        name: 'update_folder',
        arguments: { projectKey: 'PROD', folderId: existing.id, name: 'Nope' },
      },
      { name: 'delete_folder', arguments: { projectKey: 'PROD', folderId: existing.id } },
    ];
    for (const call of writes) {
      const res = await client.callTool(call);
      expect(res.isError, call.name).toBe(true);
      expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    }
    const rows = await foldersService.listProjectFolders({ projectId: fx.projectId }, fx.ctx);
    expect(rows.folders.map((f) => f.name)).toEqual(['Existing']);
    await client.close();
  });
});
