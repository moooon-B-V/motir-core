import type { GithubRepo, ProjectRepoRole, WorkItem } from '@/lib/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectRepoPinService } from '@/lib/services/projectRepoPinService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// RESOLVING a pinned ROLE to a real repository, over real Postgres (Story
// MOTIR-1775 · MOTIR-1913) — the step that makes a two-repo project's agents
// actually know where to build.
//
// The pure decision is pinned in `repoRoleResolution.test.ts`; what is pinned HERE
// is everything only a database can prove:
//
//   1. The end-to-end proof the Story's acceptance criterion asks for: a `web` +
//      `api` project whose rows both establish ends with every item carrying its
//      own half's repo name.
//   2. Every non-pinning outcome is asserted EXPLICITLY — unrouted is a correct
//      state the product renders, not a gap to paper over.
//   3. Idempotence and non-clobbering, measured through the revision log, so
//      "wrote nothing twice" is observed rather than assumed.
//   4. Partial establishment, in both orders, since the pass runs per row.
//   5. REAL CONCURRENCY against a warm pool — a serial test cannot fail the
//      lost-update case this card exists to get right.
//
// Real Postgres, no mocks (the repo convention). Tests connect as the superuser,
// so RLS is inert here by design.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect one repo to the fixture's workspace — the 7.10.3 mirror row a set row
 *  realizes against (same shape as `projectRepoSetService.test.ts`). */
async function connectRepo(
  workspaceId: string,
  name: string,
  opts: { archived?: boolean } = {},
): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}`;
  const inst = await db.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return db.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      repoId: `${name}-${Math.random().toString(36).slice(2, 10)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: opts.archived ?? false,
      provider: 'github',
    },
  });
}

/** A leaf carrying a planner-pinned repo ROLE — what materialize (MOTIR-1912)
 *  writes, and what this pass resolves. */
async function itemWithRole(
  fx: WorkItemFixture,
  title: string,
  targetRepoRole: ProjectRepoRole | null,
  targetRepo: string | null = null,
): Promise<WorkItem> {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  return db.workItem.update({ where: { id: item.id }, data: { targetRepoRole, targetRepo } });
}

async function pinOf(id: string): Promise<string | null> {
  return (await db.workItem.findUniqueOrThrow({ where: { id } })).targetRepo;
}

/** ESTABLISH a row the way the creation primitive does: claim it, then attach the
 *  mirror row — which is the seam the resolution hangs off. */
async function establish(fx: WorkItemFixture, rowId: string, repo: GithubRepo): Promise<void> {
  await projectRepoSetService.markCreating(rowId, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(rowId, repo.id, fx.ctx);
}

// ── The acceptance criterion: a two-repo project's agents are told where ─────

describe('a project whose plan pinned `web` + `api`', () => {
  it('pins EVERY web item to the web repo and every api item to the api repo', async () => {
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const webItems = [
      await itemWithRole(fx, 'The sign-in screen', 'web'),
      await itemWithRole(fx, 'The board', 'web'),
    ];
    const apiItems = [await itemWithRole(fx, 'The sessions endpoint', 'api')];
    const unpinnedByPlan = await itemWithRole(fx, 'Write the ADR', null);

    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));
    await establish(fx, api.id, await connectRepo(fx.workspaceId, 'acme-api'));

    for (const item of webItems) expect(await pinOf(item.id)).toBe('acme-web');
    expect(await pinOf(apiItems[0]!.id)).toBe('acme-api');
    // An item the planner pinned to NO role is not swept into either repo.
    expect(await pinOf(unpinnedByPlan.id)).toBeNull();
  });

  it('records ONE `targetRepo` revision per pinned item, so History reports the move', async () => {
    // MOTIR-1912 deliberately left the ROLE out of its revision diff, on the stated
    // grounds that "the resolution that follows writes `targetRepo`, which IS
    // diffed". This is that entry.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The board', 'web');

    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));

    const revisions = await db.workItemRevision.findMany({ where: { workItemId: item.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.changeKind).toBe('updated');
    expect(revisions[0]!.diff).toEqual({ targetRepo: { from: null, to: 'acme-web' } });
    expect(revisions[0]!.changedById).toBe(fx.ownerId);
  });

  it('pins the DEGENERATE single-repo project through the same path (§6)', async () => {
    const fx = await makeWorkItemFixture();
    const only = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'Everything', 'web');
    // A monorepo collapses the set to one CONNECTED row — no `creating` hop.
    await projectRepoSetService.attachRealizedRepo(
      only.id,
      (await connectRepo(fx.workspaceId, 'acme')).id,
      fx.ctx,
    );
    expect(await pinOf(item.id)).toBe('acme');
  });
});

