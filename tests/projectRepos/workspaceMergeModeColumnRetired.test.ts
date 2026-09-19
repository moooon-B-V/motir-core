import { afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';

// MOTIR-5507 · MOTIR-5508 — the end state of `Workspace.subtaskPrMergeMode`'s
// three-phase retirement (Story MOTIR-5175 · `docs/decisions/approval-gates.md`
// §7 point 3 · `docs/decisions/delivery-reader-migration.md` §6b).
//
// ─── WHAT THIS FILE HELD, AND WHAT IT HOLDS NOW ──────────────────────────────
//
// Phase 2 (MOTIR-5505) put `@ignore` on the field so the generated client stopped
// SELECTING the column while the column stayed. This file was that phase's story
// gate (MOTIR-5507): it drove every `Workspace` read site through a query-logging
// client and asserted the SQL it EMITTED never named the column, because a read
// with no explicit `select` emits every scalar the MODEL declares, and no grep for
// the name can find that reader (MOTIR-3852).
//
// Phase 3 (MOTIR-5508) dropped the column
// (`20260919150000_drop_workspace_subtask_pr_merge_mode`) and deleted the field in
// the same commit, after MOTIR-5506 verified from the platform that the phase-2
// image was serving on every machine. The emitted-SQL half had nothing left to
// guard, and its positive control, a raw `SELECT` of the column, could no longer
// run, so both went with the column. The precedent is
// `tests/github/checkRunFeedbackColumnRetired.test.ts`, which MOTIR-3803 deleted
// with its column.
//
// What stays is the two-sided END state, INVERTED on the database side rather than
// deleted: the column is out of the generated client AND out of the database.

const COLUMN = 'subtaskPrMergeMode';

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('phase 3’s two-sided state — out of the client, and out of the database', () => {
  it('the generated client’s Workspace scalar-field enum has no member for the field', () => {
    expect(Object.keys(Prisma.WorkspaceScalarFieldEnum)).not.toContain(COLUMN);
    // Positive half: the enum is the real one, not an empty object.
    expect(Object.keys(Prisma.WorkspaceScalarFieldEnum)).toEqual(
      expect.arrayContaining(['id', 'slug', 'organizationId']),
    );
  });

  it('information_schema no longer reports the column on workspace', async () => {
    // Inverted by MOTIR-5508 from phase 2's "still reports the column": the drop
    // migration has run on this database, exactly as `release_command` runs it in
    // production.
    const rows = await adminDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workspace'
        AND column_name = ${COLUMN}
    `;
    expect(rows).toEqual([]);
    // Positive half: the same query DOES find a column the table still has, so the
    // empty answer above is not a wrong schema or table name.
    const slug = await adminDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workspace'
        AND column_name = 'slug'
    `;
    expect(slug).toEqual([{ column_name: 'slug' }]);
  });
});
