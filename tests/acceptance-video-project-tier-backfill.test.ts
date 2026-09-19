import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4925 · MOTIR-5167 — the acceptance-video switch moves to the PROJECT, and
// the BACKFILL is what makes the move safe.
//
// `Project.acceptanceVideoEnabled` defaults to `true`. On its own that default
// would switch acceptance video ON for every project under an organisation that
// had deliberately turned it OFF — a setting flipping itself, which is worse than
// the wrong tier it replaces, because the wrong tier at least does what the person
// who set it asked. So the migration copies each project's owning organisation's
// CURRENT value forward, in the same migration, before anything reads the column.
//
// ⚠️ THIS FILE ASSERTS THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION.
// A test that retyped the UPDATE would pass for ever while the shipped statement
// drifted away from it — and the statement is the deliverable.
//
// ⚠️ IT NO LONGER EXECUTES THAT STATEMENT, and that is MOTIR-5195, not a lost
// case. Two cases here used to seed organisations that disagreed, run the
// extracted backfill verbatim against Postgres, and assert each project took its
// organisation's answer. The backfill reads `organization.acceptance_video_enabled`,
// which MOTIR-5195 dropped, so against a database migrated to the current tree the
// statement has no source column to read. It ran exactly once, at deploy, as part
// of 20260911170000, and those two cases proved it before that deploy. What stays
// is the structural half: the copy-forward still lives in the same migration that
// adds the column, and still resolves the organisation through the workspace.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260911170000_project_acceptance_video_gate_switch/migration.sql',
);

/** The migration's statements, comments stripped, in file order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The ONE backfill statement the deploy runs — extracted, never retyped. */
function backfillStatement(): string {
  const updates = migrationStatements().filter((s) => /^UPDATE\b/i.test(s));
  expect(
    updates,
    'the migration must carry EXACTLY ONE backfill UPDATE — this file asserts it, ' +
      'so zero means the copy-forward was dropped and two means it no longer knows which ' +
      'statement it is asserting',
  ).toHaveLength(1);
  return updates[0]!;
}

describe('the project-tier acceptance-video switch inherits its organisation answer', () => {
  it('the backfill lives IN the migration, so a deploy cannot apply the column without it', () => {
    const statements = migrationStatements();

    // The column and its copy-forward are ONE migration on purpose: a separate
    // script is a second thing to remember, and a deploy that runs the migration
    // without it is exactly the silent flip this file exists to refuse.
    expect(
      statements.some((s) => /^ALTER TABLE "project" ADD COLUMN/i.test(s)),
      'the migration must be the one that adds the column',
    ).toBe(true);

    const backfill = backfillStatement();
    // It has to resolve the organisation THROUGH the workspace — there is no
    // organisation FK on `project`, so a backfill that does not join both tables
    // is reading something other than the owning organisation's answer.
    expect(backfill).toMatch(/"workspace"/);
    expect(backfill).toMatch(/"organization"/);
    expect(backfill).toMatch(/"acceptance_video_enabled"/);
  });
});
