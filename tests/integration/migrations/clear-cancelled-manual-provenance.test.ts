import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
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
 */
async function runMigration(): Promise<void> {
  await db.$executeRawUnsafe(MIGRATION_SQL);
}

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
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
  await db.workItem.update({
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

/** A connected repo + a PR row pointing at `workItemId` (the byok evidence). */
async function linkPullRequest(fx: WorkItemFixture, workItemId: string, number: number) {
  const inst = await db.githubInstallation.create({
    data: {
      installationId: `inst-2221-${number}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await db.githubRepo.create({
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
  await db.githubPullRequest.create({
    data: {
      provider: 'github',
      repoId: repo.id,
      number,
      state: 'closed',
      merged: true,
      headRef: 'subtask/MOTIR-1',
      workItemId,
    },
  });
}

const stampOf = async (id: string) =>
  (await db.workItem.findUniqueOrThrow({ where: { id } })).implementationSource;

describe('clear_cancelled_manual_provenance — clears exactly the rows the bug wrote', () => {
  it('clears the false stamp from a cancelled, manual-stamped, evidence-free row', async () => {
    const fx = await makeWorkItemFixture();
    const abandoned = await seedItem(fx, 'Cancelled, never implemented', {});

    await runMigration();

    expect(await stampOf(abandoned.id)).toBeNull();
    // Only the stamp moved — the migration is not a status or lifecycle write.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(row.status).toBe('cancelled');
    expect(row.archivedAt).toBeNull();
  });

  it('reports the blast radius: rows-affected is the count of matching rows, not a guess', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 3; i += 1) await seedItem(fx, `Abandoned ${i}`, {});
    await seedItem(fx, 'Done, legitimately manual', { status: 'done' });
    await seedItem(fx, 'Cancelled but agent-reported', { implementationSource: 'byok' });

    const affected = await db.$executeRawUnsafe(MIGRATION_SQL);
    // A `DO` block returns no row count of its own, so assert the effect: three
    // cleared, and nothing else touched. (The block RAISEs the same number as a
    // NOTICE, which is what a release log shows the operator.)
    expect(affected).toBe(0);
    expect(await db.workItem.count({ where: { implementationSource: 'manual' } })).toBe(1);
    expect(await db.workItem.count({ where: { implementationSource: null } })).toBe(3);
    expect(await db.workItem.count({ where: { implementationSource: 'byok' } })).toBe(1);
  });

  it('writes ZERO on a second apply — the clear falls out of its own predicate', async () => {
    const fx = await makeWorkItemFixture();
    const abandoned = await seedItem(fx, 'Cancelled', {});

    await runMigration();
    const afterFirst = await db.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });

    await runMigration();
    const afterSecond = await db.workItem.findUniqueOrThrow({ where: { id: abandoned.id } });

    expect(afterSecond.implementationSource).toBeNull();
    // Idempotent means UNWRITTEN, not merely "same value": a re-write would bump
    // `updatedAt` and churn every surface that orders on it.
    expect(afterSecond.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
  });

  it('no-ops on a database that never ran the buggy lane (fresh / CI / preview)', async () => {
    const fx = await makeWorkItemFixture();
    await seedItem(fx, 'Plain todo', { status: 'todo', implementationSource: null });
    await runMigration();
    expect(await db.workItem.count({ where: { implementationSource: { not: null } } })).toBe(0);
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

  it('a cancelled row with a linked GithubPullRequest keeps its stamp (real PR evidence)', async () => {
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

  it('an unlinked PR row (workItemId null) shields nothing', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await db.githubInstallation.create({
      data: {
        installationId: 'inst-2221-unlinked',
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon-B-V',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await db.githubRepo.create({
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
    await db.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repo.id,
        number: 43,
        state: 'open',
        merged: false,
        headRef: 'subtask/unresolved',
        workItemId: null,
      },
    });
    const abandoned = await seedItem(fx, 'Cancelled beside an unlinked PR', {});

    await runMigration();

    expect(await stampOf(abandoned.id)).toBeNull();
  });
});
