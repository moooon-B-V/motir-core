import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-3852: a migration that DROPS something must declare the
// release in which the generated client stopped asking for it.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 2026-08-28 `get_work_item` returned a 500 for every key in the tenant for
// about six minutes. The expand/contract sequence behind it had been executed
// correctly: two tasks moved every application reader off
// `github_pull_request.work_item_id`, and a third dropped the column afterwards.
// Re-run today that reader enumeration returns nothing, which is the answer a
// finished migration should give.
//
// The thing still selecting the column was not a reader anybody wrote. A Prisma
// relation include with no `select` — `{ pullRequest: true, repo: true }`, as
// `workItemDeliveryRepository` uses — emits EVERY scalar the model declares, so
// the column list a query touches is a property of `prisma/schema.prisma` and of
// no line of application code. **The model declaration is itself a reader, and it
// is the one a search for the field's name cannot find**, which is exactly why a
// complete sweep and a total outage were compatible.
//
// That declaration was removed by `4466ea7ff` — the same commit that dropped the
// column. So the client stopped asking and the column disappeared in ONE release,
// with no interval between them, and `fly.toml`'s `release_command` runs
// `prisma migrate deploy` *before any new machine takes traffic*
// (`scripts/release-migrate.mjs` says so in its own header). The migration
// therefore lands while the PREVIOUS image is still serving, and for the length of
// the rollout that image asks for a column that is gone.
//
// The remedy is a third phase, not a better sweep:
//
//   1. EXPAND        move the application readers.
//   2. SCHEMA-ONLY   stop the generated client selecting the column, keeping the
//                    column — and RELEASE it.
//   3. CONTRACT      drop the column.
//
// `docs/decisions/delivery-reader-migration.md` §6a carries the rule in full.
//
// ─── WHAT THIS GUARD HOLDS, AND WHAT IT CANNOT ───────────────────────────────
//
// The property that actually matters is HISTORICAL — *was the client already not
// selecting this column in the previous release?* — and at the CONTRACT commit
// the tree looks identical either way: the field is absent from the schema and
// the migration drops the column in BOTH the safe and the unsafe case. Nothing
// static can tell them apart.
//
// The obvious answer is to read the diff, and that was measured and REJECTED. The
// repository has tried it: `tests/api/v1/work-loop-story-gate.test.ts` GUARD 4
// records `git diff --name-only <merge-base>` as *"WRONG — not weak, wrong: the
// CI checkout is shallow and has no `origin/main`, so the guard threw on every
// run while passing locally. A check that only works in the author's worktree is
// worse than none, because it reads as coverage."* Only ONE of `ci.yml`'s
// thirteen checkouts pays `fetch-depth: 0` (the `changes` job, whose entire
// output is two booleans), and the workflow says outright that it fetches a base
// on demand *"rather than paying `fetch-depth: 0` on every run."* A guard that
// needs history would be the third instance of a mistake this repository has
// already written down twice.
//
// So this guard holds the property the diff was standing in for, as a
// DECLARATION. Its cost and its blind spot, stated plainly because a guard whose
// limits are not written down is one the next reader will over-trust:
//
//   • BLIND SPOT — the marker's TRUTH is asserted by the author. Nothing here can
//     prove the named card actually shipped and released the schema-only phase.
//     What the guard removes is the SILENT version: a drop can no longer be
//     written by someone who never considered the question.
//   • COST — one line in a migration, and a rule a person can be wrong about.
//
// The second check below is the half that IS mechanical: a column this repository
// drops may not still be declared in the datamodel. That one needs no history and
// no declaration, and it catches the cruder sibling of the same defect.

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = join(ROOT, 'prisma', 'schema.prisma');

/** `DROP COLUMN` / `DROP TABLE` — the statements that remove something a
 *  still-serving image may be asking for. `DROP CONSTRAINT` and `DROP INDEX` are
 *  deliberately NOT here: a client does not select a constraint. */
const DESTRUCTIVE = /\bDROP\s+(?:COLUMN|TABLE)\b/i;

