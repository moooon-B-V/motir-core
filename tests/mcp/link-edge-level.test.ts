import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CrossLevelLinkError } from '@/lib/workItems/linkErrors';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedBlockedBy } from '../helpers/seedBlockedBy';

// MOTIR-6369 / MOTIR-6411 (Story MOTIR-6015) — COMMITTED edges follow the same
// rule as a plan's: a `blocked_by` joins two items on the SAME LEVEL — the same
// depth below their nearest common ancestor (MOTIR-6387, a folder adding none) —
// and may cross parents. A NEW cross-level edge is refused at the link door and
// on the create-with-links path, writing nothing; an EXISTING one is reported by
// `validate_work_item` as a `cross-level-edge` advisory that never moves `valid`.
//
// The tree every case reads (the decision record's own shapes):
//   epic E1 ─ story S ─ subtask Y
//          ├ task T ─ subtask X          (T: the validation task beside S)
//          └ story S1 ─ task T1 ─ subtask X1
//   epic E2 ─ story S2 ─ subtask Y2
//   task R (root) ─ subtask XR
//   bug B (root, filed in a folder)

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'link-edge-level', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function tree(fx: WorkItemFixture) {
  const mk = (
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    parentId?: string,
    folderId?: string,
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, parentId, folderId },
      fx.ctx,
    );
  const folder = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Parked bugs' },
    fx.ctx,
  );
  const e1 = await mk('epic', 'Epic one');
  const e2 = await mk('epic', 'Epic two');
  const s = await mk('story', 'Story S', e1.id);
  const t = await mk('task', 'Validation task T', e1.id);
  const s1 = await mk('story', 'Story S1', e1.id);
  const s2 = await mk('story', 'Story S2', e2.id);
  const y = await mk('subtask', 'Subtask Y', s.id);
  const x = await mk('subtask', 'Subtask X', t.id);
  const t1 = await mk('task', 'Task T1', s1.id);
  const x1 = await mk('subtask', 'Subtask X1', t1.id);
  const y2 = await mk('subtask', 'Subtask Y2', s2.id);
  const r = await mk('task', 'Root task R');
  const xr = await mk('subtask', 'Subtask XR', r.id);
  const b = await mk('bug', 'Filed bug B', undefined, folder.id);
  return { e1, e2, s, t, s1, s2, y, x, t1, x1, y2, r, xr, b };
}

const linkCount = () => adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('link_work_items — the record’s ACCEPTED cases', () => {
  it('case 1 · the validation task under an epic, blocked_by the story beside it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const made = await call(client, 'link_work_items', {
      fromKey: t.t.identifier,
      toKey: t.s.identifier,
      relationship: 'blocked_by',
    });
    expect(made.isError, text(made)).toBeFalsy();
    expect(await linkCount()).toBe(1);
    await client.close();
  });

  it('case 2 / 2b · a subtask under a task, blocked_by a subtask under a story — same epic, or another', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    for (const to of [t.y, t.y2]) {
      const made = await call(client, 'link_work_items', {
        fromKey: t.x.identifier,
        toKey: to.identifier,
        relationship: 'blocked_by',
      });
      expect(made.isError, text(made)).toBeFalsy();
    }
    expect(await linkCount()).toBe(2);
    await client.close();
  });

  it('`relates_to` between two depths is never judged', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const made = await call(client, 'link_work_items', {
      fromKey: t.x1.identifier,
      toKey: t.s.identifier,
      relationship: 'relates_to',
    });
    expect(made.isError, text(made)).toBeFalsy();
    await client.close();
  });
});

