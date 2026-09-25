import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { workItemsService } from '@/lib/services/workItemsService';
import { CrossLevelLinkError } from '@/lib/workItems/linkErrors';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6369 (Story MOTIR-6015) — COMMITTED edges follow the same rule as a
// plan's: a `blocked_by` joins two items on the SAME LEVEL (epic · story · leaf)
// and may cross parents. A NEW cross-level edge is refused at the link door and
// on the create-with-links path, writing nothing; an EXISTING one is reported by
// `validate_work_item` as a `cross-level-edge` advisory that never moves `valid`.
//
// The tree every case reads:
//   epic E1 ─ story A ─ subtask Y
//          └ story B ─ subtask X, bug G
//   epic E2 ─ story C

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
  const mk = (kind: 'epic' | 'story' | 'bug' | 'subtask', title: string, parentId?: string) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const e1 = await mk('epic', 'Epic one');
  const e2 = await mk('epic', 'Epic two');
  const a = await mk('story', 'Story A', e1.id);
  const b = await mk('story', 'Story B', e1.id);
  const c = await mk('story', 'Story C', e2.id);
  const y = await mk('subtask', 'Subtask Y', a.id);
  const x = await mk('subtask', 'Subtask X', b.id);
  const g = await mk('bug', 'Bug G', b.id);
  return { e1, e2, a, b, c, y, x, g };
}

const linkCount = () => adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('link_work_items — a cross-LEVEL dependency is refused', () => {
  it('subtask blocked_by story → CROSS_LEVEL_LINK naming both keys and levels; nothing written', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const refused = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'blocked_by',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('CROSS_LEVEL_LINK');
    expect(text(refused)).toContain(t.x.identifier);
    expect(text(refused)).toContain(t.a.identifier);
    expect(text(refused)).toMatch(/level: leaf/);
    expect(text(refused)).toMatch(/level: story/);
    expect(await linkCount()).toBe(0);
    await client.close();
  });

  it('`blocks` is judged in its stored direction — story blocks subtask is refused too', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const refused = await call(client, 'link_work_items', {
      fromKey: t.a.identifier,
      toKey: t.x.identifier,
      relationship: 'blocks',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('CROSS_LEVEL_LINK');
    expect(await linkCount()).toBe(0);
    await client.close();
  });

  it('an epic blocked_by a subtask is refused through the service with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await expect(
      workItemsService.linkWorkItems(
        { fromId: t.e2.id, toId: t.y.id, kind: 'is_blocked_by' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
  });
});

describe('link_work_items — a SAME-level dependency across parents is created', () => {
  it('subtask→subtask across stories, story→story across epics, bug→subtask, subtask→bug (same story)', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    for (const [from, to] of [
      [t.x, t.y],
      [t.c, t.a],
      [t.g, t.y],
      [t.x, t.g],
    ] as const) {
      const made = await call(client, 'link_work_items', {
        fromKey: from.identifier,
        toKey: to.identifier,
        relationship: 'blocked_by',
      });
      expect(made.isError, text(made)).toBeFalsy();
    }
    expect(await linkCount()).toBe(4);
    await client.close();
  });

  it('`relates_to` between a subtask and a story is never judged', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const made = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'relates_to',
    });
    expect(made.isError, text(made)).toBeFalsy();
    await client.close();
  });
});

describe('createWorkItem with links — the same rule on the create path', () => {
  it('a new subtask created blocked_by a STORY rolls the whole create back', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const before = await adminDb.workItem.count();

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'subtask',
          title: 'Born cross-level',
          parentId: t.b.id,
          links: [{ targetId: t.a.id, relationship: 'blocked_by' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
    expect(await adminDb.workItem.count()).toBe(before);
  });

  it('a new STORY created as a blocker of a subtask (`blocks`) is refused in the stored direction', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'story',
          title: 'Blocks a leaf',
          parentId: t.e1.id,
          links: [{ targetId: t.x.id, relationship: 'blocks' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossLevelLinkError);
  });

  it('a same-level link across parents is created with the item', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const made = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Born same-level',
        parentId: t.b.id,
        links: [{ targetId: t.y.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: made.id, toId: t.y.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);
  });
});

describe('validate_work_item — an EXISTING cross-level edge is an advisory, never a verdict', () => {
  it('a story child blocked_by an EPIC yields one `cross-level-edge` shape advisory; `valid` is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);

    const before = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(before.isError, text(before)).toBeFalsy();
    const validBefore = (before.structuredContent as { valid: boolean }).valid;

    // Seeded below every door — the shape an edge drawn before the rule has.
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: t.b.id,
        toId: t.e2.id,
        kind: 'is_blocked_by',
        createdById: fx.ctx.userId,
      },
    });

    const after = await call(client, 'validate_work_item', { key: t.e1.identifier });
    expect(after.isError, text(after)).toBeFalsy();
    const verdict = after.structuredContent as {
      valid: boolean;
      advisories: Array<Record<string, unknown>>;
    };
    // `valid` is decided by finishability alone: E2 is outside E1's subtree and
    // not done, so it gates — which is the old rule, untouched by the advisory.
    expect(verdict.valid).toBe(false);
    expect(validBefore).toBe(true);
    const crossLevel = verdict.advisories.filter((a) => a.severity === 'cross-level-edge');
    expect(crossLevel).toEqual([
      {
        kind: 'shape',
        item: t.b.identifier,
        severity: 'cross-level-edge',
        blockedBy: t.e2.identifier,
        itemKind: 'story',
        itemLevel: 'story',
        blockedByKind: 'epic',
        blockedByLevel: 'epic',
      },
    ]);
    expect(text(after)).toContain('blocked_by an item on ANOTHER LEVEL');
    await client.close();
  });

  it('`valid` does not move when the cross-level blocker is INSIDE the subtree', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: t.y.id,
        toId: t.b.id,
        kind: 'is_blocked_by',
        createdById: fx.ctx.userId,
      },
    });
    const client = await connectClient(fx.ctx);
    const res = await call(client, 'validate_work_item', { key: t.e1.identifier });
    const verdict = res.structuredContent as {
      valid: boolean;
      advisories: Array<Record<string, unknown>>;
    };
    expect(verdict.valid).toBe(true);
    expect(verdict.advisories.filter((a) => a.severity === 'cross-level-edge')).toHaveLength(1);
    await client.close();
  });
});

describe('the link form copy', () => {
  it('maps CROSS_LEVEL_LINK to its own catalog key', () => {
    const t = (key: string) => key;
    const err = new CrossLevelLinkError(
      { key: 'ACME-2', kind: 'subtask', level: 'leaf' },
      { key: 'ACME-1', kind: 'story', level: 'story' },
    );
    expect(linkErrorMessage(err, t)).toBe('links.crossLevel');
  });
});
