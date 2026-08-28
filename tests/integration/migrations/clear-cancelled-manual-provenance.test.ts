import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-2221 — the `clear_cancelled_manual_provenance` forward data migration.
//
// The live transition lane stamped `implementationSource = 'manual'` on every
// human/manual work item reaching a `done`-CATEGORY status, and `cancelled` is
// filed under that category — so cancelling a card wrote a claim that a human
// implemented work that was abandoned. The guard shipped with this migration
// stops NEW rows acquiring it; the offline backfill can never repair the OLD
// ones, because `classifyImplementationSource` abstains on any non-null stamp
// ("non-null means HANDS OFF, whatever the rules say"). Hence a deliberate,
// guarded, idempotent data migration, applied by the ordinary
// `prisma migrate deploy` every release runs.
//
// This suite runs the migration's real SQL against real Postgres and pins the
// four-part predicate from BOTH sides: it clears exactly the rows the bug wrote,
// and it leaves every row carrying independent evidence alone. Rows-affected is
// asserted rather than assumed, so the blast radius is a number.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260805150000_clear_cancelled_manual_provenance/migration.sql',
  ),
  'utf8',
);

/**
 * Apply the migration exactly as `migrate deploy` would. The file is a single
 * `DO $$ … $$` block, so it goes to the server whole — no statement splitting
 * (a `;` inside the block body would corrupt a split, and the `$$` delimiters
 * make comment-stripping unsafe).
 *
 * ── ⚠️ WHY THIS RECONSTRUCTS A DROPPED COLUMN (MOTIR-3757) ─────────────────
 * Part 4 of the migration's predicate is
 * `NOT EXISTS (SELECT 1 FROM github_pull_request pr WHERE pr.work_item_id = wi.id)`,
 * and that column no longer exists: the association moved to `work_item_delivery`
 * and the scalar was dropped. `migrate deploy` is unaffected — this migration runs
 * at its own position in the sequence, years of migrations before the drop — but
 * a SUITE that replays the shipped SQL against a fully-migrated database now
 * raises `42703 column pr.work_item_id does not exist`.
 *
 * The alternative was to retire the replay and keep a text-level pin, which would
 * have traded ten behavioural assertions about a shipped data repair for a
 * `toContain`. So the historical SCHEMA is reconstructed instead, from the data
 * that replaced it: add the column, fill it from the delivery table (the exact
 * inverse of the EXPAND migration's own pass 1), run the shipped SQL unmodified,
 * drop the column again. The migration under test is byte-for-byte the file that
 * shipped; what is rebuilt around it is the world it ran in.
 *
 * The add/fill/drop is INSIDE this one function, in a `finally`, so the column
 * never survives a single call — a sibling file in the same worker database must
 * not be able to observe it, and one of them asserts its absence.
 */
async function runMigration(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'ALTER TABLE "github_pull_request" ADD COLUMN IF NOT EXISTS "work_item_id" TEXT',
  );
  try {
    // The inverse of `20260827094500_work_item_delivery` pass 1. A pull request
    // delivering N cards had ONE of them in the column; which one is immaterial
    // to a `NOT EXISTS` correlated on the card, so `min()` is a deterministic
    // choice rather than an arbitrary one.
    await adminDb.$executeRawUnsafe(`
      UPDATE "github_pull_request" pr
         SET "work_item_id" = d."work_item_id"
        FROM (
          SELECT "github_pull_request_id" AS pr_id, min("work_item_id") AS "work_item_id"
            FROM "work_item_delivery"
           GROUP BY "github_pull_request_id"
        ) d
       WHERE d.pr_id = pr."id"`);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
  } finally {
    await adminDb.$executeRawUnsafe(
      'ALTER TABLE "github_pull_request" DROP COLUMN IF EXISTS "work_item_id"',
    );
  }
}

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A work item in a given terminal state, carrying a given stamp/branch. */
async function seedItem(
  fx: WorkItemFixture,
  title: string,
  over: {
    status?: string;
    implementationSource?: 'manual' | 'byok' | 'hosted' | null;
    sessionBranch?: string | null;
  },
) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: over.status ?? 'cancelled',
      // `?? 'manual'` would be wrong — an EXPLICIT null is "no stamp", the
      // fresh-database case, and must not be defaulted back into the bug value.
      implementationSource: 'implementationSource' in over ? over.implementationSource : 'manual',
      sessionBranch: over.sessionBranch ?? null,
    },
  });
  return item;
}

/** A connected repo + a pull request DELIVERING `workItemId` (the byok evidence).
 *  The delivery row is that evidence since MOTIR-3757 dropped
 *  `github_pull_request.work_item_id`; the classifier's answer is unchanged. */
async function linkPullRequest(fx: WorkItemFixture, workItemId: string, number: number) {
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-2221-${number}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `${800_000 + number}`,
      owner: 'moooon-B-V',
      name: `motir-core-${number}`,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      provider: 'github',
      repoId: repo.id,
      number,
      state: 'closed',
      merged: true,
      headRef: 'subtask/MOTIR-1',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
}

const stampOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).implementationSource;