describe('link_work_items — the record’s REFUSED cases write nothing', () => {
  it.each([
    ['case 3 · a subtask two levels under a story → a subtask under a story', 'x1', 'y', 3, 2],
    ['case 4 · a root bug filed in a folder → a subtask', 'b', 'y', 0, 2],
    [
      'case 4b · a subtask under a ROOT task → a subtask under a story under an epic',
      'xr',
      'y',
      1,
      2,
    ],
    ['a subtask → a story (a child of an epic)', 'y', 's1', 2, 1],
  ] as const)('%s → CROSS_LEVEL_LINK naming both depths', async (_label, from, to, dFrom, dTo) => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const refused = await call(client, 'link_work_items', {
      fromKey: t[from].identifier,
      toKey: t[to].identifier,
      relationship: 'blocked_by',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('CROSS_LEVEL_LINK');
    expect(text(refused)).toContain(`${t[from].identifier} sits ${dFrom} level(s)`);
    expect(text(refused)).toContain(`${t[to].identifier} sits ${dTo}`);
    expect(await linkCount()).toBe(0);
    await client.close();
  });

  it('`blocks` is judged in its stored direction', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await expect(
      workItemsService.linkWorkItems(
        { fromId: t.y.id, toId: t.s1.id, kind: 'is_blocked_by' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
    const client = await connectClient(fx.ctx);
    const refused = await call(client, 'link_work_items', {
      fromKey: t.s1.identifier,
      toKey: t.y.identifier,
      relationship: 'blocks',
    });
    expect(text(refused)).toContain('CROSS_LEVEL_LINK');
    expect(await linkCount()).toBe(0);
    await client.close();
  });
});

describe('createWorkItem with links — the same rule on the create path', () => {
  it('a new subtask under a task, created blocked_by a STORY, rolls the whole create back', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const before = await adminDb.workItem.count();
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'subtask',
          title: 'Born cross-level',
          parentId: t.t.id,
          links: [{ targetId: t.s.id, relationship: 'blocked_by' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
    expect(await adminDb.workItem.count()).toBe(before);
  });

  it('a new task under an epic, created blocked_by the story beside it (case 1), is created with its link', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const made = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Validate the epic',
        parentId: t.e1.id,
        links: [{ targetId: t.s.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: made.id, toId: t.s.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
  });

  it('a new ROOT story created as a blocker of a subtask (`blocks`) is refused in the stored direction', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'story',
          title: 'Blocks a leaf',
          links: [{ targetId: t.y.id, relationship: 'blocks' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
  });
});

describe('validate_work_item — an EXISTING cross-level edge is an advisory, never a verdict', () => {
  it('a story blocked_by an EPIC (seeded) yields one `cross-level-edge` advisory naming both depths', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    // Seeded below every door — the shape an edge drawn before the rule has.
    await seedBlockedBy(fx, t.s1.id, t.e2.id);

    const res = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(res.isError, text(res)).toBeFalsy();
    const verdict = res.structuredContent as { advisories: Array<Record<string, unknown>> };
    expect(verdict.advisories.filter((a) => a.severity === 'cross-level-edge')).toEqual([
      {
        kind: 'shape',
        item: t.s1.identifier,
        severity: 'cross-level-edge',
        blockedBy: t.e2.identifier,
        itemDepth: 1,
        blockedByDepth: 0,
      },
    ]);
    expect(text(res)).toContain('blocked_by an item on ANOTHER LEVEL');
    await client.close();
  });

  it('`valid` does not move for an in-subtree cross-level edge, and case 1 raises no advisory', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await seedBlockedBy(fx, t.y.id, t.s1.id); // depth 2 → 1, inside E1
    await workItemsService.linkWorkItems(
      { fromId: t.t.id, toId: t.s.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    const verdict = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as { valid: boolean; advisories: Array<Record<string, unknown>> };
    expect(verdict.valid).toBe(true);
    const flagged = verdict.advisories.filter((a) => a.severity === 'cross-level-edge');
    expect(flagged.map((a) => a.item)).toEqual([t.y.identifier]);
    await client.close();
  });
});

describe('the link form copy', () => {
  it('maps CROSS_LEVEL_LINK to its own catalog key', () => {
    const t = (key: string) => key;
    const err = new CrossLevelLinkError(
      { key: 'ACME-2', depth: 3 },
      { key: 'ACME-1', depth: 2 },
      'ACME-2 and ACME-1 are not on the same level.',
    );
    expect(linkErrorMessage(err, t)).toBe('links.crossLevel');
  });
});
