import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentsService } from '@/lib/services/commentsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { attachCommentCounts, commentCountMarker } from '@/lib/mcp/commentCounts';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The per-row COMMENT-COUNT projection for the MCP work-item reads (MOTIR-2001)
// over real Postgres. Three layers, one contract — the shape MOTIR-1842's edge
// block established, applied to the discussion signal:
//
//   repository — `countByWorkItemIds`, ONE `groupBy` for any page size, empty
//     input short-circuiting WITHOUT a query, workspace-scoped.
//   service    — `getCommentCountsForItems`, keyed by item id, TOTAL (a `0`,
//     never a missing key) and — the load-bearing claim — ONE query for a page
//     of ANY size. Asserted by spying on the Prisma delegate itself, so the
//     count is real queries, not repository calls.
//   transport  — all FIVE reads (`get_work_item` on the ITEM, `list_ready`,
//     `search_work_items`, `next_ready`, `claim_next_ready`) attach the
//     IDENTICAL `commentCount` and render the IDENTICAL text marker.
//
// The two assertions that would hurt most if they broke:
//   * the count EQUALS `commentsService.listComments(...).totalCount` for the
//     same item — the badge and the thread behind it can never disagree; and
//   * a discussion-free row renders byte-identical to what it rendered before
//     the field existed (the promise `edgeMarker` holds for an edge-free row).

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const mk = (fx: WorkItemFixture, title: string) =>
  workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);

const say = (fx: WorkItemFixture, itemId: string, bodyMd: string, parentCommentId?: string) =>
  commentsService.addComment(itemId, { bodyMd, parentCommentId }, fx.ctx);

/** Count REAL comment-aggregate queries issued while `run` executes. */
async function countCommentQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  const spy = vi.spyOn(db.comment, 'groupBy');
  const result = await run();
  const queries = spy.mock.calls.length;
  spy.mockRestore();
  return { result, queries };
}

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'comment-counts', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Create a sprint holding the given items and START it — `claim_next_ready`'s scope. */
async function activeSprintWith(fx: WorkItemFixture, itemIds: string[]): Promise<void> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
  await db.workItem.updateMany({ where: { id: { in: itemIds } }, data: { sprintId: sprint.id } });
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
}

type Row = { id: string; commentCount: number };
const rows = (r: CallToolResult) => (r.structuredContent as { items: Row[] }).items;
const itemOf = (r: CallToolResult) => (r.structuredContent as { item: Row }).item;
const textOf = (r: CallToolResult) => JSON.stringify(r.content);

describe('commentRepository.countByWorkItemIds — the batched leaf', () => {
  it('short-circuits on an empty id set WITHOUT issuing a query', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countCommentQueries(() =>
      commentRepository.countByWorkItemIds([], fx.workspaceId),
    );
    expect(result).toEqual([]);
    expect(queries).toBe(0);
  });

  it('buckets every id in ONE query, replies INCLUDED', async () => {
    const fx = await makeWorkItemFixture();
    const discussed = await mk(fx, 'Discussed');
    const quiet = await mk(fx, 'Quiet');
    const root = await say(fx, discussed.id, 'the opening argument');
    await say(fx, discussed.id, 'a reply', root.id);
    await say(fx, quiet.id, 'one word');

    const { result, queries } = await countCommentQueries(() =>
      commentRepository.countByWorkItemIds([discussed.id, quiet.id], fx.workspaceId),
    );
    expect(queries).toBe(1);
    expect([...result].sort((a, b) => a.count - b.count)).toEqual([
      { workItemId: quiet.id, count: 1 },
      { workItemId: discussed.id, count: 2 },
    ]);
  });

  it('is SPARSE — an id with no comments produces no bucket (the service seeds the zero)', async () => {
    const fx = await makeWorkItemFixture();
    const silent = await mk(fx, 'Silent');

    expect(await commentRepository.countByWorkItemIds([silent.id], fx.workspaceId)).toEqual([]);
  });

  it('is workspace-scoped — another tenant’s comments are never counted', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await mk(b, 'Their card');
    await say(b, theirs.id, 'their discussion');

    // The far tenant's own read sees it; a caller scoped to workspace A does not.
    expect(await commentRepository.countByWorkItemIds([theirs.id], b.workspaceId)).toEqual([
      { workItemId: theirs.id, count: 1 },
    ]);
    expect(await commentRepository.countByWorkItemIds([theirs.id], a.workspaceId)).toEqual([]);
  });
});

