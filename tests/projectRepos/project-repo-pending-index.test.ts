import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';

// MOTIR-1960 — the two properties the drift fix has to keep TRUE together, read
// off the live catalog rather than asserted about the SQL text.
//
// The bug: `20260731190000` (MOTIR-1907) hand-wrote a PARTIAL index on
// `project_repository (workspace_id)`, and the model also declares a plain
// `@@index([workspaceId])`. Prisma's differ pairs a database index to a
// datamodel index BY COLUMN LIST and ignores one it cannot express (a `WHERE`
// clause is inexpressible) only while no `@@index` claims those columns — so the
// two got paired, the sole remaining difference was the NAME, and every
// `migrate diff` reported a permanent spurious RENAME. The next `migrate dev`
// would have written that rename into a migration, renaming one index over the
// other and destroying it.
//
// `tests/ci-schema-drift-gate.test.ts` guards the CI step that catches drift of
// ANY kind. This file guards the two things a green diff alone would not:
//
//   1. The sweep's index is still PARTIAL on MOTIR-1907's convergence
//      predicate. Widening the column list must not have quietly traded the
//      predicate away — that predicate is the entire point of the index (the
//      settled rows, which are almost all of them, stay out of it), and a plain
//      index over the same columns would also diff clean while costing a
//      full-table scan per workspace on every sweep.
//   2. No partial index ANYWHERE shares its column list with a plain one on the
//      same table. This is the class, not the instance: it is the condition that
//      produces the spurious rename, it is checkable in one query, and it fails
//      loudly the moment someone writes the next colliding partial index —
//      naming the table and both index names, which a `migrate diff` failure
//      does not.

afterAll(async () => {
  await db.$disconnect();
});

interface IndexRow {
  definition: string;
}

interface CollisionRow {
  tbl: string;
  cols: string;
  collision: string;
}

describe('project_repository — the CI-actions pending index (MOTIR-1960)', () => {
  it('is still PARTIAL on the convergence predicate, over (workspace_id, state)', async () => {
    const rows = await db.$queryRaw<IndexRow[]>`
      SELECT indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'project_repository'
        AND indexname = 'project_repository_ci_actions_pending_idx'
    `;
    expect(rows).toHaveLength(1);
    const definition = rows[0]!.definition;

    // The predicate — MOTIR-1907's, unchanged. Postgres normalises the SQL it
    // stores (parenthesised, `public.` qualified), so match on the shape rather
    // than on the migration's exact formatting.
    expect(definition).toMatch(/WHERE .*ci_actions_intent_at IS NOT NULL/);
    expect(definition).toMatch(/ci_actions_applied_at IS NULL/);
    expect(definition).toMatch(/ci_actions_applied_at < ci_actions_intent_at/);

    // The column list — both equalities `listCiActionsPendingByWorkspace`
    // filters on, so both land in the index condition rather than a heap filter.
    expect(definition).toMatch(/USING btree \(workspace_id, state\)/);

    // And NOT the pre-fix shape, which is what collided with `@@index([workspaceId])`.
    expect(definition).not.toMatch(/USING btree \(workspace_id\)/);
  });

  it('leaves no partial index sharing a column list with a plain one (the drift condition)', async () => {
    const collisions = await db.$queryRaw<CollisionRow[]>`
      WITH idx AS (
        SELECT
          t.relname AS tbl,
          c.relname AS idx,
          i.indpred IS NOT NULL AS partial,
          (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relkind = 'r'
      )
      SELECT
        tbl,
        cols,
        string_agg(idx || CASE WHEN partial THEN ' (partial)' ELSE ' (plain)' END, ' + ' ORDER BY idx)
          AS collision
      FROM idx
      WHERE cols IS NOT NULL
      GROUP BY tbl, cols
      HAVING bool_or(partial) AND bool_or(NOT partial)
      ORDER BY tbl, cols
    `;

    // Verified to CATCH the original bug: recreating the pre-fix index shape
    // makes this return exactly one row —
    //   project_repository | workspace_id |
    //     project_repository_ci_actions_pending_idx (partial)
    //   + project_repository_workspace_id_idx (plain)
    expect(collisions.map((r) => `${r.tbl}(${r.cols}): ${r.collision}`)).toEqual([]);
  });
});
