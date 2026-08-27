import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  REPO_ROOT,
  specifiersOf,
  stripComments,
  stripTypeOnlyImports,
} from './helpers/importGraph';

// Story 8.12 · Subtask MOTIR-3614 — the guards a coverage percentage cannot see.
//
// Nothing in a coverage report objects to a second implementation of the WebAuthn
// ceremony appearing beside the plugin's, to a parallel write path onto the
// passkey table, or to Prisma reaching that table from outside the repository
// layer. Each is cheap to prevent once and expensive to notice later.
//
// The walker is `tests/helpers/importGraph.ts`'s, reused rather than
// reinvented — including its comment and type-only stripping, so a file
// DOCUMENTING one of these rules does not trip it.

const SOURCE_ROOTS = ['app', 'lib', 'components', 'scripts', 'packages', 'tests'];
const SOURCE_EXT = /\.(ts|tsx|mjs|js|jsx)$/;

/** Every source file under the roots above, repo-relative. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry)) out.push(relative(REPO_ROOT, full));
    }
  };
  for (const root of SOURCE_ROOTS) {
    const full = join(REPO_ROOT, root);
    if (existsSync(full)) walk(full);
  }
  return out;
}

const FILES = sourceFiles();

/**
 * Runtime import specifiers, comments and `import type` already stripped.
 *
 * ⚠️ MEMOISED, and that is a correctness matter rather than a nicety. Three
 * tests below scan the same ~2 000 files, and `stripComments` is a
 * character-by-character scanner — un-memoised, this file passes in isolation
 * and TIMES OUT at 15 s inside a full instrumented run, which is the only place
 * it actually has to pass. A guard that is green alone and red in CI is worse
 * than no guard.
 */
const IMPORT_CACHE = new Map<string, string[]>();

function importsOf(file: string): string[] {
  const hit = IMPORT_CACHE.get(file);
  if (hit) return hit;
  const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
  const specifiers = specifiersOf(stripComments(stripTypeOnlyImports(raw)));
  IMPORT_CACHE.set(file, specifiers);
  return specifiers;
}

/**
 * A whole-repo scan is legitimately slower than a unit test, and the default
 * budget is tuned for one. Stated once here rather than per test.
 *
 * ⚠️ The OPTIONS OBJECT IS THE SECOND ARGUMENT — vitest 4 removed
 * `it(name, fn, options)`, and the old form does not error: it collects as
 * `0 test`, so the guard silently stops running.
 */
const SCAN = { timeout: 60_000 };

describe('the WebAuthn ceremony is the PLUGIN’s', () => {
  it('no file outside node_modules imports `@simplewebauthn/*`', SCAN, () => {
    // `@simplewebauthn/server` and `/browser` are `@better-auth/passkey`'s own
    // dependencies, deliberately absent from `package.json` (MOTIR-3610). A
    // direct import is the beginning of a second implementation of a protocol
    // whose failure mode is "authenticates the wrong person", and it would also
    // pin a version nothing in this repo controls.
    const offenders = FILES.filter((f) =>
      importsOf(f).some((s) => s === '@simplewebauthn' || s.startsWith('@simplewebauthn/')),
    );

    expect(offenders).toEqual([]);
  });

  it('the plugin package itself is imported only where it is REGISTERED', SCAN, () => {
    // Two files, and they are the two halves of the wiring: the server instance
    // and the browser client. Anywhere else means a surface reached past the
    // registration to talk to the plugin directly.
    const importers = FILES.filter((f) =>
      importsOf(f).some(
        (s) => s === '@better-auth/passkey' || s.startsWith('@better-auth/passkey/'),
      ),
    ).sort();

    expect(importers).toEqual(['lib/auth/client.ts', 'lib/auth/index.ts']);
  });
});

describe('the plugin’s own routes are the write path', () => {
  it('no route file exists under `app/api/account/passkeys/`', () => {
    // MOTIR-3611 decided this: `/api/auth/passkey/*` already mounts list, update
    // and delete, and a parallel Motir route would be a SECOND writer onto rows
    // the plugin believes it owns. A new `app/api/**/route.ts` additionally owes
    // a row in `docs/decisions/permission-inventory.md`, which this story has no
    // reason to spend.
    expect(existsSync(join(REPO_ROOT, 'app/api/account/passkeys'))).toBe(false);

    const strays = FILES.filter((f) => f.startsWith('app/api/account/passkeys/'));
    expect(strays).toEqual([]);
  });
});

/**
 * A Prisma DELEGATE CALL on the `passkey` model, however the client expression
 * in front of it is written.
 *
 * ⚠️ NOT `/\bdb\s*\.\s*passkey/`. The repository's own reads are
 * `(tx ?? db).passkey.findMany(…)`, so the character before the dot is a
 * PAREN — a client-identifier-anchored pattern misses every optional-tx read in
 * the repo, which is most of them, and the guard then passes by seeing nothing.
 * Anchoring on the METHOD instead also keeps `authClient.passkey.addPasskey`
 * out: that is the plugin's client, not a Prisma delegate, and it is allowed
 * anywhere.
 */
