import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The DELIVERY LINK, over real Postgres (Story MOTIR-3655 · MOTIR-3657, ADR
// `docs/decisions/work-item-delivery-links.md`).
//
// What this file pins, and why each is here rather than assumed:
//
//   1. BOTH DIRECTIONS. One card with two pull requests in two repositories is two
//      rows; one pull request delivering three cards is three rows. Neither was
//      expressible before this table — the first because `work_item.sessionBranch`
//      is a scalar, the second because `github_pull_request.work_item_id` is — and
//      they are the whole reason it exists.
//   2. `add` is IDEMPOTENT. Deliveries redeliver and agents retry, so a repeat
//      `link_pull_request` must be a no-op rather than an error or a second row.
//   3. RLS. The row's OWN `workspace_id` is the gate; a bound read from workspace A
//      sees nothing of workspace B.
//   4. THE MIGRATION'S BACKFILL, executed as the SHIPPED SQL rather than a copy of
//      it — the file is read and its INSERT statements are run. A backfill
//      asserted by reading the SQL is not asserted. ⚠️ Only PASS 2 is replayable
//      now: pass 1 selects `github_pull_request.work_item_id`, which MOTIR-3757
//      dropped, so on any current database that statement raises. Pass 1 is a
//      historical one-shot over a column that no longer exists and cannot be
//      re-asserted; the file is still read, and this suite still checks that it
//      ships exactly two INSERTs, so a change to it is not silent.
//   5. `work_item.sessionBranch` still works. MOTIR-3734 decided that column is
//      the integration LINEAGE and STAYS — it is not the sibling scalar's twin —
//      so a reader that regressed here would still be invisible.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** A GitHub repository in this fixture's workspace, with its installation. */
async function addRepo(fx: WorkItemFixture, name: string): Promise<{ id: string }> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
    select: { id: true },
  });
}

let nextPrNumber = 1;

/** A pull request on a repository. It carries NO association with a work item —
 *  `github_pull_request.work_item_id` was dropped by MOTIR-3757, and a delivery
 *  row is the only thing that links one. */
async function addPr(
  repoId: string,
  opts: { headRef?: string; merged?: boolean } = {},
): Promise<{ id: string }> {
  return adminDb.githubPullRequest.create({
    data: {
      repoId,
      number: nextPrNumber++,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef: opts.headRef ?? `subtask/PROD-1-${randomToken(4)}`,
      baseRef: 'main',
      provider: 'github',
    },
    select: { id: true },
  });
}

describe('the delivery link expresses BOTH directions', () => {
  it('one card delivered by two pull requests in two repositories is TWO rows', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'spans two repos' });
    const core = await addRepo(fx, 'motir-core');
    const ai = await addRepo(fx, 'motir-ai');

    // ⚠️ The SAME branch name in both repositories — the runbook's convention, and
    // the case a branch-KEYED link could not tell apart (`findBySessionBranch` is
    // workspace-scoped, not repository-scoped). Keyed on the pull-request ROW it is
    // unambiguous.
    const branch = 'subtask/PROD-9-two-homes';
    const corePr = await addPr(core.id, { headRef: branch });
    const aiPr = await addPr(ai.id, { headRef: branch });

    await withWorkspaceContext(fx.ctx, async (tx) => {
      await workItemDeliveryRepository.add(
        {
          workspaceId: fx.workspaceId,
          workItemId: card.id,
          githubPullRequestId: corePr.id,
          repoId: core.id,
        },
        tx,
      );
      await workItemDeliveryRepository.add(
        {
          workspaceId: fx.workspaceId,
          workItemId: card.id,
          githubPullRequestId: aiPr.id,
          repoId: ai.id,
        },
        tx,
      );
    });

    const set = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItem(card.id, tx),
    );

    expect(set).toHaveLength(2);
    expect(new Set(set.map((d) => d.repoId))).toEqual(new Set([core.id, ai.id]));
    // The repository is on the ROW, so the gate can compare each member against its
    // own default branch without a join per member.
    expect(set.every((d) => d.repo.defaultBranch === 'main')).toBe(true);
  });

  it('one pull request delivering three cards is THREE rows', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: 'motir/auto-run-1' });
    const cards: Awaited<ReturnType<typeof createTestWorkItem>>[] = [];
    for (const title of ['first', 'second', 'third']) {
      cards.push(await createTestWorkItem(fx, { kind: 'task', title }));
    }

    await withWorkspaceContext(fx.ctx, async (tx) => {
      for (const card of cards) {
        await workItemDeliveryRepository.add(
          {
            workspaceId: fx.workspaceId,
            workItemId: card.id,
            githubPullRequestId: pr.id,
            repoId: repo.id,
          },
          tx,
        );
      }
    });

    const delivered = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.listByPullRequest(pr.id, tx),
    );

    // The direction the singular FK could not express AT ALL: a `motir auto` pull
    // request answers with every card of its run.
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered.map((d) => d.workItemId))).toEqual(new Set(cards.map((c) => c.id)));
  });
});