describe('commentsService.getCommentCountsForItems — the batched projection', () => {
  it('is TOTAL — every requested id gets a number, `0` for the ones with no bucket', async () => {
    const fx = await makeWorkItemFixture();
    const discussed = await mk(fx, 'Discussed');
    const silent = await mk(fx, 'Silent');
    await say(fx, discussed.id, 'a word');

    const counts = await commentsService.getCommentCountsForItems(
      [discussed.id, silent.id],
      fx.ctx,
    );
    expect(counts).toEqual({ [discussed.id]: 1, [silent.id]: 0 });
    // Not merely falsy — the field must be a NUMBER, never undefined.
    expect(typeof counts[silent.id]).toBe('number');
  });

  it('short-circuits an empty page to `{}` without touching the DB', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countCommentQueries(() =>
      commentsService.getCommentCountsForItems([], fx.ctx),
    );
    expect(result).toEqual({});
    expect(queries).toBe(0);
  });

  it('costs ONE query whatever the page size — 1 row and 25 rows alike', async () => {
    const fx = await makeWorkItemFixture();
    const many: string[] = [];
    for (let i = 0; i < 25; i++) {
      const item = await mk(fx, `Item ${i}`);
      many.push(item.id);
      if (i % 3 === 0) await say(fx, item.id, `comment on ${i}`);
    }

    const one = await countCommentQueries(() =>
      commentsService.getCommentCountsForItems(many.slice(0, 1), fx.ctx),
    );
    const all = await countCommentQueries(() =>
      commentsService.getCommentCountsForItems(many, fx.ctx),
    );
    expect(one.queries).toBe(1);
    expect(all.queries).toBe(1); // does NOT scale with the page — the N+1 this card forbids
    expect(Object.keys(all.result)).toHaveLength(25);
  });

  it('EQUALS listComments’ totalCount for the same item — replies included', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Argued over');
    const root = await say(fx, item.id, 'the opening argument');
    await say(fx, item.id, 'first reply', root.id);
    await say(fx, item.id, 'second reply', root.id);
    await say(fx, item.id, 'a separate thread');

    const counts = await commentsService.getCommentCountsForItems([item.id], fx.ctx);
    const page = await commentsService.listComments(item.id, {}, fx.ctx);
    expect(counts[item.id]).toBe(page.totalCount);
    expect(counts[item.id]).toBe(4);
  });

  it('never counts a comment the caller could not read (cross-tenant)', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await mk(b, 'Their card');
    await say(b, theirs.id, 'their discussion');

    // A caller in workspace A handing over B's id gets the seeded zero, not B's total.
    expect(await commentsService.getCommentCountsForItems([theirs.id], a.ctx)).toEqual({
      [theirs.id]: 0,
    });
    expect(await commentsService.getCommentCountsForItems([theirs.id], b.ctx)).toEqual({
      [theirs.id]: 1,
    });
  });
});

describe('the `commentCount` field on the five MCP reads', () => {
  it('get_work_item carries it on the ITEM — and NOT on the child rows', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The story' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'A child', parentId: story.id },
      fx.ctx,
    );
    await say(fx, story.id, 'a word on the story');
    await say(fx, child.id, 'a word on the child');

    const res = await runGetWorkItem({ key: story.identifier }, fx.ctx);
    const structured = res.structuredContent as {
      item: { commentCount: number };
      children: Record<string, unknown>[];
    };
    expect(structured.item.commentCount).toBe(1);
    // The scope boundary: the aggregate answers for THIS card; the list reads
    // answer per row. A child badge here would invite rendering a whole
    // subtree's discussion state from a single-card read.
    expect(structured.children[0]).not.toHaveProperty('commentCount');
  });

  it('get_work_item reports `0` for a card nobody has commented on', async () => {
    const fx = await makeWorkItemFixture();
    const silent = await mk(fx, 'Silent');

    const res = await runGetWorkItem({ key: silent.identifier }, fx.ctx);
    expect((res.structuredContent as { item: Row }).item.commentCount).toBe(0);
  });

  it('list_ready carries it on every row, `0` included', async () => {
    const fx = await makeWorkItemFixture();
    const discussed = await mk(fx, 'Discussed');
    const silent = await mk(fx, 'Silent');
    await say(fx, discussed.id, 'one');
    await say(fx, discussed.id, 'two');

    const items = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    expect(items.find((r) => r.id === discussed.id)!.commentCount).toBe(2);
    expect(items.find((r) => r.id === silent.id)!.commentCount).toBe(0);
  });

  it('search_work_items carries the IDENTICAL number for the same item', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Discussed');
    await say(fx, item.id, 'one');
    await say(fx, item.id, 'two');
    await say(fx, item.id, 'three');

    const readyRow = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === item.id,
    )!;
    const searchRow = rows(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === item.id,
    )!;
    expect(searchRow.commentCount).toBe(readyRow.commentCount);
    expect(searchRow.commentCount).toBe(3);
  });

  it('next_ready carries it on the dispatch payload', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Dispatch me');
    await say(fx, item.id, 'read this before you start');

    const dispatched = itemOf(await runNextReady({ projectKey: 'PROD' }, fx.ctx));
    expect(dispatched.id).toBe(item.id);
    expect(dispatched.commentCount).toBe(1);
  });

  it('claim_next_ready carries the SAME number the peek reported', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Claim me');
    await say(fx, item.id, 'a caveat');
    await say(fx, item.id, 'another caveat');
    await activeSprintWith(fx, [item.id]);

    const peeked = itemOf(await runNextReady({ projectKey: 'PROD' }, fx.ctx));
    const claimed = itemOf(await runClaimNextReady({ projectKey: 'PROD' }, fx.ctx));
    expect(claimed.id).toBe(item.id);
    expect(claimed.commentCount).toBe(peeked.commentCount);
    expect(claimed.commentCount).toBe(2);
  });

  it('a page of N rows still costs ONE comment query through the real tool', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 20; i++) {
      const item = await mk(fx, `Item ${i}`);
      if (i % 2 === 0) await say(fx, item.id, `comment ${i}`);
    }

    const { result, queries } = await countCommentQueries(() =>
      runListReady({ projectKey: 'PROD' }, fx.ctx),
    );
    expect(rows(result)).toHaveLength(20);
    expect(queries).toBe(1);
    expect(rows(result).filter((r) => r.commentCount > 0)).toHaveLength(10);
  });

  it('an empty page asks the DB nothing and still answers', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countCommentQueries(() =>
      runListReady({ projectKey: 'PROD' }, fx.ctx),
    );
    expect(rows(result)).toEqual([]);
    expect(queries).toBe(0);
  });

  it('leaves the rest of each row untouched — the web DTOs are not widened', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Discussed');
    await say(fx, item.id, 'a word');

    const row = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx))[0]! as Record<
      string,
      unknown
    >;
    // The row is still the `ReadyItemDto` the /ready page reads, plus the two
    // TRANSPORT attachments — nothing renamed, nothing dropped.
    const { commentCount, dependencies, ...rest } = row;
    expect(commentCount).toBe(1);
    expect(dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(rest).toMatchObject({ id: item.id, key: item.identifier, title: 'Discussed' });
  });
});

