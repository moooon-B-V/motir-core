import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/activity/route';
import { GET as GET_COMMENTS } from '@/app/api/v1/work-items/[key]/comments/route';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import {
  activityEntrySchema,
  presentActivityChange,
  type V1ActivityEntry,
} from '@/lib/api/v1/workLoop/schema';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { runGetWorkItemActivity } from '@/lib/mcp/tools/getWorkItemActivity';
import { activityService } from '@/lib/services/activityService';
import { COMMENT_PAGE_SIZE, commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/work-items/{key}/activity (Story 11.7 · Subtask 11.7.7 —
// MOTIR-2241) against real Postgres.
//
// Three properties are the card, and each has a specific way of being wrong:
//
//   • The `all` cursor is an OPAQUE COMPOSITE over two sources, scoped to its
//     VIEW. Handing an `all` cursor to `history` must be a 422 — it would decode
//     cleanly under one shared collection name and seek NOWHERE.
//   • Paging `all` over rows with IDENTICAL timestamps must return every row
//     exactly once. A stable-order bug is invisible on any fixture where the
//     rows happen to be a second apart, so the fixture below collides on purpose.
//   • An entry whose part kind the schema does not know must come back in its
//     GENERIC form. A published client meets newer servers, and one that 500s on
//     an unfamiliar part cannot be fixed by upgrading the server.

const BASE = 'http://localhost:3000/api/v1';

interface ActivityPage {
  items: V1ActivityEntry[];
  nextCursor: string | null;
  totalCount: number;
  totalComments: number | null;
  totalChanges: number | null;
}

function req(caller: V1ProjectCaller, key: string, query = ''): Promise<Response> {
  return GET(
    new Request(`${BASE}/work-items/${key}/activity${query}`, { headers: caller.headers }),
    {
      params: Promise.resolve({ key }),
    },
  );
}

async function page(caller: V1ProjectCaller, key: string, query = ''): Promise<ActivityPage> {
  const res = await req(caller, key, query);
  expect(res.status).toBe(200);
  return (await res.json()) as ActivityPage;
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
}

/** Produce a real CHANGE entry by moving the item's status. */
async function change(caller: V1ProjectCaller, id: string, status: string) {
  await workItemsService.updateStatus(id, status, caller.ctx);
}

async function comment(caller: V1ProjectCaller, id: string, bodyMd: string) {
  return commentsService.addComment(id, { bodyMd }, caller.ctx);
}

describe('GET /api/v1/work-items/{key}/activity', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('serves the ALL view by default, interleaving both kinds under one type tag', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'busy item');
    await change(caller, item.id, 'in_progress');
    await comment(caller, item.id, 'looks good');

    const body = await page(caller, item.identifier);

    for (const entry of body.items) {
      expect(() => activityEntrySchema.parse(entry)).not.toThrow();
    }
    expect(body.items.some((e) => e.type === 'comment')).toBe(true);
    expect(body.items.some((e) => e.type === 'change')).toBe(true);
    // The ranked envelope's total is the number of entries in THIS view.
    expect(body.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('serves the two narrow views, each carrying only its own kind', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'busy item');
    await change(caller, item.id, 'in_progress');
    await comment(caller, item.id, 'a remark');

    const comments = await page(caller, item.identifier, '?view=comments');
    const history = await page(caller, item.identifier, '?view=history');

    expect(comments.items.every((e) => e.type === 'comment')).toBe(true);
    expect(comments.items).toHaveLength(1);
    expect(history.items.every((e) => e.type === 'change')).toBe(true);
    expect(history.items.length).toBeGreaterThanOrEqual(1);
  });

  // ── The per-source totals (ADR Amendment 12 · MOTIR-2320) ────────────────
  //
  // The `all` view merges two streams, so "how many are there" has two answers.
  // `render.ts` prints both — "3 of 47 comments, 2 of 18 changes" — and derives
  // each as `total - shown`, which a single `totalCount` cannot supply.
  it('breaks the merged view’s total down by source, and the parts SUM to it', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'busy item');
    await change(caller, item.id, 'in_progress');
    await comment(caller, item.id, 'one');
    await comment(caller, item.id, 'two');

    const body = await page(caller, item.identifier);

    expect(body.totalComments).toBe(2);
    expect(body.totalChanges).toBeGreaterThanOrEqual(1);
    // Asserted, not assumed: `totalCount` keeps meaning the size of the view
    // that was asked for, which on `all` is the two together.
    expect(body.totalCount).toBe((body.totalComments ?? 0) + (body.totalChanges ?? 0));
  });

  it('reports NULL — never zero — for the source a narrow view did not count', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'busy item');
    await change(caller, item.id, 'in_progress');
    await comment(caller, item.id, 'a remark');

    const comments = await page(caller, item.identifier, '?view=comments');
    const history = await page(caller, item.identifier, '?view=history');

    // Each view knows its own total and nothing about the other source. A `0`
    // here would claim the item has no history / no comments, which is false —
    // this read simply did not look.
    expect(comments.totalComments).toBe(comments.totalCount);
    expect(comments.totalChanges).toBeNull();

    expect(history.totalChanges).toBe(history.totalCount);
    expect(history.totalComments).toBeNull();

    // …and the item demonstrably HAS both, which is what makes the nulls a
    // statement about the read rather than about the item.
    expect(comments.totalCount).toBeGreaterThan(0);
    expect(history.totalCount).toBeGreaterThan(0);
  });

  it('handles a source with NOTHING in it, in both directions', async () => {
    // Every item carries at least the `created` revision, so "no changes" is not
    // reachable — what IS reachable, and what the merge has to survive, is one
    // source being empty while the other is not.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const talkedAbout = await makeItem(caller, 'only talked about');
    const onlyMoved = await makeItem(caller, 'only moved');
    await comment(caller, talkedAbout.id, 'just a comment');
    await change(caller, onlyMoved.id, 'in_progress');

    const talk = await page(caller, talkedAbout.identifier);
    const moved = await page(caller, onlyMoved.identifier);

    // Comments empty on one, present on the other — and the change trail is
    // never empty, so `all` always has something to interleave against.
    expect(moved.items.some((e) => e.type === 'comment')).toBe(false);
    expect(moved.items.every((e) => e.type === 'change')).toBe(true);
    expect(talk.items.some((e) => e.type === 'comment')).toBe(true);
    expect(talk.items.some((e) => e.type === 'change')).toBe(true);
    // The narrow view over the empty source is an empty page, not a 404.
    expect((await page(caller, onlyMoved.identifier, '?view=comments')).items).toEqual([]);
  });

  it('returns an EMPTY page for an item nothing has happened to — never a 404', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'untouched');

    const body = await page(caller, item.identifier, '?view=comments');

    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.totalCount).toBe(0);
  });

  it('returns every row EXACTLY ONCE when paging `all` over identical timestamps', async () => {
    // The bug this exists to catch is invisible on a fixture where rows are a
    // second apart, so this one collides on purpose: many comments and many
    // changes written as fast as the database will take them.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'a busy hour');
    for (let i = 0; i < COMMENT_PAGE_SIZE + 5; i += 1) {
      await comment(caller, item.id, `comment ${i}`);
    }
    for (const status of ['in_progress', 'in_review', 'done', 'in_progress', 'todo']) {
      await change(caller, item.id, status);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const body: ActivityPage = await page(caller, item.identifier, query);
      for (const entry of body.items) {
        seen.push(entry.type === 'comment' ? `c:${entry.comment.id}` : `h:${entry.change.id}`);
      }
      cursor = body.nextCursor;
      guard += 1;
      expect(guard, 'the walk terminates').toBeLessThan(40);
    } while (cursor !== null);

    // Every id exactly once: no duplicate at a page boundary, and none dropped.
    expect(new Set(seen).size).toBe(seen.length);
    // …and the walk really saw everything both sources hold.
    const all = await activityService.listAll(item.id, {}, caller.ctx);
    expect(seen.length).toBe(all.totalComments + all.totalChanges);
  });

  it('round-trips its cursor as an OPAQUE value the client only echoes', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'paged');
    for (let i = 0; i < COMMENT_PAGE_SIZE + 5; i += 1) {
      await comment(caller, item.id, `comment ${i}`);
    }

    const first = await page(caller, item.identifier, '?view=comments');
    expect(first.nextCursor).not.toBeNull();
    // Opaque: not the service's own token, and not anything a client could build
    // from a row it can see.
    expect(first.nextCursor).not.toMatch(/^c[a-z0-9]{20,}$/);

    const second = await page(
      caller,
      item.identifier,
      `?view=comments&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    const firstIds = first.items.map((e) => (e.type === 'comment' ? e.comment.id : ''));
    const secondIds = second.items.map((e) => (e.type === 'comment' ? e.comment.id : ''));
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('REFUSES a cursor issued for another VIEW — 422, never a silent reset', async () => {
    // The property one shared collection name would quietly destroy: the cursor
    // would decode and then seek nowhere.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'paged');
    for (let i = 0; i < COMMENT_PAGE_SIZE + 5; i += 1) {
      await comment(caller, item.id, `comment ${i}`);
    }

    const fromAll = (await page(caller, item.identifier)).nextCursor;
    expect(fromAll).not.toBeNull();

    const res = await req(
      caller,
      item.identifier,
      `?view=history&cursor=${encodeURIComponent(fromAll as string)}`,
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
  });

  it('REFUSES a cursor from another COLLECTION, and a malformed one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'x');

    expect((await req(caller, item.identifier, '?cursor=not-a-cursor')).status).toBe(422);
    // A ready-set cursor, signed by v1 but scoped elsewhere.
    const { encodeCollectionCursor } = await import('@/lib/api/v1/pagination');
    const foreign = encodeCollectionCursor('ready', 'somewhere');
    expect(
      (await req(caller, item.identifier, `?cursor=${encodeURIComponent(foreign)}`)).status,
    ).toBe(422);
  });

  it('422s an unknown `view` and an unknown `order`', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'x');

    const badView = await req(caller, item.identifier, '?view=everything');
    expect(badView.status).toBe(422);
    expect(((await badView.json()) as { code: string }).code).toBe('INVALID_ACTIVITY_VIEW');
    expect((await req(caller, item.identifier, '?order=sideways')).status).toBe(422);
  });

  it('matches the MCP tool’s payload for the same item and view', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'two transports');
    await change(caller, item.id, 'in_progress');
    await comment(caller, item.id, 'a remark');

    const body = await page(caller, item.identifier, '?view=history');
    const tool = await runGetWorkItemActivity(
      { key: item.identifier, view: 'history' },
      caller.ctx,
    );
    const payload = tool.structuredContent as {
      entries: { id: string; changeKind: string }[];
      totalCount: number;
    };

    expect(body.totalCount).toBe(payload.totalCount);
    expect(body.items.map((e) => (e.type === 'change' ? e.change.id : ''))).toEqual(
      payload.entries.map((e) => e.id),
    );
    expect(body.items.map((e) => (e.type === 'change' ? e.change.changeKind : ''))).toEqual(
      payload.entries.map((e) => e.changeKind),
    );
  });

  it('404s a key in another workspace, and 403s a token without `read`', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['read'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read'] });
    const hidden = await makeItem(theirs, 'not yours');
    const noRead = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const item = await makeItem(noRead, 'mine');

    expect((await req(mine, hidden.identifier)).status).toBe(404);
    expect((await req(noRead, item.identifier)).status).toBe(403);
  });
});

describe('the shipped …/comments endpoint is untouched (ADR §8)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('still exists and returns its own shape, unchanged', async () => {
    // §8 forbids withdrawing it, and 11.7 does not: `?view=comments` is the same
    // data through the same read, offered beside it rather than instead of it.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'commented');
    await comment(caller, item.id, 'hello');

    const res = await GET_COMMENTS(
      new Request(`${BASE}/work-items/${item.identifier}/comments`, { headers: caller.headers }),
      { params: Promise.resolve({ key: item.identifier }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; bodyMd: string }[] };
    // Its OWN envelope: bare threads, not the activity view's tagged entries.
    expect(body.items[0]).toHaveProperty('bodyMd');
    expect(body.items[0]).not.toHaveProperty('type');
  });

  it('describes the same comment with the SAME shape on both surfaces', async () => {
    // One declaration (`presentCommentThread`), so the two cannot disagree.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'commented');
    await comment(caller, item.id, 'hello');

    const viaActivity = await page(caller, item.identifier, '?view=comments');
    const res = await GET_COMMENTS(
      new Request(`${BASE}/work-items/${item.identifier}/comments`, { headers: caller.headers }),
      { params: Promise.resolve({ key: item.identifier }) },
    );
    const viaComments = (await res.json()) as { items: unknown[] };

    const fromActivity = viaActivity.items[0];
    expect(fromActivity?.type).toBe('comment');
    expect(fromActivity?.type === 'comment' ? fromActivity.comment : null).toEqual(
      viaComments.items[0],
    );
  });
});

describe('the activity entry shape is LOOSE where the DTO is loose', () => {
  it('projects an UNKNOWN part kind onto `generic` rather than failing', () => {
    // A published client meets newer servers. A part kind this schema has never
    // seen must render as the one branch every client already handles.
    const mapped = presentActivityChange({
      id: 'rev_1',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: 'Yue' },
      parts: [{ kind: 'a-part-invented-next-year', key: 'newThing', from: 'a', to: 'b' }],
    });

    expect(mapped.parts[0]).toEqual({ kind: 'generic', key: 'newThing', from: 'a', to: 'b' });
    expect(() => activityEntrySchema.parse({ type: 'change', change: mapped })).not.toThrow();
  });

  it('degrades an UNKNOWN value type to `none` rather than failing', () => {
    const mapped = presentActivityChange({
      id: 'rev_2',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: null },
      parts: [
        {
          kind: 'field',
          field: 'somethingNew',
          from: { type: 'a-value-type-from-the-future', payload: 1 },
          to: { type: 'text', text: 'after' },
        },
      ],
    });

    expect(mapped.parts[0]).toEqual({
      kind: 'field',
      field: 'somethingNew',
      from: { type: 'none' },
      to: { type: 'text', text: 'after' },
    });
  });

  it('names a referenced work item by its KEY and drops the cuid (§7)', () => {
    const mapped = presentActivityChange({
      id: 'rev_3',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: null },
      parts: [
        {
          kind: 'link',
          op: 'added',
          linkKind: 'blocked_by',
          target: { type: 'issue', workItemId: 'cmsdw87oz000004kvypsh8m9n', identifier: 'PROD-9' },
        },
      ],
    });

    expect(JSON.stringify(mapped)).not.toContain('cmsdw87oz000004kvypsh8m9n');
    expect(mapped.parts[0]).toEqual({
      kind: 'link',
      op: 'added',
      linkKind: 'blocked_by',
      target: { type: 'issue', workItemKey: 'PROD-9' },
    });
  });

  it('carries every SHIPPED part kind through unchanged', () => {
    // The loose default must not swallow a kind the schema DOES know.
    const kinds = [
      { kind: 'created' },
      { kind: 'archived' },
      { kind: 'unarchived' },
      { kind: 'fieldEdited', field: 'descriptionMd' },
      { kind: 'collection', field: 'labels', op: 'added', items: ['bug'] },
      {
        kind: 'commentDeleted',
        author: { type: 'user', userId: 'u1', name: 'Yue' },
        replyCount: 2,
      },
    ];
    const mapped = presentActivityChange({
      id: 'rev_4',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: null },
      parts: kinds,
    });

    expect(mapped.parts.map((p) => p.kind)).toEqual([
      'created',
      'archived',
      'unarchived',
      'fieldEdited',
      'collection',
      'commentDeleted',
    ]);
  });
});

describe('the activity operation’s contract', () => {
  it('carries the scope its MCP counterpart holds, read off the shipped map', () => {
    const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'getWorkItemActivity');
    expect(op?.scope).toBe(TOOL_SCOPES.get_work_item_activity);
    expect(TOOL_SCOPES.get_work_item_activity).toBe('read');
  });

  it('tells a client to walk until `nextCursor` is null, not until a page is short', () => {
    const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'getWorkItemActivity');
    expect(op?.description).toMatch(/SHORTER/);
    expect(op?.description).toMatch(/until `nextCursor` is `null`/);
  });
});
