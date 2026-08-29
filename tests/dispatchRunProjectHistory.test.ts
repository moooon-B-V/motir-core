import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  DISPATCH_RUN_LIST_MAX_TAKE,
  DISPATCH_RUN_LIVE_STATUSES,
  DISPATCH_RUN_PAST_STATUSES,
  dispatchRunService,
} from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { countDelegateCalls } from './helpers/countDelegateCalls';
import { truncateAuthTables } from './helpers/db';

// `dispatchRunService.listRunsForProject` (Story MOTIR-1789 · MOTIR-3922) — the
// PROJECT's run history, against a real Postgres.
//
// ⚠️ THE ONE READ THAT STARTS FROM THE PROJECT. The three that shipped before it
// each start from something the caller already holds — a run id, a card known to
// be in the set, or the live set — so a run that finished last night could not be
// found at all. The properties asserted here are the ones that decide whether the
// surface built on it (the runs index, MOTIR-3923) can be trusted at scale: the
// narrowings are applied by the QUERY, the page is bounded, the cursor is total,
// and the row costs no follow-up query.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A container with `count` leaf children, created through the real service. */
async function seedStory(
  fx: WorkItemFixture,
  count: number,
): Promise<{ storyKey: string; keys: string[] }> {
  const parent = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'A story a run works' },
    fx.ctx,
  );
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: parent.id, title: `Card ${i + 1}` },
      fx.ctx,
    );
    keys.push(child.identifier);
  }
  return { storyKey: parent.identifier, keys };
}

/** Open a run over `keys`, optionally scoped, optionally closed. */
async function openRun(
  fx: WorkItemFixture,
  opts: {
    keys: string[];
    scopeKey?: string;
    command?: 'next' | 'run' | 'batch' | 'auto';
    close?: 'completed' | 'halted' | 'interrupted';
  },
): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: opts.command ?? 'batch',
      ...(opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
      cards: opts.keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  if (opts.close) {
    await dispatchRunService.close(run.id, { stopReason: opts.close }, fx.ctx);
  }
  return run.id;
}

const list = (page: Parameters<typeof dispatchRunService.listRunsForProject>[1]) =>
  dispatchRunService.listRunsForProject(fixture.projectIdentifier, page, fixture.ctx);

describe('the project is the handle — every run, newest first', () => {
  it('returns the project’s runs with their set SUMMARISED, not listed', async () => {
    const { keys } = await seedStory(fixture, 3);
    const older = await openRun(fixture, { keys, close: 'completed' });
    const newer = await openRun(fixture, { keys: keys.slice(0, 1) });

    const runs = await list({ take: 10 });

    expect(runs.map((r) => r.id)).toEqual([newer, older]);
    // The set is a COUNT, and the count is TOTAL over the disposition enum —
    // a zero is a real answer, so no renderer downstream meets an `undefined`.
    expect(runs[0]).toMatchObject({ cardCount: 1, status: 'running' });
    expect(runs[0]!.legs).toEqual({
      queued: 1,
      running: 0,
      integrated: 0,
      implemented: 0,
      failed: 0,
      replanned: 0,
      skipped: 0,
      not_reached: 0,
    });
    // Closing settled all three queued legs to `not_reached` — the summary is
    // read off the legs, never off the run's own status.
    expect(runs[1]).toMatchObject({ cardCount: 3, status: 'succeeded' });
    expect(runs[1]!.legs.not_reached).toBe(3);
    expect(runs[1]!.legs.queued).toBe(0);
    // No leg array on the wire at all — that is the run VIEW's shape, not this one.
    expect(runs[0]).not.toHaveProperty('cards');
  });

  it('reads a run with NO cards as a real row rather than an error', async () => {
    const empty = await openRun(fixture, { keys: [] });
    const [row] = await list({ take: 10 });
    expect(row).toMatchObject({ id: empty, cardCount: 0 });
    expect(Object.values(row!.legs).every((n) => n === 0)).toBe(true);
  });
});

