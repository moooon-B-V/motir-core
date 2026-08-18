import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { policyGatedModels } from './singletonReadScan';
import { SINGLETON_ONLY, isClientExpression } from './testCallSiteScan';

// The TEST direct-statement scanner (MOTIR-2918).
//
// ── The shape NOTHING in this repo enumerated ───────────────────────────────
// A statement written STRAIGHT onto the `@/lib/db` singleton, inside a test:
//
//   expect(await db.apiToken.count()).toBe(0);
//   await db.organizationMembership.deleteMany({ where: { userId } });
//
// Five instruments walk this repo and not one of them matches it:
//
//   singletonReadScan     lib/repositories  repository METHODS reading unbound
//   callSiteScan          lib + app         production call sites passing no tx
//   bareTransactionScan   lib + app         a db.$transaction binding no GUC
//   systemContextScan     lib + app + tests withSystemContext over unarmed tables
//   testCallSiteScan      tests             `<x>Repository.<method>(…)` calls ONLY
//
// The last one is the near miss: it reads the same directory this one does and
// asks about a REPOSITORY CALL. A test that skips the repository and addresses
// Prisma directly carries no repository identifier anywhere on the line, so it
// falls through — and that is the majority shape in `tests/e2e/**`.
//
// ── Why it matters, and why it is not merely untidy ─────────────────────────
// Under `motir_app` an unbound statement against a policy-gated table is not an
// error. A read returns `[]` and a write matches nothing; neither RAISES. So an
// assertion that expects EMPTINESS — `expect(await db.apiToken.count()).toBe(0)`
// — goes green while checking nothing at all. MOTIR-2911 found eight of those in
// one file. A count of zero looks exactly like data.
//
// ── Why an AST and not the grep that has already been run twice ─────────────
// This population has been swept by hand twice (the twenty fixture batches
// MOTIR-2735…2754, then MOTIR-2881 / MOTIR-2882) and each sweep's list was
// short. Both were greps, and a grep is wrong here in three separate ways:
//
//   1. It counts LINES. A call wrapped across lines is one statement and zero or
//      two hits depending on where the author broke it.
//   2. It needs a whitelist of OPERATION NAMES (`findMany|count|…`). `notes.html`
//      #231 is precisely this failure one level up: a gate detector keyed on a
//      list of names could not see the three gates somebody had thought hard
//      enough about to name specially. This walk matches `db.<model>.<ANY>(…)`,
//      so a new Prisma operation is in scope the day it is written.
//   3. It cannot tell `db` from `adminDb` from `(tx ?? db)` without a parser, and
//      those three are respectively the bug, the correct form, and the form that
//      hid eleven repository methods from `testCallSiteScan` (MOTIR-2911).
//
// The client predicate is IMPORTED from `testCallSiteScan` rather than
// re-derived — see `SINGLETON_ONLY` below for why the NAME SET differs while the
// unwrapping does not.
//
// ── What it deliberately does NOT decide ────────────────────────────────────
// What any given statement should BECOME. Four remediations exist and only one
// of them is derivable from the syntax (see `StatementVerdict`); the other three
// are properties of the test's INTENT, which no parse recovers. So the map ships
// WITH the scanner, in the same division of labour `ADJUDICATED_UNBOUND_FILES`
// and the MOTIR-2784 `VERDICTS` map use: the machine enumerates, a human
// adjudicates, and an unadjudicated statement is counted rather than assumed.
//
// ── WHAT THIS SCANNER DOES NOT READ ─────────────────────────────────────────
// `tests/` only, and within it only statements reached through an identifier
// this module calls a client. It does NOT read `lib/`, `app/`, `scripts/` or
// `prisma/`. It does not follow a client passed into a helper as a parameter,
// and it does not resolve `db` re-exported under another name. Saying so is the
// sentence whose absence let the class this file enumerates stay invisible
// through five scanners (`notes.html` #268); do not delete it.

const TESTS_DIR = 'tests';
const SCHEMA = 'prisma/schema.prisma';
const MIGRATIONS = 'prisma/migrations';

/** `tests/e2e/**` is a different remediation from the rest — see `Area`. */
const E2E_PREFIX = 'tests/e2e/';