describe('add is idempotent and remove is a door', () => {
  it('a repeat link for the same (card, pull request) writes no second row and does not throw', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'redelivered' });
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id);
    const row = {
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    };

    const first = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.add(row, tx),
    );
    // A redelivery, and an agent retry after one — neither may error.
    const second = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.add(row, tx),
    );
    const third = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.add(row, tx),
    );

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    const set = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItem(card.id, tx),
    );
    expect(set).toHaveLength(1);
  });

  it('remove reports whether it removed anything', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'mistaken link' });
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id);

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.add(
        {
          workspaceId: fx.workspaceId,
          workItemId: card.id,
          githubPullRequestId: pr.id,
          repoId: repo.id,
        },
        tx,
      ),
    );

    const removed = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.remove(card.id, pr.id, tx),
    );
    const again = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.remove(card.id, pr.id, tx),
    );

    expect(removed).toBe(1);
    expect(again).toBe(0);
  });
});

describe('RLS gates the row by its OWN workspace', () => {
  it("a bound read in workspace A returns nothing of workspace B's deliveries", async () => {
    const a = await makeWorkItemFixture({ name: 'Alpha', identifier: 'ALP' });
    const b = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRV' });
    const bCard = await createTestWorkItem(b, { kind: 'task', title: "bravo's card" });
    const bRepo = await addRepo(b, 'bravo-core');
    const bPr = await addPr(bRepo.id);

    await withWorkspaceContext(b.ctx, (tx) =>
      workItemDeliveryRepository.add(
        {
          workspaceId: b.workspaceId,
          workItemId: bCard.id,
          githubPullRequestId: bPr.id,
          repoId: bRepo.id,
        },
        tx,
      ),
    );

    // Bravo sees its own row…
    const own = await withWorkspaceContext(b.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItem(bCard.id, tx),
    );
    expect(own).toHaveLength(1);

    // …and Alpha sees nothing of it, through either direction of the table.
    const crossByItem = await withWorkspaceContext(a.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItem(bCard.id, tx),
    );
    const crossByPr = await withWorkspaceContext(a.ctx, (tx) =>
      workItemDeliveryRepository.listByPullRequest(bPr.id, tx),
    );
    expect(crossByItem).toEqual([]);
    expect(crossByPr).toEqual([]);
  });
});