describe('the text marker', () => {
  it('appears on a discussed row, and a silent list renders WITHOUT it', async () => {
    const fx = await makeWorkItemFixture();
    const silent = await mk(fx, 'Silent');

    const before = textOf(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    expect(before).not.toContain('comment');

    await say(fx, silent.id, 'someone spoke');
    const after = textOf(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    expect(after).toContain('· 1 comment');
  });

  it('a silent page is BYTE-IDENTICAL to the same page with the marker stripped', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Quiet then loud');

    const silentText = textOf(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    await say(fx, item.id, 'one');
    await say(fx, item.id, 'two');
    const loudText = textOf(await runListReady({ projectKey: 'PROD' }, fx.ctx));

    expect(loudText).not.toBe(silentText);
    expect(loudText.replace(' · 2 comments', '')).toBe(silentText);
  });

  it('pluralizes — one comment reads singular', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Discussed');
    await say(fx, item.id, 'just the one');

    expect(textOf(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx))).toContain(
      '· 1 comment',
    );
    await say(fx, item.id, 'and another');
    expect(textOf(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx))).toContain(
      '· 2 comments',
    );
  });

  it('rides the dispatch and detail summaries too', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Dispatch me');
    await say(fx, item.id, 'a caveat');

    expect(textOf(await runNextReady({ projectKey: 'PROD' }, fx.ctx))).toContain('· 1 comment');
    expect(textOf(await runGetWorkItem({ key: item.identifier }, fx.ctx))).toContain('· 1 comment');
  });
});

describe('the five tools advertise the field, and it survives the real transport', () => {
  it('every read’s tools/list description names `commentCount`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    for (const name of [
      'get_work_item',
      'list_ready',
      'search_work_items',
      'next_ready',
      'claim_next_ready',
    ]) {
      expect(tools.find((t) => t.name === name)!.description).toContain('`commentCount`');
    }
    // …and `get_work_item` says WHERE it rides, so nobody expects a child badge.
    expect(tools.find((t) => t.name === 'get_work_item')!.description).toContain(
      'not the child rows',
    );
    await client.close();
  });

  it('the number survives a real tool call over the transport', async () => {
    const fx = await makeWorkItemFixture();
    const item = await mk(fx, 'Discussed');
    await say(fx, item.id, 'one');

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'search_work_items',
      arguments: { projectKey: 'PROD' },
    })) as CallToolResult;
    expect(rows(res).find((r) => r.id === item.id)!.commentCount).toBe(1);
    await client.close();
  });
});

describe('attachCommentCounts', () => {
  it('is TOTAL — a row the projection had no entry for still gets `0`', () => {
    expect(attachCommentCounts([{ id: 'a' }, { id: 'b' }], { a: 3 })).toEqual([
      { id: 'a', commentCount: 3 },
      { id: 'b', commentCount: 0 },
    ]);
  });

  it('leaves the row’s own fields untouched', () => {
    expect(attachCommentCounts([{ id: 'a', title: 'Keep me' }], {})[0]).toMatchObject({
      id: 'a',
      title: 'Keep me',
      commentCount: 0,
    });
  });
});

describe('commentCountMarker', () => {
  it('renders nothing at zero or for an absent projection', () => {
    expect(commentCountMarker(0)).toBe('');
    expect(commentCountMarker(undefined)).toBe('');
  });

  it('renders the count, singular at one', () => {
    expect(commentCountMarker(1)).toBe(' · 1 comment');
    expect(commentCountMarker(2)).toBe(' · 2 comments');
    expect(commentCountMarker(42)).toBe(' · 42 comments');
  });
});