describe('the narrowings are applied by the QUERY, never to the page', () => {
  it('partitions live from past, and agrees with the active read on the same data', async () => {
    const { keys } = await seedStory(fixture, 2);
    const live = await openRun(fixture, { keys });
    const done = await openRun(fixture, { keys, close: 'completed' });
    const halted = await openRun(fixture, { keys, close: 'halted' });

    expect(
      (await list({ take: 10, statuses: DISPATCH_RUN_LIVE_STATUSES })).map((r) => r.id),
    ).toEqual([live]);
    expect(
      (await list({ take: 10, statuses: DISPATCH_RUN_PAST_STATUSES })).map((r) => r.id).sort(),
    ).toEqual([done, halted].sort());

    // ⚠️ THE TWO READS MUST NOT DISAGREE ABOUT *LIVE*. `listActiveRunsForProject`
    // is a second answer to the same question, and the day they diverge one
    // surface says a run is going and another says it finished.
    const active = await dispatchRunService.listActiveRunsForProject(
      fixture.projectIdentifier,
      fixture.ctx,
    );
    expect(active.map((r) => r.id)).toEqual([live]);
  });

  it('scopes to the runs a CONTAINER is the scope OF — not to its children’s runs', async () => {
    const { storyKey, keys } = await seedStory(fixture, 2);
    const scoped = await openRun(fixture, { keys, scopeKey: storyKey, command: 'run' });
    await openRun(fixture, { keys, command: 'batch' });

    // A scoped run's legs are the container's CHILDREN, so the story has no leg
    // of its own and would never appear in its own card history. This is the
    // only way to ask for a container's runs.
    expect((await list({ take: 10, scopeWorkItemKey: storyKey })).map((r) => r.id)).toEqual([
      scoped,
    ]);
    const history = await dispatchRunService.listRunsForWorkItemKey(
      storyKey,
      { take: 10 },
      fixture.ctx,
    );
    expect(history).toEqual([]);
  });

  it('refuses an unresolvable scope key rather than answering with an empty page', async () => {
    // The two are opposite answers wearing the same shape: "that story has no
    // runs" and "that story is not in this project".
    await expect(list({ take: 10, scopeWorkItemKey: 'PROD-999999' })).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('bounded, and the cursor is total', () => {
  it('clamps an over-large limit rather than honouring it', async () => {
    const { keys } = await seedStory(fixture, 1);
    for (let i = 0; i < 3; i += 1) await openRun(fixture, { keys });

    const runs = await list({ take: DISPATCH_RUN_LIST_MAX_TAKE + 5_000 });
    expect(runs).toHaveLength(3);
    // The clamp is server-side: the caller's number never reaches the query.
    expect(DISPATCH_RUN_LIST_MAX_TAKE).toBeLessThan(DISPATCH_RUN_LIST_MAX_TAKE + 5_000);
  });

  it('walks every run exactly once across pages — no duplicate, no hole', async () => {
    const { keys } = await seedStory(fixture, 1);
    const opened: string[] = [];
    for (let i = 0; i < 7; i += 1) opened.push(await openRun(fixture, { keys }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const rows = await list({ take: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 3) break;
      cursor = rows[rows.length - 1]!.id;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...opened].sort());
  });
});

describe('one query for the page, however many runs it holds', () => {
  it('summarises the legs from the include — no per-run follow-up', async () => {
    const { keys } = await seedStory(fixture, 3);
    for (let i = 0; i < 4; i += 1) await openRun(fixture, { keys });

    const runsRead = await countDelegateCalls('dispatchRun', 'findMany', () => list({ take: 10 }));
    expect(runsRead.result).toHaveLength(4);
    expect(runsRead.queries).toBe(1);

    // The N+1 this read must never acquire: one leg query per run. The counts
    // come from the `cards` the one query already included.
    const legsRead = await countDelegateCalls('dispatchRunCard', 'findMany', () =>
      list({ take: 10 }),
    );
    expect(legsRead.result).toHaveLength(4);
    expect(legsRead.queries).toBe(0);
  });
});

describe('a run belongs to its workspace, and the fixture proves the read is bound', () => {
  it('does not return another workspace’s runs — and the two populations DIFFER', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const mine = await seedStory(fixture, 1);
    const theirs = await seedStory(other, 1);

    const ours = await openRun(fixture, { keys: mine.keys });
    await openRun(other, { keys: theirs.keys });
    await openRun(other, { keys: theirs.keys });

    // ⚠️ THE ACTOR'S VIEW AND THE TRUE POPULATION ARE DELIBERATELY DIFFERENT
    // (1 vs 3). A fixture whose actor happens to see everything cannot tell a
    // scoped read from an unscoped one: both return the same number.
    expect(await adminDb.dispatchRun.count()).toBe(3);
    expect((await list({ take: 50 })).map((r) => r.id)).toEqual([ours]);

    // And the project key alone is not a key to another tenant's data.
    await expect(
      dispatchRunService.listRunsForProject(other.projectIdentifier, { take: 50 }, fixture.ctx),
    ).rejects.toBeTruthy();
  });
});