const PRISMA_DELEGATE =
  /\.\s*passkey\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|create|createMany|update|updateMany|delete|deleteMany|count|upsert|aggregate|groupBy)\b/;

describe('Prisma reaches `passkey` only through its repository', () => {
  it('nothing but `passkeyRepository` names `db.passkey` / `tx.passkey`', SCAN, () => {
    // CLAUDE.md's 4-layer contract, asserted for this table specifically. The
    // repository is the only place a Prisma delegate for it may be addressed;
    // a service or a route reaching past it is the shape the layering exists to
    // stop, and it is invisible to every other guard in the repo.
    //
    // Tests are exempt BY NAME rather than by folder: a fixture legitimately
    // inserts rows through `adminDb`, and exempting `tests/**` wholesale would
    // let a real offender hide behind a `.test.ts` suffix.
    const ALLOWED = new Set(['lib/repositories/passkeyRepository.ts']);

    const offenders = FILES.filter((f) => {
      if (ALLOWED.has(f) || f.startsWith('tests/')) return false;
      return PRISMA_DELEGATE.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')));
    });

    expect(offenders).toEqual([]);
  });

  it('the repository really is the file that does it — the guard is not vacuous', () => {
    // A guard whose allowlist entry has gone stale passes for the wrong reason.
    // This is the assertion that fails if the repository is renamed or emptied,
    // rather than the one above quietly reporting a clean repo.
    const source = readFileSync(join(REPO_ROOT, 'lib/repositories/passkeyRepository.ts'), 'utf8');
    expect(PRISMA_DELEGATE.test(source)).toBe(true);
  });
});

/**
 * SQL with its `--` line comments removed.
 *
 * ⚠️ THE HEADERS IN THIS REPO ARGUE ABOUT RLS AT LENGTH, and this table's
 * argues about why it has none — so a raw `not.toMatch(/ROW LEVEL SECURITY/)`
 * fails on the very comment that explains the decision. Stripping first is what
 * makes the guard read the STATEMENTS.
 */
const sqlStatements = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('the `passkey` table carries no RLS, deliberately', () => {
  it('its migration creates no POLICY and enables no ROW LEVEL SECURITY', () => {
    // ⚠️ DO NOT "FIX" THIS BY ADDING ONE. `passkey` is identity-scoped, not
    // workspace-scoped: the row has no workspace to be discriminated by (a
    // person in four workspaces holds one laptop), and it is read PRE-AUTH —
    // `/passkey/generate-authenticate-options` runs before the password step,
    // with no session and therefore no `app.workspace_id` GUC for a policy to
    // consult. A policy here would hide the row from its only legitimate reader
    // and break sign-in. Authorization is the WebAuthn assertion, not row
    // visibility. The same reasoning is in the migration header, the model's doc
    // comment, and `tests/tenant-root-creation-rls.test.ts`'s documented
    // unguarded set — this guard is the one that runs.
    const sql = sqlStatements(
      readFileSync(
        join(REPO_ROOT, 'prisma/migrations/20260826210000_add_passkey/migration.sql'),
        'utf8',
      ),
    );

    expect(sql).toContain('CREATE TABLE "passkey"');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
  });

  it('no later migration adds one either', () => {
    // The check above pins the migration this story wrote; this one pins the
    // DIRECTORY, so a future migration that turns RLS on for this table fails
    // here rather than at the sign-in it breaks.
    const dir = join(REPO_ROOT, 'prisma/migrations');
    const offenders = readdirSync(dir)
      .filter((d) => statSync(join(dir, d)).isDirectory())
      .filter((d) => {
        const file = join(dir, d, 'migration.sql');
        if (!existsSync(file)) return false;
        const sql = sqlStatements(readFileSync(file, 'utf8'));
        return (
          /\bON\s+"?passkey"?\b/i.test(sql) && /CREATE\s+POLICY|ROW\s+LEVEL\s+SECURITY/i.test(sql)
        );
      });

    expect(offenders).toEqual([]);
  });
});

describe('`TwoFactorMethod` is a closed union, and `passkey` is in it', () => {
  it('the DTO declares exactly the three members', () => {
    // The compiler answers TOTALITY — every `switch` and lookup keyed on this
    // union already had to handle the new member to typecheck. What the compiler
    // cannot say is that the member is still THERE, so this pins the union
    // itself: a later card narrowing it would fail here rather than silently
    // removing `passkey` from the answer 8.13 reads.
    const source = readFileSync(join(REPO_ROOT, 'lib/dto/twoFactor.ts'), 'utf8');
    expect(source).toMatch(
      /export type TwoFactorMethod =\s*'totp'\s*\|\s*'email'\s*\|\s*'passkey';/,
    );
  });
});