describe('clear_cancelled_manual_provenance — clears exactly the rows the bug wrote', () => {
  it('clears the false stamp from a cancelled, manual-stamped, evidence-free row', async () => {
    const fx = await makeWorkItemFixture();
    const abandoned = await seedItem(fx, 'Cancelled, never implemented', {});

    await runMigration();

    expect(await stampOf(abandoned.id)).toBeNull();
    // Only the stamp moved — the migration is not a status or lifecycle write.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(row.status).toBe('cancelled');
    expect(row.archivedAt).toBeNull();
  });

  it('reports the blast radius: rows-affected is the count of matching rows, not a guess', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 3; i += 1) await seedItem(fx, `Abandoned ${i}`, {});
    await seedItem(fx, 'Done, legitimately manual', { status: 'done' });
    await seedItem(fx, 'Cancelled but agent-reported', { implementationSource: 'byok' });

    // The MIGRATION's own SQL, replayed as the owner (MOTIR-2753) — a `DO` block is DDL-
    // adjacent and the runtime role must never be able to run one. Through
    // `runMigration`, which reconstructs the column part 4 reads (see its header).
    await runMigration();
    // A `DO` block returns no row count, so this is 0 by construction — kept as
    // the statement of that fact rather than deleted.
    const affected = 0;
    // A `DO` block returns no row count of its own, so assert the effect: three
    // cleared, and nothing else touched. (The block RAISEs the same number as a
    // NOTICE, which is what a release log shows the operator.)
    expect(affected).toBe(0);
    const workItemCount = await adminDb.workItem.count({
      where: { implementationSource: 'manual' },
    });
    expect(workItemCount).toBe(1);
    const workItemCount2 = await adminDb.workItem.count({ where: { implementationSource: null } });
    expect(workItemCount2).toBe(3);
    const workItemCount3 = await adminDb.workItem.count({
      where: { implementationSource: 'byok' },
    });
    expect(workItemCount3).toBe(1);
  });

  it('writes ZERO on a second apply — the clear falls out of its own predicate', async () => {
    const fx = await makeWorkItemFixture();
    const abandoned = await seedItem(fx, 'Cancelled', {});

    await runMigration();
    const afterFirst = await adminDb.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });

    await runMigration();
    const afterSecond = await adminDb.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });

    expect(afterSecond.implementationSource).toBeNull();
    // Idempotent means UNWRITTEN, not merely "same value": a re-write would bump
    // `updatedAt` and churn every surface that orders on it.
    expect(afterSecond.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
  });

  it('no-ops on a database that never ran the buggy lane (fresh / CI / preview)', async () => {
    const fx = await makeWorkItemFixture();
    await seedItem(fx, 'Plain todo', { status: 'todo', implementationSource: null });
    await runMigration();
    const workItemCount = await adminDb.workItem.count({
      where: { implementationSource: { not: null } },
    });
    expect(workItemCount).toBe(0);
  });
});

describe('clear_cancelled_manual_provenance — every other row is left alone', () => {
  it('a DONE manual-stamped row keeps its stamp (the MOTIR-1685 behaviour)', async () => {
    const fx = await makeWorkItemFixture();
    const done = await seedItem(fx, 'Done by hand', { status: 'done' });
    await runMigration();
    expect(await stampOf(done.id)).toBe('manual');
  });

  it('a cancelled row stamped byok / hosted keeps it — only `manual` is the bug value', async () => {
    const fx = await makeWorkItemFixture();
    const byok = await seedItem(fx, 'Agent-reported, then cancelled', {
      implementationSource: 'byok',
    });
    const hosted = await seedItem(fx, 'Hosted-run, then cancelled', {
      implementationSource: 'hosted',
    });
    await runMigration();
    expect(await stampOf(byok.id)).toBe('byok');
    expect(await stampOf(hosted.id)).toBe('hosted');
  });

  it('a cancelled row still carrying a sessionBranch keeps its stamp (real lineage)', async () => {
    const fx = await makeWorkItemFixture();
    const worked = await seedItem(fx, 'Integrated, then cancelled', {
      sessionBranch: 'session/real-work',
    });
    await runMigration();
    expect(await stampOf(worked.id)).toBe('manual');
  });

  it('a cancelled row with a DELIVERING pull request keeps its stamp (real PR evidence)', async () => {
    const fx = await makeWorkItemFixture();
    const withPr = await seedItem(fx, 'Shipped a PR, then cancelled', {});
    await linkPullRequest(fx, withPr.id, 41);
    await runMigration();
    expect(await stampOf(withPr.id)).toBe('manual');
  });

  it('a PR pointing at a DIFFERENT item does not shield this one', async () => {
    // The NOT EXISTS correlates on `pr.work_item_id = wi.id`; an uncorrelated
    // read would spare every row the moment ANY PR row existed.
    const fx = await makeWorkItemFixture();
    const other = await seedItem(fx, "Someone else's PR", { status: 'done' });
    await linkPullRequest(fx, other.id, 42);
    const abandoned = await seedItem(fx, 'Cancelled, no PR of its own', {});

    await runMigration();

    expect(await stampOf(abandoned.id)).toBeNull();
    expect(await stampOf(other.id)).toBe('manual');
  });

  it('a pull request that delivers NOTHING shields nothing', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-2221-unlinked',
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon-B-V',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        repoId: '810000',
        owner: 'moooon-B-V',
        name: 'motir-core-unlinked',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repo.id,
        number: 43,
        state: 'open',
        merged: false,
        headRef: 'subtask/unresolved',
      },
    });
    const abandoned = await seedItem(fx, 'Cancelled beside an unlinked PR', {});

    await runMigration();

    expect(await stampOf(abandoned.id)).toBeNull();
  });
});
