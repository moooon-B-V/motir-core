import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  codeGraphChangedPathsService,
  CHANGED_PATHS_LIMITS,
} from '@/lib/services/codeGraphChangedPathsService';
import { codeGraphPendingChangeRepository } from '@/lib/repositories/codeGraphPendingChangeRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// THE CHANGED PATHS A PUSH ALREADY NAMED (Story MOTIR-3249 · Subtask MOTIR-3358),
// against real Postgres — the claim is a row lock and a `RETURNING`, so a fake
// client would prove nothing about the only property that matters.
//
// What this file is really about is ONE asymmetry: offering a list that is
// incomplete produces a graph that is quietly wrong and that nothing downstream
// can detect, while offering NO list costs a whole-tree sync — which is exactly
// what ships today. So every ambiguous case must resolve to "no list", and each
// test below is one of those cases.

const PASSWORD = 'correct horse battery staple';

interface Fixture {
  workspaceId: string;
  key: { installationId: string; repoOwner: string; repoName: string };
}

async function seed(): Promise<Fixture> {
  const email = `changed-paths-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  return {
    workspaceId: workspace.id,
    key: {
      installationId: `inst-${randomToken(5)}`,
      repoOwner: 'moooon-B-V',
      repoName: `repo-${randomToken(5)}`,
    },
  };
}

async function push(fx: Fixture, paths: string[], headSha: string | null = 'a'.repeat(40)) {
  await codeGraphChangedPathsService.recordPush({
    ...fx.key,
    workspaceId: fx.workspaceId,
    headSha,
    paths,
  });
}

async function pendingCount(fx: Fixture): Promise<number> {
  return withSystemContext((tx) => codeGraphPendingChangeRepository.countForRepo(fx.key, tx));
}

beforeEach(async () => {
  await adminDb.codeGraphPendingChange.deleteMany({});
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('accumulating what each push touched', () => {
  it('unions across pushes the debounce would have collapsed', async () => {
    // The reason this is a table and not a field on the event: `codeGraphRefresh`
    // debounces 2 minutes per repo and a debounce delivers only the LAST event, so
    // a run standing for three pushes would carry one push's paths and leave the
    // other two pushes' files stale.
    const fx = await seed();
    await push(fx, ['a.ts', 'b.ts'], 'sha1'.padEnd(40, '0'));
    await push(fx, ['b.ts', 'c.ts'], 'sha2'.padEnd(40, '0'));
    await push(fx, ['d.ts'], 'sha3'.padEnd(40, '0'));

    const claim = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    expect(claim.usable).toBe(true);
    if (!claim.usable) return;
    expect(claim.paths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(claim.claimedRows).toBe(3);
  });

  it('pins to the NEWEST head, because that is the tree the container will fetch', async () => {
    // The list describes a tree. An unpinned tarball is whatever the branch points
    // at when the CONTAINER fetches — later than the dispatch — so the dispatch
    // pins the fetch to this sha, and the two travel together or not at all.
    const fx = await seed();
    await push(fx, ['a.ts'], 'older'.padEnd(40, '0'));
    await new Promise((r) => setTimeout(r, 5));
    await push(fx, ['b.ts'], 'newest'.padEnd(40, '0'));

    const claim = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    expect(claim.usable && claim.headSha).toBe('newest'.padEnd(40, '0'));
  });

  it('keeps one repo out of another repo’s claim', async () => {
    const mine = await seed();
    const theirs = await seed();
    await push(mine, ['a.ts']);
    await push(theirs, ['b.ts']);

    const claim = await codeGraphChangedPathsService.claim(mine.key, 'run-1');
    expect(claim.usable && claim.paths).toEqual(['a.ts']);
    expect(await pendingCount(theirs)).toBe(1);
  });
});

describe('every ambiguous case declines the list', () => {
  it('a push that did not name its paths poisons the whole union', async () => {
    // THE LOAD-BEARING CASE. A force-push, or a payload GitHub truncated at its
    // commit cap, arrives with no paths — and the OTHER rows still look complete.
    // Indexing them would leave the unknown push's files stale.
    const fx = await seed();
    await push(fx, ['a.ts']);
    await push(fx, []); // unknown
    await push(fx, ['c.ts']);

    const claim = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    expect(claim).toMatchObject({ usable: false, reason: 'a-push-did-not-name-its-paths' });
    // …and it is still CLAIMED, so the settle below decides its fate rather than
    // it being silently dropped.
    expect(claim.claimedRows).toBe(3);
  });

  it('declines when there is no head to pin the tree to', async () => {
    const fx = await seed();
    await push(fx, ['a.ts'], null);
    expect(await codeGraphChangedPathsService.claim(fx.key, 'run-1')).toMatchObject({
      usable: false,
      reason: 'no-head-sha-to-pin-the-tree-to',
    });
  });

  it('declines a union too large to be worth handing over', async () => {
    const fx = await seed();
    const many = Array.from(
      { length: CHANGED_PATHS_LIMITS.MAX_CHANGED_PATHS + 1 },
      (_, i) => `f${i}.ts`,
    );
    await push(fx, many);
    expect(await codeGraphChangedPathsService.claim(fx.key, 'run-1')).toMatchObject({
      usable: false,
      reason: 'too-many-changed-paths',
    });
  });

  it('declines when there is nothing pending at all', async () => {
    const fx = await seed();
    expect(await codeGraphChangedPathsService.claim(fx.key, 'run-1')).toEqual({
      usable: false,
      reason: 'no-pending-changes',
      claimedRows: 0,
    });
  });
});

describe('the claim survives a failure — rows are held, never consumed', () => {
  it('a SUCCESSFUL index deletes them; the next run sees nothing', async () => {
    const fx = await seed();
    await push(fx, ['a.ts']);
    await codeGraphChangedPathsService.claim(fx.key, 'run-1');

    expect(await codeGraphChangedPathsService.settle('run-1', true)).toBe(1);
    expect(await pendingCount(fx)).toBe(0);
  });

  it('a FAILED index releases them, and the next run claims them again', async () => {
    // The property the whole table exists for. A consumed-then-failed row leaves
    // its files stale in the graph forever, and nothing downstream can tell.
    const fx = await seed();
    await push(fx, ['a.ts']);
    await push(fx, ['b.ts']);
    const first = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    expect(first.usable).toBe(true);

    expect(await codeGraphChangedPathsService.settle('run-1', false)).toBe(2);
    expect(await pendingCount(fx)).toBe(2);

    const second = await codeGraphChangedPathsService.claim(fx.key, 'run-2');
    expect(second.usable && second.paths).toEqual(['a.ts', 'b.ts']);
  });

  it('a run that DECLINED the list still releases it', async () => {
    // Declining is not consuming: those paths still describe work the graph has
    // not absorbed, so the next run must see them.
    const fx = await seed();
    await push(fx, ['a.ts']);
    await push(fx, []);
    const claim = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    expect(claim.usable).toBe(false);

    await codeGraphChangedPathsService.settle('run-1', false);
    expect(await pendingCount(fx)).toBe(2);
  });

  it('a SECOND run cannot take rows the first is holding', async () => {
    // One statement does the claim and the read, so two concurrent runs for one
    // repo cannot both index the same delta and both delete it.
    const fx = await seed();
    await push(fx, ['a.ts']);

    const first = await codeGraphChangedPathsService.claim(fx.key, 'run-1');
    const second = await codeGraphChangedPathsService.claim(fx.key, 'run-2');
    expect(first.usable).toBe(true);
    expect(second).toMatchObject({ usable: false, reason: 'no-pending-changes' });
  });

  it('RECLAIMS a stale claim, so a crashed supervisor cannot strand a repo', async () => {
    // Reclaiming early costs one whole-tree sync — which is what happens today —
    // while never reclaiming costs a repo its incremental path forever.
    const fx = await seed();
    await push(fx, ['a.ts']);
    await codeGraphChangedPathsService.claim(fx.key, 'run-1');

    const later = new Date(Date.now() + CHANGED_PATHS_LIMITS.CLAIM_STALE_AFTER_MS + 60_000);
    const reclaimed = await codeGraphChangedPathsService.claim(fx.key, 'run-2', later);
    expect(reclaimed.usable && reclaimed.paths).toEqual(['a.ts']);
  });
});

describe('recording is best-effort and never fails the webhook ack', () => {
  it('swallows a write it cannot make', async () => {
    // The fast path is the optional one. A dropped record costs a whole-tree sync;
    // a thrown webhook costs GitHub a delivery failure and Motir a redelivery.
    await expect(
      codeGraphChangedPathsService.recordPush({
        installationId: 'inst-x',
        repoOwner: 'o',
        repoName: 'r',
        workspaceId: 'a-workspace-that-does-not-exist',
        headSha: 'a'.repeat(40),
        paths: ['a.ts'],
      }),
    ).resolves.toBeUndefined();
  });
});
