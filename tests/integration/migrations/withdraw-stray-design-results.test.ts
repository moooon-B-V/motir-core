import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3215 — the `withdraw_stray_design_results` forward data migration.
//
// MOTIR-3213's publisher fix stops any NEW design result being attributed to a
// pull request that authored no design. It cannot touch the rows the ungated
// publisher already wrote, and nothing else could either: `design_evidence` had
// exactly two mutations, create and supersede-by-publish, and both need a
// replacement the affected cards will never have. So the repair is this
// migration, and the door it uses is the `withdrawn_at` column its sibling adds.
//
// ⚠️ THIS MIGRATION NAMES CUIDS, WHICH IS UNUSUAL AND IS WHY THIS SUITE EXISTS.
// The sibling data migrations (`clear_cancelled_manual_provenance`,
// `retire_spurious_project_repo_rows`) each state a PREDICATE, and their tests
// pin it from both sides. This one cannot: "the publishing pull request changed
// no file under design/" is a fact about GitHub, not about any column. What can
// still be pinned — and is, below — is that the SQL withdraws exactly the rows
// it names, leaves every other row untouched, is idempotent, and is a clean
// no-op on a database that has never seen these ids (every self-hosted one).

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260820140100_withdraw_stray_design_results/migration.sql',
  ),
  'utf8',
);

/** Apply the migration exactly as `migrate deploy` would — one statement. */
async function runMigration(): Promise<number> {
  return adminDb.$executeRawUnsafe(MIGRATION_SQL);
}

/** The five evidence ids the migration names, and the card each belongs to. */
const NAMED = [
  { id: 'cmt1a0dcd0016i2n8a2sfu5gu', card: 'MOTIR-3049', current: true },
  { id: 'cmt0gvj0c01f0i3ph2aqxnjuh', card: 'MOTIR-3148', current: true },
  { id: 'cmszugnbs01jni2phn4z7bloo', card: 'MOTIR-3064', current: true },
  { id: 'cmsyn7ygl003hi2n8vmqghvkw', card: 'MOTIR-2902', current: true },
  // MOTIR-2902's earlier stray, already superseded by the one above. Withdrawn
  // too: `is_current = false` keeps it off the panel, but leaving it unstamped
  // would file it as an ordinary superseded design — the wrong answer.
  { id: 'cmsymciqf0109i4phl73opanu', card: 'MOTIR-2902', current: false },
] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An evidence row with an explicit id, on a fresh leaf. */
async function seedEvidence(
  fx: WorkItemFixture,
  opts: { id: string; title: string; isCurrent: boolean },
) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: `${opts.title} story` });
  const card = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: opts.title,
    parentId: story.id,
  });
  await adminDb.designEvidence.create({
    data: {
      id: opts.id,
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      isCurrent: opts.isCurrent,
      producedByKey: opts.title,
    },
  });
  return card;
}

describe('withdraw_stray_design_results', () => {
  it('withdraws exactly the five rows it names, stamping the SYSTEM as the actor', async () => {
    const fx = await makeWorkItemFixture();
    for (const row of NAMED) {
      await seedEvidence(fx, { id: row.id, title: row.card, isCurrent: row.current });
    }

    const affected = await runMigration();
    // Rows-affected is asserted, not assumed: the blast radius is a number.
    expect(affected).toBe(5);

    for (const row of NAMED) {
      const after = await adminDb.designEvidence.findUnique({ where: { id: row.id } });
      expect(after!.isCurrent).toBe(false);
      expect(after!.withdrawnAt).toBeInstanceOf(Date);
      // NULL actor = the system withdrew it — deliberately distinguishable from
      // every withdrawal that comes through the route, which names a person.
      expect(after!.withdrawnById).toBeNull();
      expect(after!.withdrawnReason).toContain('MOTIR-3215');
      expect(after!.withdrawnReason).toContain('changed no file under design/');
    }
  });

  it('leaves every other design result alone — including MOTIR-3122, the false positive', async () => {
    const fx = await makeWorkItemFixture();
    await seedEvidence(fx, { id: NAMED[0].id, title: NAMED[0].card, isCurrent: true });

    // MOTIR-3122's row (#2161) reads as a 38-asset over-publish through
    // `gh pr view --json files`, which CAPS its file list at 100. The paginated
    // REST list returns 138 design files against 138 assets — a correct publish.
    // It is named here so a future reader can see it was excluded on
    // measurement rather than overlooked.
    const legit = await seedEvidence(fx, {
      id: 'cmt0di2xm025bi2phyaxua2ki',
      title: 'MOTIR-3122',
      isCurrent: true,
    });
    const other = await seedEvidence(fx, {
      id: 'cmsomeotherevidencerow0001',
      title: 'A card with a real design',
      isCurrent: true,
    });

    expect(await runMigration()).toBe(1);

    for (const card of [legit, other]) {
      const row = await adminDb.designEvidence.findFirst({ where: { workItemId: card.id } });
      expect(row!.isCurrent).toBe(true);
      expect(row!.withdrawnAt).toBeNull();
      expect(row!.withdrawnReason).toBeNull();
    }
  });

  it('is IDEMPOTENT — a re-run changes nothing and does not re-stamp the timestamp', async () => {
    const fx = await makeWorkItemFixture();
    await seedEvidence(fx, { id: NAMED[0].id, title: NAMED[0].card, isCurrent: true });

    expect(await runMigration()).toBe(1);
    const first = await adminDb.designEvidence.findUnique({ where: { id: NAMED[0].id } });

    expect(await runMigration()).toBe(0);
    const second = await adminDb.designEvidence.findUnique({ where: { id: NAMED[0].id } });
    expect(second!.withdrawnAt).toEqual(first!.withdrawnAt);
  });

  it('is a clean NO-OP on a database that has never held these ids', async () => {
    const fx = await makeWorkItemFixture();
    await seedEvidence(fx, { id: 'cmfreshselfhostedrow00001', title: 'Local', isCurrent: true });

    expect(await runMigration()).toBe(0);
    const row = await adminDb.designEvidence.findUnique({
      where: { id: 'cmfreshselfhostedrow00001' },
    });
    expect(row!.isCurrent).toBe(true);
    expect(row!.withdrawnAt).toBeNull();
  });

  it('does not delete anything — the assets of a withdrawn row survive', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedEvidence(fx, {
      id: NAMED[0].id,
      title: NAMED[0].card,
      isCurrent: true,
    });
    await adminDb.designAsset.create({
      data: {
        workspaceId: fx.workspaceId,
        designEvidenceId: NAMED[0].id,
        kind: 'mock',
        sourcePath: 'design/somewhere/else.mock.html',
        position: 0,
      },
    });

    await runMigration();

    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
    expect(await adminDb.designAsset.count({ where: { designEvidenceId: NAMED[0].id } })).toBe(1);
  });
});