/**
 * WHY THE CLIENT SET IS NARROWER THAN `testCallSiteScan`'s.
 *
 * That scanner asks "which models does this repository method address?", so
 * every client name counts — `db`, `tx`, `client`, `adminDb`, `t`. This one asks
 * a different question: "which statements run on the UNBOUND singleton?", and
 * the answer is exactly `db` (including the `(tx ?? db)` fallback, whose right
 * arm IS the singleton and which therefore reaches it whenever no `tx` is
 * supplied).
 *
 * The two names it must NOT report are the two that are already correct:
 *   • `adminDb` — the database OWNER. A fixture, a teardown or a direct-DB
 *     assertion belongs there by the shipped rule (`tests/helpers/adminDb.ts`),
 *     so reporting one would invert the advice.
 *   • a bare `tx` — inside `withWorkspaceServiceContext(ws, (tx) => …)` that IS
 *     the bound form. Reporting it would ask an author to un-fix a fixed line.
 *
 * `SINGLETON_ONLY` lives in `testCallSiteScan` beside `CLIENTS` so the two sets
 * are read together, and `isClientExpression` takes the set as a PARAMETER so
 * the paren/`??` unwrapping — the part that must not diverge, and the part that
 * was wrong for months — has exactly one implementation.
 */
export { SINGLETON_ONLY };

export type StatementVerdict =
  /**
   * The model is not in `policyGatedModels` at all. No policy applies, so the
   * singleton is the right client. LEAVE IT. Derived, not adjudicated.
   */
  | 'not-gated'
  /**
   * NOT GATED AFTER ALL. `policyGatedModels` OVER-APPROXIMATES on purpose — a
   * model carrying a `workspaceId` column is in scope whether or not its table
   * was ever put under RLS. Adjudicated per MODEL in `NO_POLICY_MODELS` with a
   * `pg_class` / `pg_policies` reading, and cross-checked by the guard against
   * the migrations. LEAVE IT.
   */
  | 'no-policy'
  /**
   * ADJUDICATED: the UNBOUND statement is what the test asserts ABOUT. Moving it
   * to `adminDb` does not improve the file, it DELETES the test. LEAVE IT.
   */
  | 'subject'
  /**
   * ADJUDICATED: a setup / teardown WRITE. It belongs on `adminDb`, the owner.
   * Work, not a leave-alone — the conversion is a later card's.
   */
  | 'fixture'
  /**
   * ADJUDICATED: a direct-DB ASSERTION read. It belongs on `adminDb` too, and it
   * is the half the twenty fixture batches left behind (MOTIR-2881). Work.
   */
  | 'assertion'
  /**
   * Gated, on the singleton, and nobody has ruled on it. THE DEFAULT, and the
   * work-list. It is never inferred from the shape: a statement lands here
   * because a human has not yet said which of the three above it is.
   */
  | 'undispositioned';

/** The three adjudications a human can record against a FILE. */
export type Disposition = Extract<StatementVerdict, 'subject' | 'fixture' | 'assertion'>;

/** Which population a statement belongs to. The two ratchet separately. */
export type Area = 'e2e' | 'vitest';

/**
 * Models `policyGatedModels` reports as gated whose TABLE is not under RLS.
 *
 * ⚠️ THE REASON MUST CARRY THE MEASUREMENT, NOT AN INFERENCE — the same rule
 * `bare-transaction-guard.test.ts` enforces on its own `no-policy` verdicts, and
 * for the same reason: the schema heuristic is not the authority, `pg_class` is.
 * Measured on the migrated schema at the commit that shipped this scanner, with
 *
 *   select c.relname, c.relrowsecurity,
 *          (select count(*) from pg_policies p where p.tablename = c.relname)
 *     from pg_class c join pg_namespace n on n.oid = c.relnamespace
 *    where n.nspname = 'public' and c.relkind = 'r';
 *
 * run against a cluster built by `prisma migrate deploy` from an empty database.
 * The same run confirmed the OTHER direction, which is the half an exemption
 * list normally cannot show: of every model addressed anywhere under `tests/`,
 * exactly six tables have `relrowsecurity = f`, and five of them
 * (`user`, `account`, `session`, `idea_draft`, `user_appearance_preference`)
 * are already outside `policyGatedModels` and come out `not-gated` on their own.
 * `device_code` is the entire discrepancy — so this map is COMPLETE against that
 * measurement, not merely populated with what someone noticed.
 */
