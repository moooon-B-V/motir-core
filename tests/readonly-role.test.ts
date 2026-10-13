import { afterAll, describe, expect, it } from 'vitest';
import { adminDb } from './helpers/adminDb';

// The READ-ONLY diagnosis role (MOTIR-8187 · MOTIR-8188).
//
// `motir_readonly` exists so production can be queried by an operator without
// any write path. Each property below is one way that promise could silently
// stop being true: a write grant slipping in, a table shipped without SELECT, a
// role recreated with BYPASSRLS, or a LOGIN committed to git.

afterAll(async () => {
  await adminDb.$disconnect();
});

/** Thrown at the end of a transaction body so everything it did rolls back. */
class Rollback extends Error {}

describe('the read-only diagnosis role', () => {
  it('exists without LOGIN, superuser or RLS bypass', async () => {
    const rows = await adminDb.$queryRawUnsafe<
      {
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }[]
    >(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = 'motir_readonly'`,
    );
    expect(rows).toHaveLength(1);
    // LOGIN is granted by hand on production only (MOTIR-8190); a login in git
    // would need a password in git.
    expect(rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('defaults every session to read-only with a 30 s statement timeout', async () => {
    const [row] = await adminDb.$queryRawUnsafe<{ rolconfig: string[] | null }[]>(
      `SELECT rolconfig FROM pg_roles WHERE rolname = 'motir_readonly'`,
    );
    expect(row?.rolconfig).toEqual(
      expect.arrayContaining(['default_transaction_read_only=on', 'statement_timeout=30s']),
    );
  });

  it('can SELECT every table and write none', async () => {
    const wrong = await adminDb.$queryRawUnsafe<{ relname: string; why: string }[]>(
      `SELECT c.relname,
              CASE WHEN NOT has_table_privilege('motir_readonly', c.oid, 'SELECT') THEN 'no SELECT'
                   ELSE 'can write' END AS why
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND (
            NOT has_table_privilege('motir_readonly', c.oid, 'SELECT')
            OR has_table_privilege('motir_readonly', c.oid, 'INSERT')
            OR has_table_privilege('motir_readonly', c.oid, 'UPDATE')
            OR has_table_privilege('motir_readonly', c.oid, 'DELETE')
            OR has_table_privilege('motir_readonly', c.oid, 'TRUNCATE')
          )
        ORDER BY c.relname`,
    );
    expect(wrong).toEqual([]);
  });

  it('reads a NEW table through the default privileges, behind RLS until app.system_admin is set', async () => {
    // A table created here, by the role that runs migrations, stands in for the
    // next migration's table: it must be readable without another GRANT. Its
    // policy has the shape every workspace policy has (no `TO` clause, the
    // system-admin GUC as the cross-tenant door). All of it rolls back.
    const seen = await adminDb
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "__readonly_role_probe" (id int PRIMARY KEY)`);
        await tx.$executeRawUnsafe(`INSERT INTO "__readonly_role_probe" VALUES (1)`);
        await tx.$executeRawUnsafe(`ALTER TABLE "__readonly_role_probe" ENABLE ROW LEVEL SECURITY`);
        await tx.$executeRawUnsafe(`ALTER TABLE "__readonly_role_probe" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRawUnsafe(
          `CREATE POLICY "probe_system" ON "__readonly_role_probe"
             USING (current_setting('app.system_admin', true) = 'true')`,
        );
        await tx.$executeRawUnsafe(`SET LOCAL ROLE motir_readonly`);

        const before = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "__readonly_role_probe"`,
        );
        await tx.$executeRawUnsafe(`SELECT set_config('app.system_admin', 'true', true)`);
        const after = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "__readonly_role_probe"`,
        );

        // A write is refused even with the GUC set; a savepoint keeps the
        // refusal from aborting the rest of the transaction.
        await tx.$executeRawUnsafe(`SAVEPOINT write_attempt`);
        let writeError: string | null = null;
        try {
          await tx.$executeRawUnsafe(`INSERT INTO "__readonly_role_probe" VALUES (2)`);
        } catch (err) {
          writeError = err instanceof Error ? err.message : String(err);
        }
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT write_attempt`);

        throw new Rollback(
          JSON.stringify({
            before: Number(before[0]?.n ?? -1),
            after: Number(after[0]?.n ?? -1),
            writeError,
          }),
        );
      })
      .catch((err: unknown) => {
        if (err instanceof Rollback)
          return JSON.parse(err.message) as {
            before: number;
            after: number;
            writeError: string | null;
          };
        throw err;
      });

    expect(seen.before).toBe(0);
    expect(seen.after).toBe(1);
    expect(seen.writeError).toMatch(/permission denied/i);
  });
});
