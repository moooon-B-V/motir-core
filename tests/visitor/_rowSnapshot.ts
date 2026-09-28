import { adminDb } from '../helpers/adminDb';

// A before/after picture of EVERY table in the database (Story MOTIR-6170 ·
// MOTIR-6650): its row count, plus the latest `updated_at` where the table has
// one. Wider than "each table the handler's service touches" on purpose — a
// write refused at the door changes nothing anywhere, so the whole database is
// the honest thing to compare, and it cannot miss a table nobody thought of.
//
// Read as the table owner (`adminDb`), so row-level security hides nothing.

/**
 * Tables a REFUSED request may legitimately write, each with its reason. Nothing
 * here is project data.
 */
const BOOKKEEPING: Record<string, string> = {
  _prisma_migrations: 'the migration ledger — never touched by a request',
  rate_limit_counter:
    'the shared rate-limit store: a refused request still spends its caller’s budget, by design',
};

let tables: { name: string; updated: boolean; scoped: boolean }[] | null = null;

async function listTables() {
  if (tables) return tables;
  const rows = await adminDb.$queryRawUnsafe<
    { table_name: string; has_updated: boolean; has_workspace: boolean }[]
  >(`
    SELECT t.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
                     AND c.column_name = 'updated_at') AS has_updated,
           EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
                     AND c.column_name = 'workspace_id') AS has_workspace
    FROM information_schema.tables t
    WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name`);
  tables = rows
    .filter((r) => !(r.table_name in BOOKKEEPING) && !r.table_name.startsWith('rate_limit'))
    .map((r) => ({ name: r.table_name, updated: r.has_updated, scoped: r.has_workspace }));
  return tables;
}

export type RowSnapshot = Record<string, string>;

/**
 * The picture. With `workspaceId`, a table that carries a `workspace_id` is
 * pictured over THAT workspace's rows only — so a reader's legitimate write in
 * their OWN organisation (R1 creating a sprint in their own project) is not
 * mistaken for a write into the fixture's; every table without the column is
 * still pictured whole.
 */
export async function snapshotRows(workspaceId?: string): Promise<RowSnapshot> {
  const list = await listTables();
  if (workspaceId && !/^[a-z0-9]+$/.test(workspaceId)) throw new Error('unexpected id');
  const sql = list
    .map((t) => {
      const where = workspaceId && t.scoped ? ` WHERE workspace_id = '${workspaceId}'` : '';
      return `SELECT '${t.name}' AS t, count(*)::text AS c, ${
        t.updated ? 'max(updated_at)::text' : `''`
      } AS u FROM "${t.name}"${where}`;
    })
    .join(' UNION ALL ');
  const rows = await adminDb.$queryRawUnsafe<{ t: string; c: string; u: string | null }[]>(sql);
  return Object.fromEntries(rows.map((r) => [r.t, `${r.c}|${r.u ?? ''}`]));
}

/** The tables whose picture moved between two snapshots. */
export function changedTables(before: RowSnapshot, after: RowSnapshot): string[] {
  return Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k])
    .sort();
}