export const NO_POLICY_MODELS: Record<string, string> = {
  // `device_code` carries a `workspaceId` column, which is the only reason the
  // schema heuristic puts it in scope, and it has no policy and no RLS at all —
  // no migration ever names the table in a `CREATE POLICY` or an
  // `ENABLE ROW LEVEL SECURITY`, which the guard asserts independently. The
  // sibling `bare-transaction-guard.test.ts` reached the same verdict for the
  // three `cliDeviceService` transactions, from its own reading.
  deviceCode: 'device_code: relrowsecurity=f, 0 rows in pg_policies — measured (MOTIR-2918)',
};

/**
 * Files whose direct-singleton statements have a recorded human ruling.
 *
 * ── Why the channel exists, and why it is keyed on the FILE ────────────────
 * Three of the four remediations are properties of the test's INTENT. A
 * `db.workItem.findMany()` that seeds a board, one that asserts a service wrote
 * the row, and one whose whole subject is what the policy does to an unbound
 * read are the same three tokens on the page and need three different edits.
 * The file is the unit that carries intent — a repository-contract suite, an
 * `*-rls` suite, an E2E seeding helper — and it is line-independent, so an
 * unrelated edit above does not re-open a settled adjudication.
 *
 * ⚠️ CHECKED AFTER `not-gated` AND `no-policy`, NEVER BEFORE. A file ruling says
 * what to do about the statements that are ACTUALLY GATED; letting it win first
 * would relabel every ungated statement in the file as work. This is the same
 * ordering `ADJUDICATED_UNBOUND_FILES` had to be corrected into after checking
 * it first mislabelled 13 legitimate calls.
 *
 * ⚠️ AN ENTRY IS AN ADJUDICATION, NOT A TODO. It carries the card that decided
 * it, and the guard pins the key set — so a new entry fails the build until a
 * human adds it here on purpose.
 *
 * ⚠️ A FILE-LEVEL RULING IS COARSE, DELIBERATELY. A statement of a different
 * kind added to a dispositioned file later inherits that file's ruling in
 * silence. That is the known cost of the only key an intent can attach to; what
 * bounds it is the ceiling below, which counts `fixture` + `assertion` +
 * `undispositioned` together, so a new statement in an `assertion` file still
 * raises the number it must not raise.
 */
export const DISPOSITIONED_FILES: Record<string, readonly [Disposition, string]> = {
  // MOTIR-2918: the file's subject IS the refusal. It asserts that an INSERT
  // into a tenant root outside a bootstrap context is rejected by the policy
  // (`rejects.toThrow(/row-level security/i)`), which only happens on the
  // unbound singleton. `adminDb` is the owner and would be allowed; a bound
  // context would supply the very GUC the test withholds. Either edit deletes
  // the assertion while leaving it green — the vacuous-pass shape, arriving from
  // the direction of a "fix".
  'tests/tenant-root-creation-rls.test.ts': [
    'subject',
    'MOTIR-2918: the subject IS the unbound INSERT being refused by the tenant-root policy.',
  ],

  // MOTIR-2918: MOTIR-2911's founding shape, in the SIBLING file its list never
  // named. Four `expect(await db.apiToken.count()).toBe(N)` assertion reads on a
  // table measured `relrowsecurity=t, 1 policy`, so under `motir_app` the count
  // is 0 whatever the rows say — and three of the four assert `toBe(0)`, which
  // passes for the wrong reason. Its twin `cliDeviceService.test.ts` had exactly
  // these moved to `adminDb` by hand; this file was not on that card's list.
  //
  // ✅ DISCHARGED by MOTIR-2952 — all four are on `adminDb` and the file's
  // `apiToken` statement count is now 0, ratcheted in the guard. The RULING
  // stays, and deliberately: it is what the remaining twelve `device_code`
  // statements are ordered against (`no-policy` is checked BEFORE a file ruling,
  // and this file is the only real-data fixture that pins that), and a NEW gated
  // statement added here inherits `assertion` — which still counts toward the
  // ceiling, so it raises the number it must not raise rather than hiding.
  'tests/cli/cli-device-routes.test.ts': [
    'assertion',
    'MOTIR-2911/2918: direct-DB `apiToken` assertion reads; they belong on `adminDb` — ' +
      'converted by MOTIR-2952, ruling retained for anything added next.',
  ],

  // MOTIR-2896: the subject IS the unbound read returning nothing. One
  // `expect(await db.platformAuditLog.count()).toBe(0)`, guarded by
  // `it.runIf(isAppRoleTestMode())` and paired with an `adminDb` count of 1 on
  // the line above — so the assertion is the DIFFERENCE between the two clients,
  // not a count. `platform_audit_log`'s only policy arm is `app.platform_staff`,
  // which nothing outside `withPlatformRead` binds; moving this read to
  // `adminDb` would make it pass as the owner and prove the opposite of what it
  // claims, and binding a context would supply the very GUC it withholds. This
  // is the shape the guard's own message calls out, and the reason the
  // repository requires `tx` on its reads rather than allowing the singleton.
  'tests/platform/platformAuditLog.test.ts': [
    'subject',
    'MOTIR-2896: the subject IS the unbound read of `platform_audit_log` seeing zero rows.',
  ],
};