/** The marker, on its own line, naming the work item whose release stopped the
 *  client selecting it. Matched anywhere in the file so it can sit in the header
 *  block where the reason belongs. */
const MARKER = /^--\s*@client-stopped-selecting:\s*(MOTIR-\d+)\s*$/m;

/** `ALTER TABLE "t" ... DROP COLUMN "c"` — captured as a (table, column) pair,
 *  because a bare column name is ambiguous across tables: `work_item_id` was
 *  dropped from `github_pull_request` while `work_item_delivery` still carries
 *  one, and a guard that compared bare names would call that a violation. */
const ALTER_TABLE = /ALTER\s+TABLE\s+"([^"]+)"([\s\S]*?);/gi;
const DROP_COLUMN = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;

// The migrations that predate this rule — an enumerated SET, not a date cutoff.
//
// Coverage is a set and never an interval: a cutoff would exempt anything that
// happened to sort below it, including a migration added later on a long-lived
// branch. Measured at `origin/main` `2a30b92fd` with
//
//   git grep -lE 'DROP COLUMN|DROP TABLE' origin/main -- 'prisma/migrations/**/migration.sql'
//
// — 10 of 188 migrations. The pathspec is load-bearing: dropping it widens the
// answer to 13, because three `down.sql` rollback scripts naturally contain a
// `DROP TABLE`. This guard reads `migration.sql` only, so those three are out of
// scope by construction rather than by exemption.
//
// ⚠️ This list only ever SHRINKS. Adding to it is the one edit that silently
// disables the guard for a new migration, which is why the test below asserts
// every member still exists: a stale entry is a hole, and a removed migration
// would leave one behind.
const PRE_RULE_MIGRATIONS: ReadonlySet<string> = new Set([
  '20260524175542_add_user_account_session_verification',
  '20260608224711_add_project_membership_and_roles',
  '20260615130000_drop_triage_external_submitter',
  '20260707130000_acceptance_trace_attachment',
  '20260731230000_add_project_repo_collaborator',
  '20260802200000_drop_ci_runner_supervision_memo',
  '20260811223000_drop_project_preset_avatar',
  '20260819010000_retire_work_item_target_repo_role',
  '20260822010000_drop_code_graph_pending_change',
  '20260828200000_drop_github_pull_request_work_item_id',
]);

const REMEDY = [
  'A migration that drops a column or a table must declare the release in which the',
  'generated client stopped selecting it, as a line in the migration:',
  '',
  '    -- @client-stopped-selecting: MOTIR-<n>',
  '',
  'If no such release has happened yet, this migration is the SECOND phase of a',
  'three-phase change and it is too early to write: ship the schema-only phase',
  'first (take the field out of the generated client, leave the column), let it',
  'reach every machine, and drop the column in a later release.',
  '',
  'The rule and the incident behind it: docs/decisions/delivery-reader-migration.md §6a.',
].join('\n');

interface Migration {
  readonly name: string;
  readonly sql: string;
}

function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, file: join(MIGRATIONS_DIR, entry.name, 'migration.sql') }))
    .filter((entry) => existsSync(entry.file))
    .map((entry) => ({ name: entry.name, sql: readFileSync(entry.file, 'utf8') }));
}

/** Every (table, column) pair a migration's SQL drops. */
export function droppedColumns(sql: string): { table: string; column: string }[] {
  const pairs: { table: string; column: string }[] = [];
  for (const [, table, body] of sql.matchAll(ALTER_TABLE)) {
    if (table === undefined || body === undefined) continue;
    for (const [, column] of body.matchAll(DROP_COLUMN)) {
      if (column === undefined) continue;
      pairs.push({ table, column });
    }
  }
  return pairs;
}

/**
 * table name → the set of column names its Prisma model still declares.
 *
 * A model's table is its `@@map(...)` when it has one and its model name
 * otherwise; a field's column is its `@map(...)` when it has one and the field
 * name otherwise. Relation fields carry no column of their own and are skipped —
 * they are the lines with a `@relation(...)` attribute or a `[]` list type.
 */