// ── Unrouted is an ANSWER, asserted explicitly ──────────────────────────────

describe('a role that resolves to no repository', () => {
  it('leaves its items null when the row was SKIPPED', async () => {
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const apiItem = await itemWithRole(fx, 'The sessions endpoint', 'api');
    await projectRepoSetService.skipRow(api.id, fx.ctx);

    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));

    expect(await pinOf(apiItem.id)).toBeNull();
    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(result.roles.find((r) => r.role === 'api')).toMatchObject({
      outcome: 'unestablished',
      pinned: 0,
      leftUnpinned: 1,
    });
  });

  it('leaves its items null when the row FAILED, and reports them as unpinned', async () => {
    const fx = await makeWorkItemFixture();
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The sessions endpoint', 'api');
    await projectRepoSetService.markCreating(api.id, fx.ctx);
    await projectRepoSetService.markFailed(api.id, 'the name was taken', fx.ctx);

    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(await pinOf(item.id)).toBeNull();
    expect(result.pinned).toBe(0);
    expect(result.roles).toEqual([
      {
        role: 'api',
        outcome: 'unestablished',
        repoName: null,
        rowIds: [api.id],
        pinned: 0,
        leftUnpinned: 1,
      },
    ]);
  });

  it('leaves its items null when the set has NO row for the role at all', async () => {
    // The role's row was removed from the set (§5.3's third "no established row"
    // cause). The result still REPORTS the role, so the items do not vanish from
    // the picture just because nothing answers for them.
    const fx = await makeWorkItemFixture();
    const item = await itemWithRole(fx, 'The mobile shell', 'mobile');
    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(await pinOf(item.id)).toBeNull();
    expect(result.roles).toEqual([
      {
        role: 'mobile',
        outcome: 'unestablished',
        repoName: null,
        rowIds: [],
        pinned: 0,
        leftUnpinned: 1,
      },
    ]);
  });

  it('leaves its items null when TWO established rows share the role, and says why', async () => {
    const fx = await makeWorkItemFixture();
    const billing = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api-billing', label: 'billing' },
      fx.ctx,
    );
    const search = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api-search', label: 'search' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The sessions endpoint', 'api');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await establish(fx, billing.id, await connectRepo(fx.workspaceId, 'acme-api-billing'));
      await establish(fx, search.id, await connectRepo(fx.workspaceId, 'acme-api-search'));

      // Not pinned to EITHER — not after the first row established, and not after
      // the second. Guessing would send an agent into the wrong checkout.
      expect(await pinOf(item.id)).toBeNull();
      expect(await db.workItemRevision.count({ where: { workItemId: item.id } })).toBe(0);
      // The reason is RECORDED, not swallowed: the log names the rows.
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain(billing.id);
    } finally {
      warn.mockRestore();
    }

    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(result.roles.find((r) => r.role === 'api')).toMatchObject({
      outcome: 'ambiguous',
      repoName: null,
      rowIds: [billing.id, search.id],
      leftUnpinned: 1,
    });
  });
});

// ── Idempotent, non-clobbering, and resumable ───────────────────────────────

