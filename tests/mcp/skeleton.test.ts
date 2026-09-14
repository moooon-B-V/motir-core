import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { SKELETON_ITEM_CAP, SKELETON_TOOL_NAME, summarizeSkeleton } from '@/lib/mcp/tools/skeleton';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `skeleton` (Story MOTIR-3098 · Subtask MOTIR-3100) over real Postgres — the
// ORIENTING read, the whole project's tree shape in one call.
//
// The assertions, in the order of what would hurt most if it broke:
//  1. THE SHAPE IS WHOLE AND PARENTED — every live item, each carrying the
//     parent KEY, so a caller can rebuild the tree without a second read. This
//     is the capability; a flat list of titles would not be one.
//  2. TRUNCATION ANNOUNCES ITSELF — asserted on the FLAG, not on the row count.
//     A test that only counted rows would pass just as happily against a tool
//     that silently stopped, which is the one way this tool can mislead an agent
//     into proposing something that already exists.
//  3. THE BOUND IS REPORTED EVEN WHEN IT DID NOT BITE — `truncated: false` with
//     the real `total` is what makes a complete answer legible AS complete.
//  4. TENANCY — a key belonging to another workspace is a plain not-found, never
//     a partial tree and never proof the project exists. (`story-roundtrip`
//     covers the same for every tool at once; this is the targeted case, because
//     for THIS tool a leak would name every card the other tenant has.)
//
// Built with a FIXED-context resolver over the in-memory transport (the
// get-project-state.test.ts pattern) — the bearer plumbing is auth.test.ts's job.

interface SkeletonRow {
  key: string;
  id: string;
  kind: string;
  title: string;
  status: string;
  parentKey: string | null;
  revision: string | null;
  folderId: string | null;
}

interface SkeletonFolder {
  id: string;
  parentFolderId: string | null;
  name: string;
  path: string[];
}

interface SkeletonPayload {
  project: { projectId: string; projectKey: string };
  items: SkeletonRow[];
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
  folders: SkeletonFolder[];
  foldersTruncated: boolean;
}

async function callSkeleton(
  ctx: ServiceContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'skeleton-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: SKELETON_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function payloadOf(res: CallToolResult): SkeletonPayload {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as unknown as SkeletonPayload;
}

