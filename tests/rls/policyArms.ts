import { adminDb } from '../helpers/adminDb';

// The per-table ARM INVENTORY, measured against the catalog (MOTIR-2880,
// generalised to the GUC axis by MOTIR-2959).
//
// ⚠️ IT READS `pg_policies`, NOT THE MIGRATIONS. An arm is a property of the
// DEPLOYED policy set, so the migration files are a CLAIM about it and the
// catalog is the fact (`notes.html` #248, the same distinction one layer down).
// Reading the catalog also means a policy dropped by hand, or an arm a later
// migration removes, turns a guard red on the next run rather than at the next
// incident. The cluster a vitest worker connects to is built by `migrate deploy`
// from empty, so the fact and the migration history agree by construction.
//
// ── Why the match is on `current_setting('<guc>'` and not on the bare name ──
// MOTIR-2880 matched `qual LIKE '%system_admin%'`, which is exact because no
// COLUMN is called that. Generalising the GUC breaks that: `qual LIKE
// '%organization_id%'` also matches a policy that merely joins on an
// `organizationId` column. Measured on `origin/main` @ `7de5856f`, the bare form
// returns SIX tables for `organization_id` and the setting-reference form returns
// FIVE — `organization_public_project_read` is the difference, and it reads
// `app.workspace_id`, never the org GUC. For `system_admin` the two forms return
// the same 29 tables, so this tightening leaves MOTIR-2880's verdicts untouched
// and is a strict improvement on the axis it was widened onto.
//
// ── What this inventory does NOT answer ────────────────────────────────────
// Whether the arm actually FIRES for a given caller. An arm can carry further
// conditions — `attachment_org_service_read` requires `app.user_id` to be EMPTY,
// which is what confines it to the userless service path — and this asks only
// whether some permissive read policy consults the GUC at all. So a table
// reported ARMED may still be blind to a caller that binds the same GUC
// alongside a user. That over-clears in one narrow direction, and it is named
// here rather than left for a reader to discover, because an instrument that
// does not state its blind spot hands it to every partition cut from its output
// (`notes.html` #268 / #273).
//
// ⚠️ AND THE BLIND SPOT HAS BOTH POLARITIES, which this paragraph named only one
// of until MOTIR-3512. `workspace_org_member_read` is the mirror of the arm
// above: it requires `app.user_id` to be NON-empty (it EXISTS-checks an
// organization membership), so it cannot arm a USERLESS caller, exactly as
// `attachment_org_service_read` cannot arm a user-bound one. So the over-clear
// runs in both directions — a table can read ARMED to a caller whose GUC set no
// arm on it actually admits, whichever half of the pair is missing.
//
// `workspace` now carries BOTH, which is why it is genuinely armed for both
// contexts rather than accidentally: MOTIR-2956 added the userless arm for the
// storage-cap sum, MOTIR-3512 the user-bound one for the org's workspace count.
// A table with only ONE of them is the shape to look at twice. Closing the gap
// would mean evaluating each policy's whole `qual` against a caller's actual GUC
// set; this file deliberately states the limit instead, and that trade is
// unchanged — a second polarity is a new instance of the known gap, not a new
// gap.

/** Every table in `public` with row-level security ENABLED. */
export async function rlsEnabledTables(): Promise<Set<string>> {
  const rows = await adminDb.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relrowsecurity
  `;
  return new Set(rows.map((r) => r.relname));
}

/**
 * Every table carrying a READ arm for `guc` — a PERMISSIVE policy covering SELECT
 * (`FOR SELECT` or `FOR ALL`) whose USING clause references
 * `current_setting('<guc>')`.
 *
 * Permissive matters: Postgres combines permissive policies with OR, so such an
 * arm ADMITS. A restrictive one could only ever narrow, and reading it as an arm
 * would be backwards.
 *
 * `excludePolicies` removes named policies from the measurement. It exists for
 * ONE purpose and should not grow others: reconstructing the arm set as it stood
 * before a specific migration, so a guard can prove it WOULD have reported a
 * defect that has since been fixed. A guard that has never been seen to fire is
 * not evidence.
 */
export async function armedTables(
  guc: string,
  excludePolicies: readonly string[] = [],
): Promise<Set<string>> {
  const needle = `%current_setting('${guc}'%`;
  const rows = await adminDb.$queryRaw<{ tablename: string; policyname: string }[]>`
    SELECT DISTINCT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND permissive = 'PERMISSIVE'
       AND cmd IN ('SELECT', 'ALL')
       AND coalesce(qual, '') LIKE ${needle}
  `;
  const excluded = new Set(excludePolicies);
  return new Set(rows.filter((r) => !excluded.has(r.policyname)).map((r) => r.tablename));
}