// The LIVENESS axis (MOTIR-1959) — the pin pass is where "this role resolves to
// an archived repository" turns into a decision NOT to write. Pinned over real
// Postgres because the pure test proves the verdict and this proves the WRITE
// that follows from it (or, here, the write that does not).
describe('a role whose repository is ARCHIVED', () => {
  it('writes NO pin, and reports the role as `archived` rather than unestablished', async () => {
    // The nulls are the point: `repoName` is what the pin is written from, so a
    // role that resolved to a name would pin every item of that role at a
    // repository no PR can be opened against — and the item would still read
    // `ready`, which is the MOTIR-1956 shape exactly.
    const fx = await makeWorkItemFixture();
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The sessions endpoint', 'api');
    await establish(fx, api.id, await connectRepo(fx.workspaceId, 'acme-api', { archived: true }));

    expect(await pinOf(item.id)).toBeNull();
    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(result.roles.find((r) => r.role === 'api')).toMatchObject({
      outcome: 'archived',
      repoName: null,
      pinned: 0,
      leftUnpinned: 1,
    });
    expect(result.pinned).toBe(0);
  });

  it("pins the project's OTHER roles regardless — rows are independent (ADR §4.2)", async () => {
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const webItem = await itemWithRole(fx, 'The sign-in screen', 'web');
    const apiItem = await itemWithRole(fx, 'The sessions endpoint', 'api');

    await establish(fx, api.id, await connectRepo(fx.workspaceId, 'acme-api', { archived: true }));
    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));

    expect(await pinOf(webItem.id)).toBe('acme-web');
    expect(await pinOf(apiItem.id)).toBeNull();
  });

  it('pins on the NEXT pass once the repository is un-archived — nothing else to repair', async () => {
    // The state is RECORDED, so the host-side fix is the whole fix: the role goes
    // `archived → resolved` and the pass that follows writes the pins it always
    // would have. Idempotence carries the rest.
    const fx = await makeWorkItemFixture();
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The sessions endpoint', 'api');
    const repo = await connectRepo(fx.workspaceId, 'acme-api', { archived: true });
    await establish(fx, api.id, repo);
    expect(await pinOf(item.id)).toBeNull();

    await db.githubRepo.update({ where: { id: repo.id }, data: { archived: false } });
    const result = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);

    expect(await pinOf(item.id)).toBe('acme-api');
    expect(result.roles.find((r) => r.role === 'api')).toMatchObject({
      outcome: 'resolved',
      pinned: 1,
      leftUnpinned: 0,
    });
  });

  it('never UN-pins an item that was pinned while the repository was live', async () => {
    // The pass only ever fills a null `targetRepo` (the shipped non-clobbering
    // rule), and archiving must not become the one thing that retracts a name
    // already dispatched against. The refusal belongs at DISPATCH, where the
    // reader is told why — not as a silent rewrite of recorded history.
    const fx = await makeWorkItemFixture();
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The sessions endpoint', 'api');
    const repo = await connectRepo(fx.workspaceId, 'acme-api');
    await establish(fx, api.id, repo);
    expect(await pinOf(item.id)).toBe('acme-api');

    await db.githubRepo.update({ where: { id: repo.id }, data: { archived: true } });
    await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);

    expect(await pinOf(item.id)).toBe('acme-api');
  });
});