function textOf(res: CallToolResult): string {
  return (res.content as { type: string; text: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('skeleton — the whole project tree in one read', () => {
  it('returns every live item with its parent KEY, so the tree is rebuildable without a second read', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'The epic' });
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'The story',
      parentId: epic.id,
    });
    const leaf = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'The leaf',
      parentId: story.id,
    });

    const payload = payloadOf(await callSkeleton(fx.ctx, { projectKey: 'ACME' }));

    expect(payload.project.projectKey).toBe('ACME');
    expect(payload.total).toBe(3);
    expect(payload.returned).toBe(3);
    expect(payload.truncated).toBe(false);
    expect(payload.limit).toBe(SKELETON_ITEM_CAP);

    const byKey = new Map(payload.items.map((row) => [row.key, row]));
    expect([...byKey.keys()].sort()).toEqual([epic, story, leaf].map((i) => i.identifier).sort());
    // The EDGE that makes this a tree and not a list.
    expect(byKey.get(story.identifier)?.parentKey).toBe(epic.identifier);
    expect(byKey.get(epic.identifier)?.parentKey).toBeNull();
    // The row carries the cuid `add_plan_items` takes (it refuses a <KEY>-<n>),
    // so an agent can propose against what it just read.
    expect(byKey.get(story.identifier)?.id).toBe(story.id);
    expect(byKey.get(story.identifier)?.kind).toBe('story');
    expect(byKey.get(story.identifier)?.title).toBe('The story');
    expect(typeof byKey.get(story.identifier)?.status).toBe('string');
    // `revision` is present and NULLABLE — an item with no revision row yet
    // reports null rather than omitting the field a `modify` proposal anchors on.
    expect(byKey.get(story.identifier)).toHaveProperty('revision');
  });

  // MOTIR-5410 — a filed item is not an ordinary root: the row carries its OWN
  // folder, the folders ride beside the rows with their name paths, and the text
  // half names where the filed row sits.
  it('carries folder PLACEMENT — a filed epic’s folderId, every folder with its path, and the path in the text', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const parked = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
      fx.ctx,
    );
    const year = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: parked.id, name: '2025' },
      fx.ctx,
    );
    const filed = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Filed epic', folderId: year.id },
      fx.ctx,
    );
    const loose = await createTestWorkItem(fx, { kind: 'epic', title: 'Loose epic' });
    const child = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story under the filed epic',
      parentId: filed.id,
    });

    const res = await callSkeleton(fx.ctx, { projectKey: 'ACME' });
    const payload = payloadOf(res);
    const byKey = new Map(payload.items.map((row) => [row.key, row]));

    expect(byKey.get(filed.identifier)?.folderId).toBe(year.id);
    expect(byKey.get(filed.identifier)?.parentKey).toBeNull();
    expect(byKey.get(loose.identifier)?.folderId).toBeNull();
    // Only a root can be filed: the story's placement is its ancestor's key.
    expect(byKey.get(child.identifier)?.folderId).toBeNull();
    expect(byKey.get(child.identifier)?.parentKey).toBe(filed.identifier);

    expect(payload.folders).toEqual([
      { id: parked.id, parentFolderId: null, name: 'Parked', path: ['Parked'] },
      { id: year.id, parentFolderId: parked.id, name: '2025', path: ['Parked', '2025'] },
    ]);
    expect(payload.foldersTruncated).toBe(false);
    // Folders ride BESIDE the rows: the work-item count is untouched by them.
    expect(payload.total).toBe(3);
    expect(payload.items.map((r) => r.id)).not.toContain(parked.id);

    const text = textOf(res);
    expect(text).toContain(`${filed.identifier} (epic) — Parked ▸ 2025`);
    expect(text).not.toContain(`${loose.identifier} (epic) —`);
    expect(text).toContain('Folders (2):');
  });

  it('a project with no folders reports an EMPTY folder list, not an absent one', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    await createTestWorkItem(fx, { kind: 'task', title: 'only' });

    const res = await callSkeleton(fx.ctx, { projectKey: 'ACME' });
    const payload = payloadOf(res);

    expect(payload.folders).toEqual([]);
    expect(payload.foldersTruncated).toBe(false);
    expect(payload.items[0]?.folderId).toBeNull();
    expect(textOf(res)).not.toContain('Folders (');
  });

  it('a bounded answer reports the TRUNCATION FLAG — not merely a shorter list', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    for (const title of ['one', 'two', 'three']) {
      await createTestWorkItem(fx, { kind: 'task', title });
    }

    const payload = payloadOf(await callSkeleton(fx.ctx, { projectKey: 'ACME', limit: 2 }));

    // The FLAG is the assertion. A tool that silently stopped at 2 would satisfy
    // a row-count check identically and mislead every caller.
    expect(payload.truncated).toBe(true);
    expect(payload.limit).toBe(2);
    expect(payload.returned).toBe(2);
    expect(payload.total).toBe(3);
    expect(payload.items).toHaveLength(2);
    // And it says so in the half a human reads, too.
    expect(textOf(await callSkeleton(fx.ctx, { projectKey: 'ACME', limit: 2 }))).toContain(
      'TRUNCATED',
    );
  });

  it('an EMPTY project is a well-formed whole answer, not an error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });

    const payload = payloadOf(await callSkeleton(fx.ctx, { projectKey: 'acme' }));

    expect(payload.items).toEqual([]);
    expect(payload.total).toBe(0);
    expect(payload.truncated).toBe(false);
    // Case-insensitive, like every other project-keyed tool.
    expect(payload.project.projectKey).toBe('ACME');
  });

  it("another workspace's project key is a plain NOT-FOUND — no partial tree, no proof it exists", async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'ACME' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'ZZZ' });
    await createTestWorkItem(theirs, { kind: 'epic', title: 'their secret epic' });

    const res = await callSkeleton(mine.ctx, { projectKey: 'ZZZ' });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/NOT_FOUND/);
    expect(text).not.toContain('their secret epic');
    expect(res.structuredContent).toBeUndefined();
  });

  it('is registered, gated on project:browse, and summarised for both readers', () => {
    expect(MCP_TOOL_NAMES).toContain(SKELETON_TOOL_NAME);
    expect(TOOL_PERMISSIONS[SKELETON_TOOL_NAME]).toBe('project:browse');
    // The summary branches, both of them, without needing 5 000 fixtures.
    expect(
      summarizeSkeleton({
        projectKey: 'ACME',
        total: 3,
        returned: 3,
        truncated: false,
        limit: 5000,
      }),
    ).toContain('the whole tree');
    expect(
      summarizeSkeleton({ projectKey: 'ACME', total: 9, returned: 2, truncated: true, limit: 2 }),
    ).toContain('NOT the whole project');
    // A filed row whose folder is past the folder bound still names its folder id,
    // and a capped folder list says so.
    const capped = summarizeSkeleton({
      projectKey: 'ACME',
      total: 1,
      returned: 1,
      truncated: false,
      limit: 5000,
      items: [{ key: 'ACME-1', kind: 'epic', folderId: 'fold_gone' }],
      folders: [{ id: 'fold_a', path: ['A'] }],
      foldersTruncated: true,
    });
    expect(capped).toContain('ACME-1 (epic) — folder fold_gone');
    expect(capped).toContain('Folders (1, TRUNCATED):');
  });
});
