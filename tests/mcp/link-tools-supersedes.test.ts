import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runLinkWorkItems, runUnlinkWorkItems } from '@/lib/mcp/tools/linkWorkItems';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// The `supersedes` LINK KIND end to end (Story MOTIR-6574 · MOTIR-6580), over
// real Postgres: the storage enum, `link_work_items` / `unlink_work_items` with
// both directions of the pair, the two detail groups `get_work_item` reads, the
// guards every kind shares (duplicate, self, cross-workspace), no reciprocal,
// and — the load-bearing negative — no effect on readiness or the ready set.
// Direction: `from` is the NEWER item, `to` the OLDER one it replaces.

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

function makeTask(ctx: ServiceContext, projectId: string, title: string): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind: 'task', title }, ctx);
}

async function groups(
  projectId: string,
  identifier: string,
  ctx: ServiceContext,
): Promise<{ supersedes: string[]; supersededBy: string[]; relatesTo: string[] }> {
  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx);
  return {
    supersedes: detail.supersedes.map((l) => l.item.identifier),
    supersededBy: detail.supersededBy.map((l) => l.item.identifier),
    relatesTo: detail.relatesTo.map((l) => l.item.identifier),
  };
}

/** Every link row between the two items, any kind, either direction. */
function rowsBetween(a: string, b: string) {
  return adminDb.workItemLink.findMany({
    where: {
      OR: [
        { fromId: a, toId: b },
        { fromId: b, toId: a },
      ],
    },
    select: { fromId: true, toId: true, kind: true },
  });
}