export function declaredColumnsByTable(schema: string): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const [, modelName, body] of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (modelName === undefined || body === undefined) continue;
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? modelName;
    const columns = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;
      const field = /^(\w+)\s+(\S+)/.exec(line);
      const [, fieldName, fieldType] = field ?? [];
      if (fieldName === undefined || fieldType === undefined) continue;
      if (line.includes('@relation(') || fieldType.endsWith('[]')) continue;
      columns.add(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? fieldName);
    }
    byTable.set(table, columns);
  }
  return byTable;
}

describe('a destructive migration declares the release that stopped the client selecting it', () => {
  const migrations = readMigrations();

  it('the migration corpus is readable, so a silent zero cannot pass this file', () => {
    // Every assertion below quantifies over `migrations`; an empty list would
    // satisfy all of them. This is the check that the population is real.
    expect(migrations.length).toBeGreaterThan(150);
    expect(migrations.filter((m) => DESTRUCTIVE.test(m.sql)).length).toBeGreaterThan(0);
  });

  it('every PRE-RULE migration still exists — a stale exemption is a hole', () => {
    const present = new Set(migrations.map((m) => m.name));
    for (const name of PRE_RULE_MIGRATIONS) {
      expect(present, `${name} is exempted but no longer exists — drop it from the set`).toContain(
        name,
      );
    }
  });

  it('every PRE-RULE migration is actually destructive — the set exempts nothing else', () => {
    // Keeps the exemption honest in the other direction: a name added here for a
    // migration that drops nothing would be exempting a future edit to that file.
    const byName = new Map(migrations.map((m) => [m.name, m.sql]));
    for (const name of PRE_RULE_MIGRATIONS) {
      expect(DESTRUCTIVE.test(byName.get(name) ?? ''), `${name} drops nothing`).toBe(true);
    }
  });

  it('every destructive migration outside that set carries a well-formed marker', () => {
    const offenders = migrations
      .filter((m) => !PRE_RULE_MIGRATIONS.has(m.name))
      .filter((m) => DESTRUCTIVE.test(m.sql))
      .filter((m) => !MARKER.test(m.sql))
      .map((m) => m.name);

    expect(offenders, `${offenders.join(', ')}\n\n${REMEDY}`).toEqual([]);
  });

  it('no column dropped outside that set is still declared in the datamodel', () => {
    // The mechanical half, and the one that needs neither history nor a
    // declaration: dropping a column the datamodel still declares is drift AND an
    // instant outage on every read of that model. Scoped to migrations outside
    // the pre-rule set so history can never turn `main` red — the fixtures below
    // are what prove the logic.
    const declared = declaredColumnsByTable(readFileSync(SCHEMA_PATH, 'utf8'));
    const violations: string[] = [];
    for (const migration of migrations) {
      if (PRE_RULE_MIGRATIONS.has(migration.name)) continue;
      for (const { table, column } of droppedColumns(migration.sql)) {
        if (declared.get(table)?.has(column)) {
          violations.push(`${migration.name}: ${table}.${column} is still in schema.prisma`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('the guard FAILS on the shape it exists to refuse', () => {
  // AC 2 — proved by a NEGATIVE. A guard asserted only in the passing direction
  // is the vacuous-guard shape: it would go green on a corpus that happens to
  // contain no destructive migration at all.

  const UNSAFE = `-- The two-phase drop this guard refuses.
ALTER TABLE "github_check_run" DROP COLUMN "feedback_comment_id";
`;

  const SAFE = `-- @client-stopped-selecting: MOTIR-3863
ALTER TABLE "github_check_run" DROP COLUMN "feedback_comment_id";
`;

  it('a DROP COLUMN with no marker is destructive and unmarked', () => {
    expect(DESTRUCTIVE.test(UNSAFE)).toBe(true);
    expect(MARKER.test(UNSAFE)).toBe(false);
  });

  it('the same migration with the marker passes, and the marker names the card', () => {
    expect(DESTRUCTIVE.test(SAFE)).toBe(true);
    expect(MARKER.exec(SAFE)?.[1]).toBe('MOTIR-3863');
  });

  it('a marker that names nothing does not satisfy the check', () => {
    expect(MARKER.test('-- @client-stopped-selecting:\nALTER TABLE "t" DROP COLUMN "c";')).toBe(
      false,
    );
    expect(
      MARKER.test('-- @client-stopped-selecting: soon\nALTER TABLE "t" DROP COLUMN "c";'),
    ).toBe(false);
  });

  it('an ADDITIVE migration is not destructive, so the rule never fires on one', () => {
    // The population this guard must not touch: 178 of the 188 migrations, and
    // every migration a `CREATE TABLE` / `ADD COLUMN` change ships.
    expect(DESTRUCTIVE.test('ALTER TABLE "job_run" ADD COLUMN "supervision_id" TEXT;')).toBe(false);
    expect(DESTRUCTIVE.test('CREATE TYPE "JobSupervisionState" AS ENUM (\'watching\');')).toBe(
      false,
    );
    // A constraint or an index is not something a client selects.
    expect(DESTRUCTIVE.test('ALTER TABLE "t" DROP CONSTRAINT "t_fkey";')).toBe(false);
    expect(DESTRUCTIVE.test('DROP INDEX "t_idx";')).toBe(false);
  });

  it('the dropped-column parse keeps the TABLE, so one name in two tables is two facts', () => {
    const sql = `ALTER TABLE "github_pull_request" DROP COLUMN "work_item_id";`;
    expect(droppedColumns(sql)).toEqual([{ table: 'github_pull_request', column: 'work_item_id' }]);
    // The live column of the same name on another table is untouched by that drop.
    const declared = declaredColumnsByTable(readFileSync(SCHEMA_PATH, 'utf8'));
    expect(declared.get('work_item_delivery')?.has('work_item_id')).toBe(true);
    expect(declared.get('github_pull_request')?.has('work_item_id')).toBe(false);
  });

  it('a column still declared in the datamodel is caught, with its table', () => {
    // The mechanical check, run against a violation.
    //
    // ⚠️ THE FIXTURE IS SYNTHETIC, AND THAT IS THE CORRECTION MOTIR-3803 MADE.
    // This assertion used to read the LIVE `prisma/schema.prisma` and assert that
    // `github_check_run.feedback_comment_id` was still declared — true while the
    // SCHEMA-ONLY phase was in flight, and false the moment the CONTRACT phase
    // landed. So the negative case for a guard about dropping columns was itself
    // pinned to a column about to be dropped, and completing the very sequence
    // this guard exists to enforce turned it red. A guard's own fixture must not
    // depend on a transient state of the tree it guards.
    const schema = `model GithubCheckRun {
  id                String  @id
  feedbackCommentId String? @map("feedback_comment_id")

  @@map("github_check_run")
}`;
    const declared = declaredColumnsByTable(schema);
    expect(declared.get('github_check_run')?.has('feedback_comment_id')).toBe(true);
    const dropped = droppedColumns(SAFE);
    expect(
      dropped.some(({ table, column }) => declared.get(table)?.has(column)),
      'a marked migration is still refused while the field is in the datamodel',
    ).toBe(true);
  });

  it('and the REAL schema no longer declares it, so the drop that just landed is clean', () => {
    // The positive counterpart, against the live schema: the CONTRACT phase
    // removed the field in the same commit as the migration, which is the whole
    // property `no column dropped outside that set is still declared` asserts
    // over the corpus. Named here too so the pair reads as one fact.
    const declared = declaredColumnsByTable(readFileSync(SCHEMA_PATH, 'utf8'));
    expect(declared.get('github_check_run')?.has('feedback_comment_id')).toBe(false);
    expect(declared.get('github_check_run')?.has('conclusion')).toBe(true);
  });
});