export interface TestSingletonStatement {
  /** repo-relative, e.g. `tests/cli/cli-device-routes.test.ts` */
  file: string;
  /** 1-based line of the `db.<model>` access */
  line: number;
  /** the Prisma model, camelCased as the client exposes it — e.g. `apiToken` */
  model: string;
  /** the operation invoked on it, e.g. `count`; null when the model handle is not called */
  op: string | null;
  /** `file:line` */
  key: string;
  area: Area;
  verdict: StatementVerdict;
}

/** A `$queryRaw*` / `$executeRaw*` on the singleton — target unnameable by a parser. */
export interface RawStatement {
  file: string;
  line: number;
  /** `$queryRaw`, `$executeRawUnsafe`, … */
  api: string;
  key: string;
  area: Area;
}

/** `db.<something>` where `<something>` is neither a Prisma model nor a `$` client API. */
export interface UnclassifiableStatement {
  file: string;
  line: number;
  property: string;
}

export interface TestSingletonStatementScan {
  statements: TestSingletonStatement[];
  raw: RawStatement[];
  unclassifiable: UnclassifiableStatement[];
}

function sourceFile(full: string): ts.SourceFile {
  return ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * Every model the Prisma client exposes, camelCased.
 *
 * Needed as a SEPARATE question from `policyGatedModels`: that set answers "is
 * this gated?", and a name absent from it is ungated. This set answers "is this
 * a model at all?", and a name absent from THIS one is a shape the scanner
 * cannot rule on — a typo, a renamed model, a dynamic access — which must
 * surface rather than be filed as ungated. Conflating the two is how a scanner
 * reports its own blind spot as a clean verdict (`notes.html`, MOTIR-2911).
 */
export function prismaModels(root = process.cwd()): Set<string> {
  const src = readFileSync(path.join(root, SCHEMA), 'utf8');
  const models = new Set<string>();
  const modelRe = /^model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(src)) !== null) {
    const name = m[1]!;
    models.add(name[0]!.toLowerCase() + name.slice(1));
  }
  return models;
}

/**
 * Models whose TABLE is named by a `CREATE POLICY` or an
 * `ENABLE ROW LEVEL SECURITY` somewhere in `prisma/migrations`.
 *
 * This is the MIGRATION half of `policyGatedModels`, isolated so the guard can
 * cross-check a `NO_POLICY_MODELS` claim against the repo's own SQL: a human
 * says "this table has no policy" and quotes a `pg_class` reading, and the
 * machine refuses the entry if any migration contradicts it. Neither check is
 * sufficient alone — the SQL sweep is textual and could miss a differently
 * shaped statement, and a reading is a snapshot of one cluster — so both run.
 */