describe('the work_item_link_kind enum', () => {
  it('holds five values, `supersedes` among them', async () => {
    const rows = await adminDb.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::"work_item_link_kind"))::text AS v`;
    expect(rows.map((r) => r.v)).toEqual([
      'is_blocked_by',
      'relates_to',
      'duplicates',
      'clones',
      'supersedes',
    ]);
  });
});

describe('link_work_items — supersedes / superseded_by', () => {
  it('"A supersedes B" stores ONE row (A, B, supersedes), no reciprocal, read on both ends', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const a = await makeTask(fx.ctx, fx.projectId, 'A (newer)');
    const b = await makeTask(fx.ctx, fx.projectId, 'B (older)');

    const res = await client.callTool({
      name: 'link_work_items',
      arguments: { fromKey: a.identifier, toKey: b.identifier, relationship: 'supersedes' },
    });
    expect(res.isError).toBeFalsy();
    const link = res.structuredContent as { kind: string; relationship: string; fromId: string };
    expect(link).toMatchObject({ kind: 'supersedes', relationship: 'supersedes', fromId: a.id });

    // Exactly one row, directed newer → older, and NO relates_to beside it.
    expect(await rowsBetween(a.id, b.id)).toEqual([
      { fromId: a.id, toId: b.id, kind: 'supersedes' },
    ]);

    expect(await groups(fx.projectId, a.identifier, fx.ctx)).toEqual({
      supersedes: [b.identifier],
      supersededBy: [],
      relatesTo: [],
    });
    expect(await groups(fx.projectId, b.identifier, fx.ctx)).toEqual({
      supersedes: [],
      supersededBy: [a.identifier],
      relatesTo: [],
    });

    // get_work_item (the tool) carries both groups and prints both lines.
    const onA = await client.callTool({ name: 'get_work_item', arguments: { key: a.identifier } });
    const onB = await client.callTool({ name: 'get_work_item', arguments: { key: b.identifier } });
    const aPayload = onA.structuredContent as {
      supersedes: { item: { identifier: string } }[];
      supersededBy: unknown[];
    };
    const bPayload = onB.structuredContent as {
      supersedes: unknown[];
      supersededBy: { item: { identifier: string } }[];
    };
    expect(aPayload.supersedes.map((l) => l.item.identifier)).toEqual([b.identifier]);
    expect(aPayload.supersededBy).toEqual([]);
    expect(bPayload.supersededBy.map((l) => l.item.identifier)).toEqual([a.identifier]);
    expect(bPayload.supersedes).toEqual([]);
    expect(JSON.stringify(onA.content)).toContain(`Supersedes: ${b.identifier}`);
    expect(JSON.stringify(onB.content)).toContain(`Superseded by: ${a.identifier}`);
    expect(JSON.stringify(onA.content)).not.toContain('Superseded by:');

    await client.close();
  });

  it('"B superseded_by A" stores the SAME row; a second call of EITHER form is an idempotent no-op', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A (newer)');
    const b = await makeTask(fx.ctx, fx.projectId, 'B (older)');

    const first = await runLinkWorkItems(
      { fromKey: b.identifier, toKey: a.identifier, relationship: 'superseded_by' },
      fx.ctx,
    );
    expect(first.isError).toBeFalsy();
    expect((first.structuredContent as { fromId: string; toId: string }).fromId).toBe(a.id);
    expect(await rowsBetween(a.id, b.id)).toEqual([
      { fromId: a.id, toId: b.id, kind: 'supersedes' },
    ]);

    for (const args of [
      { fromKey: b.identifier, toKey: a.identifier, relationship: 'superseded_by' as const },
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'supersedes' as const },
    ]) {
      const again = await runLinkWorkItems(args, fx.ctx);
      expect(again.isError).toBeFalsy();
      expect((again.structuredContent as { idempotent?: boolean }).idempotent).toBe(true);
    }
    expect(await rowsBetween(a.id, b.id)).toHaveLength(1);
  });

  it('refuses a self-link', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');

    for (const relationship of ['supersedes', 'superseded_by'] as const) {
      const res = await runLinkWorkItems(
        { fromKey: a.identifier, toKey: a.identifier, relationship },
        fx.ctx,
      );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('SELF_LINK');
    }
    expect(await adminDb.workItemLink.count({ where: { fromId: a.id } })).toBe(0);
  });

  it('refuses a cross-workspace target as not-found, at the tool and at the service', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const a = await makeTask(mine.ctx, mine.projectId, 'Mine');
    const foreign = await makeTask(theirs.ctx, theirs.projectId, 'Theirs');

    const res = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: foreign.identifier, relationship: 'supersedes' },
      mine.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);

    await expect(
      workItemsService.linkWorkItems(
        { fromId: a.id, toId: foreign.id, kind: 'supersedes' },
        mine.ctx,
      ),
    ).rejects.toThrow(WorkItemNotFoundError);
    expect(await adminDb.workItemLink.count({ where: { fromId: a.id } })).toBe(0);
  });

  it('allows a cross-PROJECT target in the same workspace, as every other kind does', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIDE',
    });
    const a = await makeTask(fx.ctx, fx.projectId, 'Newer here');
    const b = await makeTask(fx.ctx, other.id, 'Older there');

    const res = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'supersedes' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((await groups(other.id, b.identifier, fx.ctx)).supersededBy).toEqual([a.identifier]);
  });

  it('changes NOTHING about readiness or the ready set — only is_blocked_by gates', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A (newer)');
    const b = await makeTask(fx.ctx, fx.projectId, 'B (older)');

    await runLinkWorkItems(
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'supersedes' },
      fx.ctx,
    );

    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(true);
    const detailA = await workItemsService.getIssueDetail(fx.projectId, a.identifier, fx.ctx);
    const detailB = await workItemsService.getIssueDetail(fx.projectId, b.identifier, fx.ctx);
    expect(detailA.readiness.openBlockers).toEqual([]);
    expect(detailB.readiness.openBlockers).toEqual([]);
    expect(detailA.blockedBy).toEqual([]);
    expect(detailB.blocks).toEqual([]);

    // Two supersedes edges in opposite directions are not a cycle error: no cycle
    // guard applies to this kind (only `is_blocked_by` is a scheduling graph).
    const reverse = await runLinkWorkItems(
      { fromKey: b.identifier, toKey: a.identifier, relationship: 'supersedes' },
      fx.ctx,
    );
    expect(reverse.isError).toBeFalsy();
  });
});

describe('unlink_work_items — supersedes / superseded_by', () => {
  it.each(['supersedes', 'superseded_by'] as const)(
    'removing by "%s" drops the one row and both groups read empty',
    async (relationship) => {
      const fx = await makeWorkItemFixture();
      const a = await makeTask(fx.ctx, fx.projectId, 'A (newer)');
      const b = await makeTask(fx.ctx, fx.projectId, 'B (older)');
      await runLinkWorkItems(
        { fromKey: a.identifier, toKey: b.identifier, relationship: 'supersedes' },
        fx.ctx,
      );

      // The same edge, named from whichever end the relationship reads from.
      const args =
        relationship === 'supersedes'
          ? { fromKey: a.identifier, toKey: b.identifier, relationship }
          : { fromKey: b.identifier, toKey: a.identifier, relationship };
      const res = await runUnlinkWorkItems(args, fx.ctx);
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { removed: boolean }).removed).toBe(true);

      expect(await rowsBetween(a.id, b.id)).toEqual([]);
      expect(await groups(fx.projectId, a.identifier, fx.ctx)).toMatchObject({
        supersedes: [],
        supersededBy: [],
      });
      expect(await groups(fx.projectId, b.identifier, fx.ctx)).toMatchObject({
        supersedes: [],
        supersededBy: [],
      });

      const again = await runUnlinkWorkItems(args, fx.ctx);
      expect((again.structuredContent as { removed: boolean }).removed).toBe(false);
    },
  );
});

describe('listLinkCandidates — the superseded_by direction reads the IN edge', () => {
  it('excludes an item already superseding the subject from "superseded_by", not from "supersedes"', async () => {
    const fx = await makeWorkItemFixture();
    const subject = await makeTask(fx.ctx, fx.projectId, 'Subject node');
    const newer = await makeTask(fx.ctx, fx.projectId, 'Newer node');
    await runLinkWorkItems(
      { fromKey: subject.identifier, toKey: newer.identifier, relationship: 'superseded_by' },
      fx.ctx,
    );
    const ids = async (rel: 'supersedes' | 'superseded_by') =>
      (await workItemsService.listLinkCandidates(subject.id, rel, 'node', fx.ctx)).map((c) => c.id);

    expect(await ids('superseded_by')).not.toContain(newer.id);
    expect(await ids('supersedes')).toContain(newer.id);
  });
});