describe('re-running the resolution', () => {
  it('is a NO-OP — nothing is written twice', async () => {
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The board', 'web');
    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));

    const again = await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(again.pinned).toBe(0);
    expect(again.roles.find((r) => r.role === 'web')).toMatchObject({
      outcome: 'resolved',
      repoName: 'acme-web',
      pinned: 0,
      leftUnpinned: 0,
    });
    // One revision, from the first pass — the second wrote no row, so it logged none.
    expect(await db.workItemRevision.count({ where: { workItemId: item.id } })).toBe(1);
  });

  it('never overwrites a pin that was set EXPLICITLY', async () => {
    // A human edit, or a §5.4 settled-name proposal. An explicit pin outranks a
    // derived one, and there is no column recording which is which — "already
    // pinned" IS the rule.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const handPinned = await itemWithRole(fx, 'The board', 'web', 'acme-legacy');
    const derived = await itemWithRole(fx, 'The sign-in screen', 'web');

    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));

    expect(await pinOf(handPinned.id)).toBe('acme-legacy');
    expect(await pinOf(derived.id)).toBe('acme-web');
    expect(await db.workItemRevision.count({ where: { workItemId: handPinned.id } })).toBe(0);
  });

  it('does NOT un-pin when the row later leaves the established states', async () => {
    // A settled row has no legal hop back, so this is forced through the column:
    // whatever the mechanism, a name already dispatched against is not retracted.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const item = await itemWithRole(fx, 'The board', 'web');
    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));
    await db.projectRepo.update({ where: { id: web.id }, data: { state: 'failed' } });

    await projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    expect(await pinOf(item.id)).toBe('acme-web');
  });

  it('resolves nothing, and does not throw, for a project with no repository set', async () => {
    const fx = await makeWorkItemFixture();
    await expect(projectRepoPinService.resolvePins(fx.projectId, fx.ctx)).resolves.toEqual({
      projectId: fx.projectId,
      roles: [],
      pinned: 0,
    });
  });

  it('404s on a project of another tenant — the same gate the set service applies', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await expect(
      projectRepoPinService.resolvePins(theirs.projectId, mine.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('a PARTIALLY established set (ADR §4 — rows are independent)', () => {
  it('pins the resolved role and leaves the failed one alone, in either order', async () => {
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const webItem = await itemWithRole(fx, 'The board', 'web');
    const apiItem = await itemWithRole(fx, 'The sessions endpoint', 'api');

    await establish(fx, web.id, await connectRepo(fx.workspaceId, 'acme-web'));
    await projectRepoSetService.markCreating(api.id, fx.ctx);
    await projectRepoSetService.markFailed(api.id, 'the name was taken', fx.ctx);

    expect(await pinOf(webItem.id)).toBe('acme-web');
    expect(await pinOf(apiItem.id)).toBeNull();

    // The retry lands. It pins the api items WITHOUT touching the web ones — which
    // the revision count proves, not just the value.
    await establish(fx, api.id, await connectRepo(fx.workspaceId, 'acme-api'));
    expect(await pinOf(apiItem.id)).toBe('acme-api');
    expect(await pinOf(webItem.id)).toBe('acme-web');
    expect(await db.workItemRevision.count({ where: { workItemId: webItem.id } })).toBe(1);
  });
});

// ── REAL concurrency ────────────────────────────────────────────────────────

describe('two SIMULTANEOUS establish calls', () => {
  it('produce one consistent pin set with no lost update, for two different roles', async () => {
    // The shape this card exists to get right: "find the unpinned items of this
    // role, then write them" is a check-then-write, and only a warm pool can fail
    // it. Both roles must end pinned to their OWN repo, each item written exactly
    // once — every legitimate interleaving satisfies that, and a lost update does
    // not.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const webItems = await Promise.all(['w1', 'w2', 'w3'].map((t) => itemWithRole(fx, t, 'web')));
    const apiItems = await Promise.all(['a1', 'a2'].map((t) => itemWithRole(fx, t, 'api')));
    const webRepo = await connectRepo(fx.workspaceId, 'acme-web');
    const apiRepo = await connectRepo(fx.workspaceId, 'acme-api');
    await projectRepoSetService.markCreating(web.id, fx.ctx);
    await projectRepoSetService.markCreating(api.id, fx.ctx);

    const results = await Promise.allSettled([
      projectRepoSetService.attachRealizedRepo(web.id, webRepo.id, fx.ctx),
      projectRepoSetService.attachRealizedRepo(api.id, apiRepo.id, fx.ctx),
    ]);
    // Different rows, so BOTH attaches are legal and both must succeed.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    for (const item of webItems) {
      expect(await pinOf(item.id)).toBe('acme-web');
      expect(await db.workItemRevision.count({ where: { workItemId: item.id } })).toBe(1);
    }
    for (const item of apiItems) {
      expect(await pinOf(item.id)).toBe('acme-api');
      expect(await db.workItemRevision.count({ where: { workItemId: item.id } })).toBe(1);
    }
  });

  it('do not pin against a SET that is changing underneath the pass', async () => {
    // What the SET lock buys, and the work-item lock cannot: the role → repo-name
    // answer is derived from the shape of the whole set, so the set must not move
    // between deriving it and writing the pins it implies. Here a second `web` row
    // is being added — which makes the role ambiguous (§1.2) — while the pass runs.
    // Without `lockByProject`, the pass reads the one-row set, resolves `web`, and
    // pins every item; the insert then commits and the project is left with items
    // pinned to one of two candidate repositories. That is the arbitrary pick §5.3
    // forbids, arrived at by a stale read.
    const fx = await makeWorkItemFixture();
    const first = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const items = await Promise.all(['w1', 'w2'].map((t) => itemWithRole(fx, t, 'web')));
    await projectRepoSetService.markCreating(first.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepoRow(
      first.id,
      (await connectRepo(fx.workspaceId, 'acme-web')).id,
      fx.ctx,
    );

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const addSecondRow = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "project_repository"
          WHERE "project_id" = ${fx.projectId} ORDER BY "id" FOR UPDATE
        `;
        await tx.projectRepo.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            role: 'web',
            name: 'acme-web-admin',
            seedSource: 'initialised',
            state: 'proposed',
            position: 'z0',
          },
        });
        await held;
      },
      { timeout: 20_000 },
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pass = projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await addSecondRow;
      const result = await pass;

      // The pass waited, re-read the set, and found the role repeated.
      expect(result.pinned).toBe(0);
      expect(result.roles.find((r) => r.role === 'web')?.outcome).toBe('ambiguous');
      for (const item of items) expect(await pinOf(item.id)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('do not log a pin an item never took, when a HAND EDIT lands mid-pass', async () => {
    // The window the WORK-ITEM row lock closes, which the set lock does not: the
    // racing writer here is not another pass, it is someone pinning an item
    // directly. Without `SELECT … FOR UPDATE` on the matched ids, the pass reads
    // the item as unpinned, its `targetRepo IS NULL` write guard correctly skips
    // it — and it logs a revision claiming a change that never happened.
    //
    // Driven deterministically by holding the row lock rather than by timing: a
    // held lock is a real interleaving, not a hope about scheduling.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const contended = await itemWithRole(fx, 'w1', 'web');
    const others = await Promise.all(['w2', 'w3'].map((t) => itemWithRole(fx, t, 'web')));
    await projectRepoSetService.markCreating(web.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepoRow(
      web.id,
      (await connectRepo(fx.workspaceId, 'acme-web')).id,
      fx.ctx,
    );

    // Hold `contended` locked and pinned, uncommitted, until the pass is blocked
    // on it. `release` is what commits the hand edit.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handEdit = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "work_item" WHERE "id" = ${contended.id} FOR UPDATE`;
        await tx.workItem.update({
          where: { id: contended.id },
          data: { targetRepo: 'acme-legacy' },
        });
        await held;
      },
      { timeout: 20_000 },
    );

    const pass = projectRepoPinService.resolvePins(fx.projectId, fx.ctx);
    // Give the pass time to reach the lock and block on it; then let the hand
    // edit commit, which is what the pass must observe.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await handEdit;
    const result = await pass;

    // The hand edit stands, and the pass says nothing about it.
    expect(await pinOf(contended.id)).toBe('acme-legacy');
    expect(await db.workItemRevision.count({ where: { workItemId: contended.id } })).toBe(0);
    // Its siblings are pinned normally — the contention costs nothing else.
    for (const item of others) expect(await pinOf(item.id)).toBe('acme-web');
    expect(result.pinned).toBe(others.length);
    // And the report counts what is really left, rather than subtracting.
    expect(result.roles.find((r) => r.role === 'web')?.leftUnpinned).toBe(0);
  });

  it('let only ONE of two concurrent resolutions write each item', async () => {
    // The narrowest form of the race: the SAME role, resolved twice at once. The
    // set lock serializes the passes, so the loser re-reads a set whose items are
    // already pinned and writes nothing — one row version, one revision.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const items = await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map((t) => itemWithRole(fx, t, 'web')),
    );
    await projectRepoSetService.markCreating(web.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepoRow(
      web.id,
      (await connectRepo(fx.workspaceId, 'acme-web')).id,
      fx.ctx,
    );

    const [a, b] = await Promise.all([
      projectRepoPinService.resolvePins(fx.projectId, fx.ctx),
      projectRepoPinService.resolvePins(fx.projectId, fx.ctx),
    ]);
    // Exactly one pass did the work; the other found nothing left. Both are
    // legitimate winners, so assert the SUM, not which one won.
    expect(a!.pinned + b!.pinned).toBe(items.length);

    for (const item of items) {
      expect(await pinOf(item.id)).toBe('acme-web');
      expect(await db.workItemRevision.count({ where: { workItemId: item.id } })).toBe(1);
    }
  });
});