export function policyNamedModels(root = process.cwd()): Set<string> {
  const camel = (table: string): string =>
    table.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const out = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(path.join(root, MIGRATIONS));
  } catch {
    return out; // a fixture root carries no migrations
  }
  for (const d of dirs) {
    let sql: string;
    try {
      sql = readFileSync(path.join(root, MIGRATIONS, d, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    for (const hit of sql.matchAll(/CREATE\s+POLICY\s+"[^"]+"\s+ON\s+"([a-z_]+)"/gi)) {
      out.add(camel(hit[1]!));
    }
    for (const hit of sql.matchAll(
      /ALTER\s+TABLE\s+"([a-z_]+)"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      out.add(camel(hit[1]!));
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      walk(full, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

function areaOf(rel: string): Area {
  return rel.startsWith(E2E_PREFIX) ? 'e2e' : 'vitest';
}

const cache = new Map<string, TestSingletonStatementScan>();

/**
 * Every direct `db.<model>.<op>(…)` statement under `tests/`, classified.
 *
 * Memoised per root for the reason `test-call-site-guard.test.ts` records: the
 * walk parses every `.ts` under `tests/`, which is fine once and is not fine
 * once per `it` on a CI runner with three vitest shards competing for the box.
 */
export function scanTestSingletonStatements(root = process.cwd()): TestSingletonStatementScan {
  const cached = cache.get(root);
  if (cached) return cached;

  const gated = policyGatedModels(root);
  const models = prismaModels(root);
  const statements: TestSingletonStatement[] = [];
  const raw: RawStatement[] = [];
  const unclassifiable: UnclassifiableStatement[] = [];

  for (const full of walk(path.join(root, TESTS_DIR))) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const area = areaOf(rel);
    const sf = sourceFile(full);

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        isClientExpression(node.expression, SINGLETON_ONLY)
      ) {
        const property = node.name.text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

        if (property.startsWith('$')) {
          // `$transaction` / `$connect` / `$disconnect` are not statements against a
          // table — `bareTransactionScan` owns the first and the others touch no row.
          if (property.startsWith('$queryRaw') || property.startsWith('$executeRaw')) {
            raw.push({ file: rel, line, api: property, key: `${rel}:${line}`, area });
          }
        } else if (!models.has(property)) {
          // NOT defaulted to `not-gated`. A name that is not a model is a shape
          // this scanner cannot rule on — a renamed model, a typo, a helper hung
          // off the client — and filing it as ungated is exactly how a blind spot
          // is reported as a clean verdict. It fails the guard instead.
          unclassifiable.push({ file: rel, line, property });
        } else {
          const parent = node.parent;
          const op =
            ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? parent.name.text
              : null;
          const disposition = DISPOSITIONED_FILES[rel];
          const verdict: StatementVerdict = !gated.has(property)
            ? 'not-gated'
            : property in NO_POLICY_MODELS
              ? 'no-policy'
              : disposition
                ? disposition[0]
                : 'undispositioned';
          statements.push({
            file: rel,
            line,
            model: property,
            op,
            key: `${rel}:${line}`,
            area,
            verdict,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  statements.sort((a, b) => a.key.localeCompare(b.key));
  raw.sort((a, b) => a.key.localeCompare(b.key));
  const result: TestSingletonStatementScan = { statements, raw, unclassifiable };
  cache.set(root, result);
  return result;
}

/** Count by verdict — what the ratchets and the PR body are stated in. */
export function countByVerdict(
  statements: TestSingletonStatement[],
): Record<StatementVerdict, number> {
  const counts: Record<StatementVerdict, number> = {
    'not-gated': 0,
    'no-policy': 0,
    subject: 0,
    fixture: 0,
    assertion: 0,
    undispositioned: 0,
  };
  for (const s of statements) counts[s.verdict] += 1;
  return counts;
}

/**
 * The statements that still have to CHANGE, which is what the ceilings count.
 *
 * `not-gated`, `no-policy` and `subject` are correct where they are — the first
 * two because no policy touches the table, the third because moving it deletes
 * the test. Everything else is work: `fixture` and `assertion` have a ruling and
 * no edit yet, `undispositioned` has neither.
 *
 * ⚠️ THE METRIC IS A CLAIM ABOUT WHAT IT COUNTS (`notes.html` #278). This number
 * is NOT the card's 544, and the difference is the definition rather than the
 * world moving: 544 was a grep over LINES matching a whitelist of fourteen
 * operation names on a `db.` prefix. This counts CALL-SITE NODES on a client
 * expression, over ANY operation, minus everything measured to need no change.
 * Quoting one against the other is comparing two different questions.
 */
export function unconverted(statements: TestSingletonStatement[]): TestSingletonStatement[] {
  return statements.filter(
    (s) => s.verdict === 'fixture' || s.verdict === 'assertion' || s.verdict === 'undispositioned',
  );
}

/** The per-area split — `tests/e2e/**` is a different remediation from the rest. */
export function byArea<T extends { area: Area }>(items: T[]): Record<Area, T[]> {
  return {
    e2e: items.filter((i) => i.area === 'e2e'),
    vitest: items.filter((i) => i.area === 'vitest'),
  };
}
