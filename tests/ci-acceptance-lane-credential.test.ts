import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GUARD_ORIGIN_VARS,
  GUARD_REQUIRED_VAR,
  GUARD_TOKEN_VARS,
} from './helpers/acceptanceLaneGuard';

// Guard for MOTIR-4093: NO job in `.github/workflows/**` runs the
// acceptance-lane membership guard without a resolvable status source.
//
// ── The hole ────────────────────────────────────────────────────────────────
// `tests/e2e-acceptance-lane-membership.test.ts` asks the product which
// acceptance receipts are approved, and skips cleanly when it has no credential
// — correct on a laptop and on a fork's pull request. Its own header then
// asserted "It runs in CI." Nobody checked. Not one workflow in this directory
// set `MOTIR_GUARD_TOKEN`, `MOTIR_UPLOAD_TOKEN`, `MOTIR_GUARD_BASE_URL` or
// `MOTIR_BASE_URL`, so the guard took its degraded branch on EVERY run it ever
// had and reported green for eleven weeks, while the lane it was supposed to
// hold at zero grew to 23 specs — about 50 machine-minutes on each of ~20
// merges a day, against a design that intended ~10 seconds.
//
// ── Why this file exists rather than a comment ──────────────────────────────
// The fix itself is three lines of `env:` in one job. What those three lines
// cannot do is survive the next re-organisation of this suite: split the Vitest
// lane, add a nightly job, move the spec into a lane of its own, and the
// credential silently stops reaching it — with no failure, because a guard that
// cannot reach the product PASSES. So the invariant is asserted as a
// SELF-RECOUNTING PREDICATE over the whole workflow directory rather than as a
// check on one job: any job that runs this spec, in any workflow file including
// one that does not exist yet, must carry the credential.
//
// Same mould as `tests/ci-job-timeouts.test.ts`, which derives its subjects from
// the directory rather than listing them, and whose YAML-splitting helper this
// file reuses (the repository has no YAML parser, and duplicating ten lines
// beats adding a dependency to read fourteen files).
//
// ── Two design choices worth stating ────────────────────────────────────────
//
//  1. EVERY HELPER IS INLINE. A non-spec module under `tests/` that calls
//     `readdirSync` is a "scanner module" to
//     `tests/ci-structural-guards-lane.test.ts`, which then pulls its importers
//     into the structural-guard lane's candidate set. This file walks a
//     fourteen-file directory; that is not the whole-tree cost that lane exists
//     for, so it stays a spec with its own walk. The ONE import is the env-var
//     NAMES, from the module that reads them — a workflow guard carrying its own
//     copy of those names is a guard that keeps passing after a rename, which is
//     this card's defect one level up. (`acceptanceLaneGuard.ts` is already
//     declared in `BOUNDED_SCAN_MODULES`, so importing it makes this file a
//     candidate for nothing.)
//
//  2. IT FAILS CLOSED. A vitest invocation whose config this file cannot
//     classify is treated as RUNNING the guard, so it must carry the credential.
//     A predicate that shrugged at an unfamiliar config would be the same shape
//     of check as the one it is here to fix: silent, green, and measuring
//     nothing.

const ROOT = resolve(__dirname, '..');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const ACTIONS_DIR = join(ROOT, '.github/actions');

/** The spec whose credential this file is about. */
const GUARD_SPEC = 'tests/e2e-acceptance-lane-membership.test.ts';
/** What vitest runs under when no `--config` is passed. */
const DEFAULT_CONFIG = 'vitest.config.ts';

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from `ci-job-timeouts.test.ts`, which copied it from
 * `ci-complete-gate.test.ts` — see this file's header.)
 */
function jobsOf(yaml: string): Map<string, string> {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  if (jobsAt === -1) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.set(current, body.join('\n'));
      current = header[1]!;
      body = [];
      continue;
    }
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/**
 * The same text with whole-line comments dropped. Load-bearing twice over here:
 * the env block this guard asserts on EXPLAINS itself in comments that name
 * every variable it sets, and the `run:` scan would otherwise pick a vitest
 * command out of a comment. A credential that exists only in prose must not
 * satisfy anything.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/**
 * Every shell command a job runs, block scalars included. Comment-stripped
 * first, so a `#`-commented command is not a command.
 */
