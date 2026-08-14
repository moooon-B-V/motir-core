import { Client } from 'pg';

// THE `motir_app` E2E HARNESS (MOTIR-2816) — the rehearsal for MOTIR-2515.
//
// ── Why this exists, and why `TEST_DB_APP_ROLE=1` could not do it ────────────
// That flag swaps the client the CODE UNDER TEST uses *inside a Vitest process*.
// It has no way to tell a Playwright webServer which role to connect as, and the
// webServer is the only thing in this repo that runs the product the way
// production will: a Next.js server whose OWN connection is the non-bypass role.
//
// The distinction is not cosmetic. A Server Component read, a Server Action, a
// route handler and a client fetch each reach the database by a different path.
// A read bound correctly in a service test can still be unbound in the RSC render
// that calls it, and only a browser driving a real server finds that.
//
// ── How it works ─────────────────────────────────────────────────────────────
// `E2E_APP_ROLE=1` makes `playwright.config.ts` pass a REWRITTEN `DATABASE_URL`
// into `webServer.env` — same database, `motir_app` credentials. Two properties
// matter and they are easy to lose:
//
//   1. **Only the SERVER moves.** The Playwright process, its fixtures and every
//      seeding helper keep the owner URL from `.env`. Fixtures need privileges
//      the runtime role does not have (they create tenants), so seeding through
//      the app role would fail at setup and prove nothing about the product.
//   2. **The role must be able to LOG IN.** `motir_app` is created by the
//      workspace-RLS migration and granted LOGIN, but deliberately carries NO
//      password — a static one in git is a secret-management anti-pattern. The
//      Vitest harness provisions a throwaway password in `tests/setup/globalDb.ts`
//      for the same reason; this does the same for whatever database the E2E run
//      is pointed at, so a fresh CI Postgres needs no new secret.
//
// ⚠️ THE CREDENTIAL HERE IS TEST-ONLY. No deployed environment reads it, and
// MOTIR-2515 generates its own into a secret store. Do not copy this into one.
//
// ── For MOTIR-2515 ───────────────────────────────────────────────────────────
// The cutover's step 4 asks the database `SELECT current_user,
// row_security_active(…)`. `assertServerIsAppRole` below is that question, asked
// through the running server rather than a psql session — which is the form the
// cutover actually needs, because it is the SERVER's connection that matters and
// nothing else can observe it.

/** The role the deployed runtime will use. Mirrors `tests/helpers/parallelDb.ts`. */
export const E2E_APP_ROLE = process.env['TEST_APP_DB_ROLE'] ?? 'motir_app';
/** A THROWAWAY password, provisioned below. Never a deployed credential. */
export const E2E_APP_ROLE_PASSWORD = process.env['TEST_APP_DB_PASSWORD'] ?? 'motir_app';

/** Is this run driving a server connected as the non-bypass role? */
export function isAppRoleE2E(): boolean {
  return process.env['E2E_APP_ROLE'] === '1';
}

/** Rewrite a connection string's userinfo to the app role's test credentials. */
export function withAppRoleCredentials(raw: string): string {
  const url = new URL(raw);
  url.username = E2E_APP_ROLE;
  url.password = E2E_APP_ROLE_PASSWORD;
  return url.toString();
}

/**
 * Give `motir_app` a password on the E2E database, so the webServer can connect
 * as it. Idempotent; safe to call on every run.
 *
 * Throws a NAMED error when the role does not exist rather than letting the
 * webServer fail later with an opaque auth error — that database was not built
 * by our migrations, and saying so is the difference between a five-second fix
 * and an hour.
 */
export async function ensureAppRoleCanLogIn(ownerDatabaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: ownerDatabaseUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = $1',
      [E2E_APP_ROLE],
    );
    if (rows.length === 0) {
      throw new Error(
        `[e2e-app-role] the role "${E2E_APP_ROLE}" does not exist on this database. It is ` +
          `created by the workspace-RLS migration — run \`prisma migrate deploy\` before the ` +
          `E2E run. (Set E2E_APP_ROLE=0 to drive the owner-role server instead.)`,
      );
    }
    // `ALTER ROLE` accepts neither a parameterised identifier nor a parameterised
    // password, and a DO block takes no parameters — so let Postgres do the
    // quoting via `format(%I, %L)` and execute the result. Safer than
    // interpolating in JS. (Same construction as `tests/setup/globalDb.ts`.)
    const { rows: stmt } = await admin.query<{ sql: string }>(
      'SELECT format($1::text, $2::text, $3::text) AS sql',
      ['ALTER ROLE %I WITH LOGIN PASSWORD %L', E2E_APP_ROLE, E2E_APP_ROLE_PASSWORD],
    );
    await admin.query(stmt[0]!.sql);
  } finally {
    await admin.end();
  }
}

/**
 * Prove the SERVER's own connection is the non-bypass role.
 *
 * ⚠️ Without this the whole spec is theatre. Every assertion in
 * `app-role-surfaces.spec.ts` passes trivially against an owner-role server,
 * because RLS is inert for a BYPASSRLS role — the suite would go green while
 * testing nothing, which is the exact vacuous-pass shape this story exists to
 * remove, one level up.
 *
 * Asked through `/api/_test/db-role`, because the SERVER's connection is the
 * subject and no other vantage point can see it.
 */
export interface ServerDbRole {
  currentUser: string;
  bypassesRls: boolean;
}