describe("the migration's BACKFILL, run as the shipped SQL", () => {
  const MIGRATION = join(
    process.cwd(),
    'prisma/migrations/20260827094500_work_item_delivery/migration.sql',
  );

  /** The INSERT statements the migration ships, extracted from the file itself so
   *  this asserts the SHIPPED SQL and cannot drift from a copy of it. Both are
   *  returned — the count is part of what is asserted — but only the REPLAYABLE
   *  one is run; see `replayable`. */
  function backfillStatements(): string[] {
    const sql = readFileSync(MIGRATION, 'utf8');
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.includes('INSERT INTO "work_item_delivery"'));
    expect(statements).toHaveLength(2);
    return statements;
  }

  /** ⚠️ PASS 1 IS NOT REPLAYABLE and its exclusion is a fact about the schema, not
   *  a narrowing of this suite. It reads `pr."work_item_id"`, which MOTIR-3757
   *  dropped, so running it against a current database raises
   *  `column pr.work_item_id does not exist`. It was a one-shot over a column that
   *  is gone; pass 2 keys on `head_ref` and still runs. Selecting by the JOIN it
   *  performs rather than by position, so a re-ordering of the file cannot silently
   *  swap which statement this executes. */
  function replayable(): string[] {
    const chosen = backfillStatements().filter((s) => s.includes('w."sessionBranch"'));
    expect(chosen).toHaveLength(1);
    return chosen;
  }

  async function replayBackfill(): Promise<void> {
    await adminDb.$executeRawUnsafe('DELETE FROM "work_item_delivery"');
    for (const statement of replayable()) {
      await adminDb.$executeRawUnsafe(statement);
    }
  }

  // ⚠️ THE PASS-1 BEHAVIOUR TEST IS RETIRED (MOTIR-3757), and this is what is left
  // of it. It seeded a pull request carrying `work_item_id` and asserted the
  // migration wrote one delivery for it; the column is dropped, so the fixture it
  // needed cannot be built and the statement it exercised cannot run. What CAN
  // still be asserted is that the shipped file has not been edited out from under
  // this suite — two INSERTs, and the one keyed on the link column is still the
  // first of them.
  it('the shipped migration still carries BOTH passes, pass 1 first', () => {
    const [first, second] = backfillStatements();
    expect(first).toContain('pr."work_item_id"');
    expect(second).toContain('w."sessionBranch"');
  });

  it('pass 2 writes TWO rows when one session branch matches pull requests in two repositories', async () => {
    const fx = await makeWorkItemFixture();
    const branch = 'motir/auto-abc123';
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'auto-run card' });
    await adminDb.workItem.update({ where: { id: card.id }, data: { sessionBranch: branch } });
    const core = await addRepo(fx, 'motir-core');
    const ai = await addRepo(fx, 'motir-ai');
    const corePr = await addPr(core.id, { headRef: branch });
    const aiPr = await addPr(ai.id, { headRef: branch });

    await replayBackfill();

    const rows = await adminDb.workItemDelivery.findMany({ where: { workItemId: card.id } });
    // Two repositories, one branch name: TWO deliveries, which is the correct
    // answer rather than an ambiguity to collapse. Both really do deliver the card.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.githubPullRequestId))).toEqual(new Set([corePr.id, aiPr.id]));
    expect(new Set(rows.map((r) => r.repoId))).toEqual(new Set([core.id, ai.id]));
  });

  it('a session branch that matches NO pull request writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'unpushed branch' });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { sessionBranch: 'subtask/PROD-1-never-pushed' },
    });
    await addRepo(fx, 'motir-core');

    await replayBackfill();

    // Nothing to reference, so no row — the card carries an empty delivery set,
    // which is the same state as a card that never had a branch.
    expect(await adminDb.workItemDelivery.findMany({ where: { workItemId: card.id } })).toEqual([]);
  });

  it('is IDEMPOTENT — a second application inserts nothing further', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'applied twice' });
    const branch = 'motir/auto-idempotent';
    await adminDb.workItem.update({ where: { id: card.id }, data: { sessionBranch: branch } });
    const repo = await addRepo(fx, 'motir-core');
    await addPr(repo.id, { headRef: branch });

    await replayBackfill();
    const afterFirst = await adminDb.workItemDelivery.count();
    // The operator paths that repair a bad deploy can re-run a migration; a backfill
    // that doubles its rows turns a recovery into a second incident.
    for (const statement of replayable()) {
      await adminDb.$executeRawUnsafe(statement);
    }
    const afterSecond = await adminDb.workItemDelivery.count();

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it('inserts nothing on a database with no pull requests', async () => {
    const fx = await makeWorkItemFixture();
    await createTestWorkItem(fx, { kind: 'task', title: 'no deliveries anywhere' });

    await replayBackfill();

    expect(await adminDb.workItemDelivery.count()).toBe(0);
  });
});

describe('what the CONTRACT step left standing', () => {
  // The predecessor of this test asserted that the EXPAND step dropped NEITHER
  // scalar. MOTIR-3757 dropped one of them and MOTIR-3734 decided the other stays,
  // so the pair came apart — and the surviving half is worth pinning precisely
  // because the two were written down together and read as one thing.
  it('`work_item.sessionBranch` is still written and still read', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'lineage reader' });
    const repo = await addRepo(fx, 'motir-core');
    const branch = 'subtask/PROD-3-legacy';
    await adminDb.workItem.update({ where: { id: card.id }, data: { sessionBranch: branch } });
    await addPr(repo.id, { headRef: branch });

    const reread = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(reread.sessionBranch).toBe(branch);
  });

  it('a pull-request row carries NO work-item column at all', async () => {
    const columns = await adminDb.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'github_pull_request'`;
    const names = columns.map((c) => c.column_name);
    // The drop, asserted where it happened rather than inferred from a green
    // suite — and its sibling asserted at the same moment, because "dropped
    // `work_item_id`" and "dropped the link columns" are different claims and
    // MOTIR-3757 made only the first.
    expect(names).not.toContain('work_item_id');
    expect(names).toContain('linked_manually');
  });
});