function runCommandsOf(body: string): string[] {
  const lines = codeOf(body).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const first = m[2]!.trim();
    if (!/^[|>][-+]?$/.test(first)) {
      out.push(first);
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (next.trim() === '') continue;
      if (next.length - next.trimStart().length <= indent) break;
      block.push(next.trim());
    }
    out.push(block.join('\n'));
  }
  return out;
}

const PACKAGE_SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * `pnpm test:guards` → `pnpm vitest run --config vitest.guards.config.ts`.
 *
 * A job that reaches vitest through a package script is running vitest, and the
 * predicate has to see through the alias — `structural-guards` is exactly that
 * shape today, and it is the shape a new lane is most likely to take.
 */
function expandScripts(command: string): string {
  return command.replace(/\bpnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(PACKAGE_SCRIPTS, name)
      ? `pnpm ${PACKAGE_SCRIPTS[name]}`
      : whole,
  );
}

/**
 * Does this command EXECUTE test files?
 *
 * `--mergeReports` is the one vitest invocation that does not: it re-reads the
 * blob reports the sharded legs uploaded and re-imposes the coverage thresholds
 * on the merged result. It runs no spec, so it needs no credential.
 */
const runsVitest = (command: string): boolean =>
  /\bvitest\b/.test(command) && !/--mergeReports\b/.test(command);

/** The config a vitest invocation runs under. */
function configOf(command: string): string {
  const m = /--config[=\s]+(\S+)/.exec(command);
  return m ? m[1]!.replace(/^['"]|['"]$/g, '') : DEFAULT_CONFIG;
}

const GLOBSTAR_SLASH = '<<globstar-slash>>';
const GLOBSTAR = '<<globstar>>';

/** A vitest `include` pattern as a RegExp — brace alternation, `**`, `*`. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]*)\}/g, (_m, inner: string) => `(?:${inner.split(',').join('|')})`)
    .split('**/')
    .join(GLOBSTAR_SLASH)
    .split('**')
    .join(GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .split(GLOBSTAR_SLASH)
    .join('(?:.*/)?')
    .split(GLOBSTAR)
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * TypeScript source with its comments dropped.
 *
 * ⚠️ THE BLOCK-COMMENT PATTERN IS ANCHORED TO THE START OF A LINE, AND THAT IS
 * NOT TIDINESS. `tests/**` + `/*.test.ts` — the root config's own `include`
 * glob — contains the four characters that open AND close a block comment, so
 * an unanchored strip silently rewrites it to `tests*.test.ts`, which then
 * matches nothing and answers "this lane does not run the guard". A comment
 * stripper that eats the one pattern this file exists to recognise is exactly
 * the vacuous-green shape the card is about; it was caught here by the
 * discriminating assertion above rather than by luck.
 */
const stripComments = (source: string): string =>
  source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

/** The text between `key: [` and its matching `]`, comments stripped first. */
function arrayLiteralAfter(source: string, key: string): string | null {
  const code = stripComments(source);
  const at = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(code);
  if (!at) return null;
  const start = at.index + at[0].length;
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '[') depth += 1;
    else if (code[i] === ']') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
    }
  }
  return null;
}

const stringLiteralsIn = (text: string): string[] =>
  [...text.matchAll(/['"`]([^'"`\n]*)['"`]/g)].map((m) => m[1]!);

/** Resolve a relative import specifier to a file that exists, or null. */
function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(ROOT, join(fromFile, '..'), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Enumeration {
  /** Every pattern the list names, spreads of LOCAL modules resolved. */
  patterns: string[];
  /** Spread identifiers whose module is not local — `defaultExclude` and kin. */
  unresolved: string[];
}

/**
 * The patterns an `include:` / `exclude:` list names, resolving `...IDENT` one
 * level through a local import.
 */
function enumerationOf(configFile: string, source: string, key: string): Enumeration | null {
  const text = arrayLiteralAfter(source, key);
  if (text === null) return null;
  const patterns = stringLiteralsIn(text);
  const unresolved: string[] = [];
  for (const [, ident] of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    const importOf = new RegExp(
      `import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
    ).exec(source);
    const file = importOf ? resolveLocalImport(configFile, importOf[1]!) : null;
    if (!file) {
      unresolved.push(ident!);
      continue;
    }
    patterns.push(...stringLiteralsIn(stripComments(readFileSync(file, 'utf8'))));
  }
  return { patterns, unresolved };
}

/** The config a config EXTENDS — `import baseConfig from './vitest.config'`. */
function baseConfigOf(configFile: string, source: string): string | null {
  for (const [, specifier] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    if (!/vitest[.\w-]*config/.test(specifier!)) continue;
    const file = resolveLocalImport(configFile, specifier!);
    if (file) return file.slice(ROOT.length + 1);
  }
  return null;
}

