import { describe, expect, it } from 'vitest';
import { toProjectList, toWhoami } from '../src/adapters/reads.js';

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
