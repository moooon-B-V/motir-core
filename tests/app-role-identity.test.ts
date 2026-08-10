import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';

// The non-bypass runtime role's IDENTITY and PRIVILEGES (MOTIR-2519).
//
// Every RLS suite in this repository drops to this role — 29 files issue
// `SET LOCAL ROLE motir_app` — and each of them asserts that some cross-tenant
// read comes back empty. That makes the role's NAME and ATTRIBUTES load-bearing
// in a way nothing else checks: if the role were missing, or renamed only
// halfway, or accidentally recreated with BYPASSRLS, those suites would not
// fail loudly. They would either error on the role switch (loud, fine) or — far
// worse — pass while asserting nothing, because a bypassing role sees every row
// and a denial test that never denies still returns the rows it expected not to
// find. This file is the guard that turns that silent case into a red test.
//
// It also pins the rename itself. `20260810000000_rename_app_role_to_motir_app`
// renames `prodect_app` to `motir_app`, and because roles are CLUSTER-level
// while migrations are per-DATABASE, a half-applied rename is a real state a
// developer can land in (one database migrated, another not). Asserting that
// the OLD name is gone — not merely that the new one exists — is what catches it.

afterAll(async () => {
  await db.$disconnect();
});

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

describe('the non-bypass runtime role', () => {
  it('exists as motir_app, with the attributes RLS depends on', async () => {
    const rows = await db.$queryRawUnsafe<RoleRow[]>(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
         FROM pg_roles
        WHERE rolname IN ('motir_app', 'prodect_app')
        ORDER BY rolname`,
    );

    expect(rows).toHaveLength(1);
    const role = rows[0]!;
    expect(role.rolname).toBe('motir_app');
    // LOGIN so a DATABASE_URL can point at it (granted by 20260528175528).
    expect(role.rolcanlogin).toBe(true);
    // NOSUPERUSER + NOBYPASSRLS are the whole point: a superuser has BYPASSRLS
    // implicitly, and BYPASSRLS overrides even FORCE ROW LEVEL SECURITY, which
    // would render all of the workspace policies inert on this connection.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('no longer exists under its pre-rebrand name', async () => {
    const rows = await db.$queryRawUnsafe<{ rolname: string }[]>(
      `SELECT rolname FROM pg_roles WHERE rolname = 'prodect_app'`,
    );
    // Two roles would mean a half-applied rename across a shared cluster; the
    // suites would keep passing against whichever one they happened to name.
    expect(rows).toEqual([]);
  });

  it('kept every table privilege across the rename', async () => {
    // A rename carries the role's OID, so GRANTs follow it automatically. This
    // asserts the OUTCOME rather than the mechanism, and does it as a TOTALITY
    // over the live table set — so a future table shipped without the default
    // privileges applying also trips this, not just a botched rename.
    const missing = await db.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname <> '_prisma_migrations'
          AND NOT (
            has_table_privilege('motir_app', c.oid, 'SELECT')
            AND has_table_privilege('motir_app', c.oid, 'INSERT')
            AND has_table_privilege('motir_app', c.oid, 'UPDATE')
            AND has_table_privilege('motir_app', c.oid, 'DELETE')
          )
        ORDER BY c.relname`,
    );
    expect(missing).toEqual([]);
  });

  it('kept schema usage and the default-privilege entries', async () => {
    const [schema] = await db.$queryRawUnsafe<{ usage: boolean }[]>(
      `SELECT has_schema_privilege('motir_app', 'public', 'USAGE') AS usage`,
    );
    expect(schema?.usage).toBe(true);

    // `ALTER DEFAULT PRIVILEGES … TO <role>` is what makes every NEW table
    // grantable without another migration. Its pg_default_acl rows are stored by
    // role OID and re-read under the new name; if they had been lost, the next
    // table to ship would silently be unreadable by the runtime role.
    const [acl] = await db.$queryRawUnsafe<{ entries: bigint }[]>(
      `SELECT count(*) AS entries
         FROM pg_default_acl d
        WHERE array_to_string(d.defaclacl, ',') LIKE '%motir_app=%'`,
    );
    expect(Number(acl?.entries ?? 0)).toBeGreaterThan(0);
  });
});