/**
 * Does this config's file selection reach {@link GUARD_SPEC}?
 *
 * FAILS CLOSED on every uncertainty it can meet — a config file that is not
 * there, an `include` it cannot read with no base config to follow, a spread it
 * cannot resolve, an import cycle. All of them answer YES, so the job carrying
 * them is asked for the credential and the reader is told to teach this
 * predicate rather than being told nothing.
 */
function selectsGuardSpec(configFile: string, seen: string[] = []): boolean {
  if (seen.includes(configFile)) return true;
  const full = join(ROOT, configFile);
  if (!existsSync(full)) return true;
  const source = readFileSync(full, 'utf8');

  const exclude = enumerationOf(configFile, source, 'exclude');
  if (exclude?.patterns.includes(GUARD_SPEC)) return false;

  const include = enumerationOf(configFile, source, 'include');
  if (include === null) {
    const base = baseConfigOf(configFile, source);
    return base === null ? true : selectsGuardSpec(base, [...seen, configFile]);
  }
  if (include.patterns.includes(GUARD_SPEC)) return true;
  if (include.patterns.some((p) => p.includes('*') && globToRegExp(p).test(GUARD_SPEC)))
    return true;
  return include.unresolved.length > 0;
}

interface Job {
  file: string;
  id: string;
  body: string;
  /** The vitest configs this job EXECUTES test files under. */
  configs: string[];
}

const configsRunBy = (body: string): string[] =>
  runCommandsOf(body).map(expandScripts).filter(runsVitest).map(configOf);

