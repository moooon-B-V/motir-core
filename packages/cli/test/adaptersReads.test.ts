import { describe, expect, it } from 'vitest';
import {
  toActivityAllPage,
  toActivityHistoryPage,
  toCommentsPage,
  toProjectList,
  toWhoami,
} from '../src/adapters/reads.js';

// The READ ADAPTERS as pure functions (Subtask 11.5.4 — MOTIR-2212).
//
// `clientCore.test.ts` drives these through a real socket, which is what proves
// they are wired to the right operations. These are the cases a round trip
// cannot reach: shapes the generated types admit but a healthy server never
// sends, where the question is whether the mapper degrades or throws.

const ME = {
  user: { id: 'u1', name: 'Zhu Yue', email: 'yue@motir.test' },
  workspaceId: 'ws-1',
  scopes: ['read'],
};

describe('the paged-body fallback', () => {
  it('treats an ABSENT `items` as an empty page rather than throwing', () => {
    // The generated envelope types `items` as optional because the page envelope
    // and the item schema compose through `allOf` — so the type admits a body
    // the transport's validator would in fact reject. A mapper that assumed the
    // array would crash on a shape its own signature says is legal.
    expect(toProjectList([{ nextCursor: null } as never])).toEqual({ projects: [] });
    expect(toWhoami(ME, { nextCursor: null } as never)).toMatchObject({ workspace: null });
  });

  it('assembles across pages in the order they were walked', () => {
    const page = (key: string, nextCursor: string | null) => ({
      items: [{ key, name: key, accessLevel: 'open', archived: false }],
      nextCursor,
    });
    expect(toProjectList([page('AAA', 'c1'), page('BBB', null)] as never).projects).toEqual([
      { key: 'AAA', name: 'AAA', accessLevel: 'open' },
      { key: 'BBB', name: 'BBB', accessLevel: 'open' },
    ]);
  });
});

describe('the activity reshape', () => {
  const change = (parts: unknown[]) => ({
    type: 'change',
    change: {
      id: 'r1',
      changeKind: 'updated',
      changedAt: '2026-08-01T12:00:00.000Z',
      actor: { userId: 'u2', name: 'Mo' },
      parts,
    },
  });
  const page = (items: unknown[], over: Record<string, unknown> = {}) =>
    ({
      items,
      nextCursor: null,
      totalCount: items.length,
      totalComments: 0,
      totalChanges: 0,
      ...over,
    }) as never;

  it('maps every VALUE type, renaming the issue reference to `identifier`', () => {
    const parts = [
      { kind: 'field', field: 'a', from: { type: 'none' }, to: { type: 'text', text: 'hi' } },
      {
        kind: 'field',
        field: 'b',
        from: { type: 'status', key: 'todo', label: 'To Do' },
        to: { type: 'user', userId: 'u1', name: 'Yue' },
      },
      {
        kind: 'field',
        field: 'c',
        from: { type: 'date', date: '2026-01-01' },
        to: { type: 'sprint', sprintId: 's1', name: 'One' },
      },
      {
        kind: 'field',
        field: 'd',
        from: { type: 'issue', workItemKey: 'PROD-9' },
        to: { type: 'none' },
      },
    ];

    const [entry] = toActivityAllPage(page([change(parts)])).entries;
    const mapped = entry?.type === 'history' ? entry.entry.parts : [];

    // The one RENAME the wire forces: `workItemKey` is what v1 publishes,
    // `identifier` is what `render.ts`'s value renderer reads.
    expect(mapped[3]?.from).toEqual({ type: 'issue', identifier: 'PROD-9' });
    expect(mapped[0]?.to).toEqual({ type: 'text', text: 'hi' });
    expect(mapped[1]?.from).toEqual({ type: 'status', key: 'todo', label: 'To Do' });
    expect(mapped[1]?.to).toEqual({ type: 'user', userId: 'u1', name: 'Yue' });
    expect(mapped[2]?.to).toEqual({ type: 'sprint', sprintId: 's1', name: 'One' });
  });

  it('maps every PART kind, including the ones that carry only their kind', () => {
    const parts = [
      { kind: 'created' },
      { kind: 'fieldEdited', field: 'descriptionMd' },
      {
        kind: 'link',
        op: 'added',
        linkKind: 'blocks',
        target: { type: 'issue', workItemKey: 'P-1' },
      },
      { kind: 'collection', field: 'labels', op: 'removed', items: ['bug'] },
      {
        kind: 'commentDeleted',
        author: { type: 'user', userId: 'u1', name: 'Yue' },
        replyCount: 2,
      },
      { kind: 'generic', key: 'x', from: null, to: 'y' },
    ];

    const [entry] = toActivityAllPage(page([change(parts)])).entries;
    const mapped = entry?.type === 'history' ? entry.entry.parts : [];

    expect(mapped.map((p) => p.kind)).toEqual([
      'created',
      'fieldEdited',
      'link',
      'collection',
      'commentDeleted',
      'generic',
    ]);
    expect(mapped[2]?.target).toEqual({ type: 'issue', identifier: 'P-1' });
    expect(mapped[3]?.items).toEqual(['bug']);
    expect(mapped[4]?.replyCount).toBe(2);
    expect(mapped[5]).toEqual({ kind: 'generic', key: 'x', from: null, to: 'y' });
  });

  it('splits the three VIEWS, and echoes the order the caller asked for', () => {
    const comment = {
      type: 'comment',
      comment: {
        id: 'c1',
        parentCommentId: null,
        authorId: 'u1',
        author: { id: 'u1', name: 'Yue' },
        bodyMd: 'body',
        createdAt: '2026-07-30T12:00:00.000Z',
        editedAt: null,
        mentionedUserIds: [],
        replies: [
          {
            id: 'c2',
            parentCommentId: 'c1',
            authorId: 'u1',
            author: { id: 'u1', name: 'Yue' },
            bodyMd: 'reply',
            createdAt: '2026-07-30T12:01:00.000Z',
            editedAt: null,
            mentionedUserIds: [],
          },
        ],
      },
    };
    const body = page([comment, change([{ kind: 'created' }])], {
      totalComments: 1,
      totalChanges: 1,
    });

    expect(toActivityAllPage(body).entries.map((e) => e.type)).toEqual(['comment', 'history']);
    expect(toActivityAllPage(body)).toMatchObject({ totalComments: 1, totalChanges: 1 });

    // The comments view keeps only comments, and reports the direction the CLI
    // itself requested — `order` is not on the wire.
    const comments = toCommentsPage(body, 'desc');
    expect(comments.threads).toHaveLength(1);
    expect(comments.threads[0]?.replies).toHaveLength(1);
    expect(comments.order).toBe('desc');

    // The history view keeps only changes.
    expect(toActivityHistoryPage(body).entries).toHaveLength(1);
  });

  it('reports ZERO for a per-source total the narrow views do not compute', () => {
    // The wire sends null there — "this view did not count that source" — and
    // the `all` page's footer arithmetic needs a number.
    const body = page([], { totalComments: null, totalChanges: null });
    expect(toActivityAllPage(body)).toMatchObject({ totalComments: 0, totalChanges: 0 });
  });
});
