import { afterAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// The seven public-read policies key on the access MODE (Story MOTIR-6554 ·
// Subtask MOTIR-6687, migration `20260928000100_public_read_policies_on_access_mode`).
//
// Read from the catalog of the database the suite actually runs on — built by
// replaying every migration — so this asserts what Postgres enforces, not what a
// migration file says. Whether each policy admits and refuses the right ROWS is
// the story's integration gate (MOTIR-6688); this is the structural half: no
// policy anywhere still asks the retired level, and each of the seven asks the mode.

const SEVEN = [
  ['project', 'project_public_read'],
  ['work_item', 'work_item_public_project_read'],
  ['public_request_vote', 'public_request_vote_public_project_read'],
  ['workflow_status', 'workflow_status_public_project_read'],
  ['workspace', 'workspace_public_project_read'],
  ['organization', 'organization_public_project_read'],
  ['public_address', 'public_address_public_read'],
] as const;

type PolicyRow = { tablename: string; policyname: string; cmd: string; expr: string };

async function policies(): Promise<PolicyRow[]> {
  return adminDb.$queryRaw<PolicyRow[]>`
    SELECT tablename, policyname, cmd,
           coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
      FROM pg_policies
     WHERE schemaname = 'public'`;
}

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('the public-read policies', () => {
  it('no policy on any table reads the retired accessLevel', async () => {
    const rows = await policies();
    expect(rows.length).toBeGreaterThan(SEVEN.length);
    expect(rows.filter((r) => /accessLevel|project_access_level/.test(r.expr))).toEqual([]);
  });

  it.each(SEVEN)('%s.%s is a SELECT arm keyed on access_mode = public', async (table, name) => {
    const row = (await policies()).find((r) => r.tablename === table && r.policyname === name);
    expect(row, `${table}.${name} exists`).toBeDefined();
    expect(row!.cmd).toBe('SELECT');
    expect(row!.expr).toMatch(/access_mode = 'public'::project_access_mode/);
  });

  it('exactly the seven policies ask about the access mode — none added, none lost', async () => {
    const keyed = (await policies())
      .filter((r) => /access_mode/.test(r.expr))
      .map((r) => [r.tablename, r.policyname])
      .sort();
    expect(keyed).toEqual([...SEVEN].map(([t, p]) => [t, p]).sort());
  });
});