const allJobs: Job[] = workflowFiles.flatMap((file) => {
  const jobs = jobsOf(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
  return [...jobs.entries()].map(([id, body]) => ({
    file,
    id,
    body,
    configs: configsRunBy(body),
  }));
});

const where = (j: Job): string => `${j.file}:${j.id}`;

const vitestJobs = allJobs.filter((j) => j.configs.length > 0);
/** The jobs that run the guard — DERIVED from the tree, never listed. */
const guardJobs = vitestJobs.filter((j) => j.configs.some((c) => selectsGuardSpec(c)));

/** A job-level or step-level `NAME: value`, comments dropped, value trimmed. */
function envValue(body: string, name: string): string | null {
  const m = new RegExp(`^\\s+${name}:[ \\t]*(.*)$`, 'm').exec(codeOf(body));
  return m ? m[1]!.trim().replace(/^['"]|['"]$/g, '') : null;
}

/** The first of a name list the job sets to something NON-EMPTY. */
const settled = (body: string, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = envValue(body, name);
    if (value) return `${name}=${value}`;
  }
  return null;
};

describe('every workflow job that runs the acceptance-lane guard binds it (MOTIR-4093)', () => {
  it('finds the workflows, their jobs, and the vitest lanes among them', () => {
    // A parser regression, a rename, or a directory read that quietly returned
    // less than the tree holds would make every assertion below pass vacuously —
    // which is precisely the failure mode this file is about.
    expect(workflowFiles.length).toBeGreaterThanOrEqual(12);
    expect(workflowFiles).toContain('ci.yml');
    expect(allJobs.length).toBeGreaterThanOrEqual(33);
    expect(vitestJobs.length).toBeGreaterThanOrEqual(2);
    expect(guardJobs.map(where)).toContain('ci.yml:test');
  });

  it('classifies the lanes that do NOT run it — the predicate discriminates', () => {
    // The other half of non-vacuity, and the more important half: a predicate
    // that answered "yes" to everything would also contain `ci.yml:test` and
    // would be asserting nothing about where the credential belongs. The
    // design-asset and structural-guard lanes enumerate their specs explicitly
    // and neither names this one, so neither owes a credential.
    expect(selectsGuardSpec('vitest.design.config.ts')).toBe(false);
    expect(selectsGuardSpec('vitest.guards.config.ts')).toBe(false);
    // ...and the two that DO, one of them only by extending the other.
    expect(selectsGuardSpec('vitest.config.ts')).toBe(true);
    expect(selectsGuardSpec('vitest.collect.config.ts')).toBe(true);
  });

  it('gives EVERY job that runs the guard an ORIGIN and a TOKEN', () => {
    // The load-bearing assertion, as a self-recounting predicate rather than a
    // check on one job: a lane added later that executes this spec without a
    // credential fails here, instead of degrading in silence and reporting green.
    const unbound = guardJobs
      .filter((j) => !settled(j.body, GUARD_ORIGIN_VARS) || !settled(j.body, GUARD_TOKEN_VARS))
      .map(where);
    expect(
      unbound,
      `these jobs run ${GUARD_SPEC} with no status source, so it degrades to a check that ` +
        `measures nothing — set ${GUARD_ORIGIN_VARS[0]} and ${GUARD_TOKEN_VARS[0]} in the job's env`,
    ).toEqual([]);
  });

  it('gives EVERY job that runs the guard the binding DECLARATION', () => {
    // Without it `requireStatusSource` degrades rather than failing, so a job
    // that wires a credential and forgets this line is back to a guard that
    // cannot report its own mis-wiring — the state MOTIR-4093 is about.
    const undeclared = guardJobs.filter((j) => !envValue(j.body, GUARD_REQUIRED_VAR)).map(where);
    expect(
      undeclared,
      `these jobs run ${GUARD_SPEC} without declaring ${GUARD_REQUIRED_VAR}, so a missing or ` +
        'revoked credential would silently take the degraded branch instead of failing',
    ).toEqual([]);
  });

  it('keeps the token in a SECRET, never a literal in a workflow file', () => {
    for (const job of guardJobs) {
      const token = settled(job.body, GUARD_TOKEN_VARS)!;
      expect(
        token,
        `${where(job)}: a credential written into a workflow file is a leaked one`,
      ).toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it('leaves the fork degradation intact — the declaration is CONDITIONAL', () => {
    // The discriminator cannot be `CI`: a fork's pull request sets it and is
    // given no secrets, so requiring the credential unconditionally would
    // red-light exactly the runs whose degradation is the stated design.
    // Whichever way the expression is written, it has to read the fork bit.
    for (const job of guardJobs) {
      expect(
        envValue(job.body, GUARD_REQUIRED_VAR),
        `${where(job)}: ${GUARD_REQUIRED_VAR} must exempt a fork's pull request, which gets no secrets`,
      ).toMatch(/fork/);
    }
  });

  it('leaves no vitest run OUTSIDE the workflow directory for this file to miss', () => {
    // The one hole a `.github/workflows/**` scan has: a composite action that
    // runs vitest is invoked BY a job and is invisible to the scan above. There
    // are none today; this is what makes that a checked fact rather than an
    // assumption, and it fails on the first one rather than after it has been
    // green for eleven weeks.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.ya?ml$/.test(entry.name) &&
          runsVitest(expandScripts(codeOf(readFileSync(full, 'utf8'))))
        )
          offenders.push(full.slice(ROOT.length + 1));
      }
    };
    walk(ACTIONS_DIR);
    expect(
      offenders,
      'a composite action running vitest is a lane this guard cannot see — either move the ' +
        'invocation into the workflow that calls it, or widen this scan to cover it',
    ).toEqual([]);
  });
});

// ── THE PREDICATE ITSELF, ON FIXTURES ───────────────────────────────────────
//
// The assertions above read the real tree, so each of them can only ever report
// on the state it happens to be in. These drive the same functions over inputs
// this repository does not contain — a lane that reintroduces the hole, an
// alias, a config nobody has written — because a guard nobody has watched fail
// is a guard nobody knows works.

describe('the predicate itself', () => {
  const job = (lines: string[]): Job => {
    const entries = [...jobsOf(`jobs:\n${lines.join('\n')}`).entries()];
    const [id, body] = entries[0]!;
    return { file: 'fixture.yml', id, body, configs: configsRunBy(body) };
  };

  it('SEES a new lane that runs the whole suite, whatever it is called', () => {
    const nightly = job([
      '  nightly:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: pnpm vitest run',
    ]);
    expect(nightly.configs).toEqual([DEFAULT_CONFIG]);
    expect(selectsGuardSpec(nightly.configs[0]!)).toBe(true);
    expect(settled(nightly.body, GUARD_TOKEN_VARS)).toBeNull();
  });

  it('SEES vitest through a package-script alias', () => {
    // `structural-guards` reaches vitest as `pnpm test:guards`, and a new lane
    // is as likely to add a script as to spell the command out.
    expect(expandScripts('pnpm test:guards')).toContain('vitest');
    expect(job(['  aliased:', '    steps:', '      - run: pnpm test:guards']).configs).toEqual([
      'vitest.guards.config.ts',
    ]);
    expect(job(['  aliased:', '    steps:', '      - run: pnpm test']).configs).toEqual([
      DEFAULT_CONFIG,
    ]);
  });

  it('SEES a command inside a block scalar', () => {
    expect(
      job([
        '  blocked:',
        '    steps:',
        '      - run: |',
        '          pnpm install --frozen-lockfile',
        '          pnpm vitest run --config vitest.collect.config.ts --shard=1/2',
      ]).configs,
    ).toEqual(['vitest.collect.config.ts']);
  });

  it('IGNORES the merge job — it re-reads blobs and executes no spec', () => {
    expect(runsVitest('pnpm vitest --mergeReports --coverage')).toBe(false);
    expect(
      job(['  coverage:', '    steps:', '      - run: pnpm vitest --mergeReports']).configs,
    ).toEqual([]);
  });

  it('IGNORES a command, and a credential, that is only a COMMENT', () => {
    // The env block this guard asserts on explains itself in prose that names
    // every variable and the spec, so a scan that read comments would find a
    // credential and a lane that do not exist.
    expect(job(['  commented:', '    steps:', '      # - run: pnpm vitest run']).configs).toEqual(
      [],
    );
    expect(envValue('    # MOTIR_GUARD_TOKEN: leaked', 'MOTIR_GUARD_TOKEN')).toBeNull();
  });

  it('FAILS CLOSED on a config it cannot classify', () => {
    // A predicate that shrugged at an unfamiliar config would be the same shape
    // of check as the one this card is fixing.
    expect(selectsGuardSpec('vitest.does-not-exist.config.ts')).toBe(true);
  });

  it('reads an EMPTY env value as unset — `secrets.MISSING` expands to one', () => {
    // The failure this whole card is downstream of: a name in a workflow file is
    // a CLAIM about a value, not a value. A job wiring a secret that does not
    // exist supplies an empty string, and a predicate matching the NAME would
    // call that bound. (Twice over here: `MOTIR_UPLOAD_TOKEN` and then
    // `MOTIR_GUARD_TOKEN` were each named on this card before either existed.)
    const wired = job([
      '  wired:',
      '    env:',
      '      MOTIR_GUARD_TOKEN:',
      '    steps:',
      '      - run: pnpm vitest run',
    ]);
    expect(settled(wired.body, GUARD_TOKEN_VARS)).toBeNull();
  });

  it('accepts either name on each axis, guard-specific first', () => {
    const legacy = job([
      '  legacy:',
      '    env:',
      '      MOTIR_BASE_URL: https://app.motir.co',
      '      MOTIR_UPLOAD_TOKEN: ${{ secrets.MOTIR_UPLOAD_TOKEN }}',
      '    steps:',
      '      - run: pnpm vitest run',
    ]);
    expect(settled(legacy.body, GUARD_ORIGIN_VARS)).toBe('MOTIR_BASE_URL=https://app.motir.co');
    expect(settled(legacy.body, GUARD_TOKEN_VARS)).toContain('MOTIR_UPLOAD_TOKEN=');
  });

  it('does NOT let comment-stripping eat the globstar out of an include', () => {
    // The one that actually bit while this file was being written, and the
    // reason `stripComments` anchors its block pattern: a globstar carries the
    // opener AND the closer of a block comment, so an unanchored strip turns
    // `tests/**/*.test.ts` into `tests*.test.ts` — a config that then appears to
    // run nothing, silently, which is this card's own failure shape.
    const config = [
      'export default { test: {',
      "  include: ['tests/**/*.test.{ts,tsx}'],",
      '} };',
    ].join('\n');
    expect(stringLiteralsIn(arrayLiteralAfter(config, 'include')!)).toEqual([
      'tests/**/*.test.{ts,tsx}',
    ]);
    // …while a real comment is still dropped.
    expect(stripComments(['/**', ' * doc', ' */', "const a = 'b';"].join('\n')).trim()).toBe(
      "const a = 'b';",
    );
  });

  it('matches the include glob the root config actually uses', () => {
    const glob = 'tests/**/*.test.{ts,tsx}';
    expect(globToRegExp(glob).test(GUARD_SPEC)).toBe(true);
    expect(globToRegExp(glob).test('tests/rls/call-site-guard.test.ts')).toBe(true);
    expect(globToRegExp(glob).test('tests/e2e/acceptance-x.spec.ts')).toBe(false);
  });
});
