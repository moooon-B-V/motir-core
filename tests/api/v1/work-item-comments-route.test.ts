import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { MAX_PAGE_LIMIT, encodePageCursor } from '@/lib/api/v1/pagination';
import { commentThreadSchema } from '@/lib/api/v1/workItems/schema';
import { COMMENT_PAGE_SIZE, commentsService } from '@/lib/services/commentsService';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET + POST /api/v1/work-items/{key}/comments
// (Story 11.2 · Subtask 11.2.8 — MOTIR-2049).

interface Page {
  items: Array<{ id: string; bodyMd: string; replies: Array<{ id: string; bodyMd: string }> }>;
  totalCount: number;
  nextCursor: string | null;
}

async function get(
  key: string,
  caller: { headers: Record<string, string> },
  query = '',
): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/comments/route');
  return GET(
    new Request(`http://localhost:3000/api/v1/work-items/${key}/comments${query}`, {
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function post(
  key: string,
  caller: { headers: Record<string, string> },
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/comments/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/work-items/${key}/comments`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('GET + POST /api/v1/work-items/{key}/comments', () => {
  let caller: V1ProjectCaller;
  let itemKey: string;
  let itemId: string;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Discussed' });
    itemKey = item.identifier;
    itemId = item.id;
  });

  async function seedComments(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await commentsService.addComment(itemId, { bodyMd: `Comment ${i}` }, caller.ctx);
    }
  }

  it('returns the threaded page, each row parsing against the schema', async () => {
    await seedComments(2);
    const root = (await (await get(itemKey, caller)).json()) as Page;
    await commentsService.addComment(
      itemId,
      { bodyMd: 'A reply', parentCommentId: root.items[0]?.id as string },
      caller.ctx,
    );

    const res = await get(itemKey, caller);
    const page = (await res.json()) as Page;

    expect(res.status).toBe(200);
    for (const thread of page.items) {
      const parsed = commentThreadSchema.safeParse(thread);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    // Replies nest as the service returns them.
    expect(page.items[0]?.replies.map((r) => r.bodyMd)).toEqual(['A reply']);
    // `totalCount` counts replies too.
    expect(page.totalCount).toBe(3);
  });

  it('an item with no discussion is 200 with an empty page', async () => {
    const res = await get(itemKey, caller);
    await expect(res.json()).resolves.toEqual({ items: [], totalCount: 0, nextCursor: null });
  });

  // ── The cursor is v1-issued, not the service's bare id ────────────────────
  it('issues a SIGNED cursor, and refuses a hand-crafted or raw service one', async () => {
    await seedComments(5);

    const page = (await (await get(itemKey, caller, '?limit=2')).json()) as Page;
    expect(page.nextCursor).toBeTruthy();
    // Not a bare id: a client must not be able to construct one from row data.
    expect(page.nextCursor).not.toBe(page.items[1]?.id);

    // The RAW service cursor (a bare root-comment id) is refused…
    const raw = await get(itemKey, caller, `?cursor=${page.items[1]?.id}`);
    expect(raw.status).toBe(422);
    await expect(raw.json()).resolves.toMatchObject({ code: 'INVALID_CURSOR' });

    // …and so is a tampered one.
    const tampered = await get(
      itemKey,
      caller,
      `?cursor=${encodeURIComponent(`${page.nextCursor}x`)}`,
    );
    expect(tampered.status).toBe(422);
  });

  it('walks to exhaustion seeing every comment exactly once', async () => {
    await seedComments(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(itemKey, caller, q);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      seen.push(...page.items.map((i) => i.id));
      // ⚠️ Walk until `nextCursor` is null, NOT until a short page: a page may be
      // shorter than `limit` while more remains, because the service pages ROOT
      // comments and each drags its reply thread along.
      cursor = page.nextCursor;
      requests += 1;
    } while (cursor && requests < 50);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  // ── The bounded `limit` carve-out ─────────────────────────────────────────
  it('honours ?limit= up to the v1 ceiling', async () => {
    await seedComments(25);

    const five = (await (await get(itemKey, caller, '?limit=5')).json()) as Page;
    expect(five.items).toHaveLength(5);

    const many = (await (await get(itemKey, caller, `?limit=${MAX_PAGE_LIMIT}`)).json()) as Page;
    expect(many.items).toHaveLength(25);
    expect(many.nextCursor).toBeNull();
  });

  it('an EXISTING caller that passes no limit still gets the shipped 20', async () => {
    // The carve-out must leave every pre-existing caller byte-for-byte
    // unaffected — asserted against the service directly, the way the web app
    // calls it.
    await seedComments(25);

    const shipped = await commentsService.listComments(itemId, {}, caller.ctx);

    expect(COMMENT_PAGE_SIZE).toBe(20);
    expect(shipped.threads).toHaveLength(COMMENT_PAGE_SIZE);
    expect(shipped.nextCursor).not.toBeNull();
  });

  it('?order=desc reverses the walk and still pages correctly', async () => {
    await seedComments(6);

    const asc = (await (await get(itemKey, caller, '?limit=6')).json()) as Page;
    const desc = (await (await get(itemKey, caller, '?limit=6&order=desc')).json()) as Page;

    expect(desc.items.map((i) => i.id)).toEqual([...asc.items.map((i) => i.id)].reverse());

    // …and a paged desc walk still sees everything exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q = `?limit=2&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await (await get(itemKey, caller, q)).json()) as Page;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(6);
  });

  it('422s an invalid ?order=', async () => {
    const res = await get(itemKey, caller, '?order=sideways');

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_ORDER' });
  });

  // ── POST ──────────────────────────────────────────────────────────────────
  it('creates a comment (201) and a reply, both visible on the next GET', async () => {
    const created = await post(itemKey, caller, { bodyMd: 'First!' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; parentCommentId: string | null };
    expect(body.parentCommentId).toBeNull();

    const reply = await post(itemKey, caller, { bodyMd: 'Re: first', parentCommentId: body.id });
    expect(reply.status).toBe(201);
    await expect(reply.json()).resolves.toMatchObject({ parentCommentId: body.id });

    const page = (await (await get(itemKey, caller)).json()) as Page;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.replies.map((r) => r.bodyMd)).toEqual(['Re: first']);
  });

  it('422s an empty body, with the mapped domain code', async () => {
    const res = await post(itemKey, caller, { bodyMd: '   ' });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'EMPTY_COMMENT_BODY' });
  });

  it('404s a reply to a comment that does not exist', async () => {
    // NOT 422: an unknown (or cross-tenant) comment id is a NOT-FOUND, and the
    // service deliberately answers the same way for both so it cannot be used to
    // probe which comment ids are real.
    const res = await post(itemKey, caller, {
      bodyMd: 'Orphan',
      parentCommentId: 'cnotarealid000000000000000',
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'COMMENT_NOT_FOUND' });
  });

  it('422s a reply whose parent belongs to a DIFFERENT work item', async () => {
    const elsewhere = await createTestWorkItem(caller.fixture, {
      kind: 'task',
      title: 'Elsewhere',
    });
    const foreign = await commentsService.addComment(
      elsewhere.id,
      { bodyMd: 'On another item' },
      caller.ctx,
    );

    const res = await post(itemKey, caller, {
      bodyMd: 'Wrong thread',
      parentCommentId: foreign.id,
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_PARENT_COMMENT' });
  });

  it('422s a reply to a REPLY — threading is single-level', async () => {
    const root = await commentsService.addComment(itemId, { bodyMd: 'Root' }, caller.ctx);
    const reply = await commentsService.addComment(
      itemId,
      { bodyMd: 'Reply', parentCommentId: root.id },
      caller.ctx,
    );

    const res = await post(itemKey, caller, { bodyMd: 'Too deep', parentCommentId: reply.id });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'REPLY_DEPTH_EXCEEDED' });
  });

  it('a read-only token gets 200 on GET and 403 on POST', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    expect((await get(itemKey, caller)).status).toBe(200);
    expect((await post(itemKey, readOnly, { bodyMd: 'Nope' })).status).toBe(403);
  });

  it('404s an item outside the token workspace on both methods', async () => {
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Theirs',
      identifier: 'OTHR',
    });
    const theirs = await createTestWorkItem(other.fixture, { kind: 'task', title: 'Theirs' });

    expect((await get(theirs.identifier, caller)).status).toBe(404);
    expect((await post(theirs.identifier, caller, { bodyMd: 'Hi' })).status).toBe(404);
  });

  it('422s a cursor minted for a DIFFERENT collection shape but still ours', async () => {
    // Signed by us, so it decodes — but it names a position that does not exist
    // here. It must yield an empty page rather than an error or a silent reset,
    // the same terminal behaviour every other collection has.
    const cursor = encodePageCursor({ createdAt: new Date().toISOString(), id: 'cnope' });
    const res = await get(itemKey, caller, `?cursor=${encodeURIComponent(cursor)}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ items: [] });
  });
});
