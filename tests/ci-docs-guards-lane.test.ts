import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './helpers/importGraph';
import { STRUCTURAL_GUARD_SPECS } from './helpers/structuralGuardLane';
import {
  CARRIED_BY_ANOTHER_LANE,
  DELIBERATELY_OUT,
  DOCS_GUARD_SPECS,
  DOCS_PATH_FORMS,
  FILE_READ_FORMS,
  FORWARD_LOOKING_FORMS,
  docsPathFormsIn,
  docsReadingSpecsIn,
  fileReadFormsIn,
} from './helpers/docsGuardLane';

// MOTIR-4408 — the guard ON the docs-guard lane.
//
// ── What this file exists to prevent ────────────────────────────────────────
// `ci.yml` skips the Vitest, coverage, E2E and image jobs when the `changes`
// job reads a diff as documentation, and rightly so. But a spec whose SUBJECT
// is a `docs/**` file is then run on every pull request except the ones that
// can break it. `vitest.docs.config.ts` is the unconditional lane that fixes
// it, and a lane is an `include` list — so the NEXT docs-reading guard someone
// writes lands in `tests/**`, runs only in the app-gated job, and nothing says
// otherwise until a documentation edit merges green over a rule it falsifies.
//
// So membership is DERIVED here and compared against the list. A new guard
// fails this test, with the file named, until it is either added to the lane or
// declared in `DELIBERATELY_OUT` with a reason.
//
// ── Why a derivation and not three `include` lines ──────────────────────────
// The card that filed this defect enumerated THREE specs, and BOTH ways a list
// of this class goes wrong had already happened to it.
//
// It DRIFTED: `tests/theme/immersiveShellChrome.test.ts` merged at 10:10 and
// `tests/mcp/mcp-doc-guards.test.ts` at 13:11 on the day the card was filed at
// 02:23, each written by a run that had never read it.
//
// And it was WRONG WHEN IT WAS TAKEN, which no re-measurement on a fresher ref
// would have found. The enumerating command looked for a quoted `docs/`
// substring, and the segmented form `join(ROOT, 'docs', 'decisions', …)`
// carries none — so `tests/permissions/catalog.test.ts` and
// `tests/permissions/inventoryCoverage.test.ts`, both opening
// `docs/decisions/permission-inventory.md` since 2026-08-06, and
// `tests/reader-facing-noun.test.ts`, walking `docs/*.md` since 2026-08-10,
// were invisible to it. The command was scoped by how the defect was NOTICED
// rather than by what the claim was ABOUT.
//
// Neither is carelessness; it is what a list of instances does. A check that
// enumerates instances is the same shape as the class it guards.
//
// ── The predicate, and the line it draws ────────────────────────────────────
// A spec READS a `docs/**` file as its subject when it does BOTH: names a path
// into `docs/`, and reads a file off disk. Each half is enumerated with the
// reason it is a carrier, in `tests/helpers/docsGuardLane.ts`.
//
// Neither half alone is the predicate, and the conjunction is what makes it
// quiet enough to be total. `tests/jobs/fast-lane-latency-budget.test.ts` cites
// an ADR in three assertion messages and opens nothing;
// `tests/workItems/proseVsGraph.test.ts` feeds `docs/…` strings to a path
// classifier as fixtures. Both name the tree, neither reads it, and a `docs/**`
// diff can break neither.
//
// ⚠️ THE SOURCE IS COMMENT-STRIPPED before the predicate runs, because a
// guard's comments are exactly where it explains which document it is about.
// `tests/jobs/engine-units.test.ts` still carries
// `docs/decisions/job-queue-foundation.md` in the header of the describe block
// this card split, and it must not be a candidate for a sentence.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-design-guards-lane.test.ts` and
// `tests/ci-complete-gate.test.ts`, whose job-splitting helper is taken from
// there.

const ROOT = process.cwd();
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const DOCS_CONFIG_PATH = join(ROOT, 'vitest.docs.config.ts');
const GUARD_JOB = 'docs-guards';
const GATE_JOB = 'ci-complete';

const ci = readFileSync(CI_PATH, 'utf8');
const docsConfig = readFileSync(DOCS_CONFIG_PATH, 'utf8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from `ci-complete-gate.test.ts` by way of
 * `ci-design-guards-lane.test.ts` — the repo has no YAML parser, and
 * duplicating ten lines beats adding a dependency to read one file.)
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
 * The same YAML with whole-line comments dropped. Load-bearing for the same
 * reason it is in the two files this one is modelled on: the job parser
 * attributes a job's leading comment block to the job before it, and these
 * comments quote the very expressions the assertions look for — this job's own
 * header names `needs.changes.outputs.app` in prose.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const guardCode = codeOf(ciJobs.get(GUARD_JOB) ?? '');

/** Every `*.ts` / `*.tsx` file under `tests/`, as a repo-relative POSIX path. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

const ALL_TEST_FILES = testFiles(join(ROOT, 'tests'));

/**
 * Comment-stripped source, MEMOISED. The derivation and the liveness check
 * below each walk all ~1 600 files under `tests/`, and `stripComments` over
 * that tree three times does not fit a 5 s test budget — the first draft of
 * this file timed out on exactly that. One pass is paid at module load, where
 * no per-test timeout applies, and every later reader hits the map.
 */
const STRIPPED = new Map<string, string>();
function readStripped(file: string): string {
  const memo = STRIPPED.get(file);
  if (memo !== undefined) return memo;
  const stripped = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  STRIPPED.set(file, stripped);
  return stripped;
}

/** Every spec that reads a `docs/**` file as its subject — derived, not listed. */
const DOCS_READERS = docsReadingSpecsIn(ALL_TEST_FILES, readStripped);

/**
 * The UNCONDITIONAL lanes, as one set of specs.
 *
 * ⚠️ The rule this file enforces is *a spec that reads a `docs/**` file as its
 * subject runs in an unconditional lane* — NOT *…runs in the docs lane*. Three
 * lanes in this repository carry no `if:`: this one, the design-asset lane
 * (MOTIR-2442) and the structural-guard lane (MOTIR-3144). A spec already held
 * by one of the others needs nothing from this card, and listing it here would
 * buy a second run of it and a second place for its membership to drift.
 *
 * The design lane's membership is read out of its CONFIG TEXT, the way
 * `tests/ci-design-guards-lane.test.ts` reads it, because that list is written
 * inline there rather than exported.
 */
const DESIGN_CONFIG = readFileSync(join(ROOT, 'vitest.design.config.ts'), 'utf8');
const UNCONDITIONAL_LANES = (file: string): boolean =>
  (DOCS_GUARD_SPECS as readonly string[]).includes(file) ||
  (STRUCTURAL_GUARD_SPECS as readonly string[]).includes(file) ||
  DESIGN_CONFIG.includes(`'${file}'`);

describe('the docs-guard lane (MOTIR-4408)', () => {
  it('finds the job and the config it is meant to guard', () => {
    // A parser regression or a rename would otherwise make every assertion
    // below pass vacuously.
    expect(ciJobs.has(GUARD_JOB)).toBe(true);
    expect(guardCode).toMatch(/^\s*name:\s*Docs guards\s*$/m);
    expect(docsConfig).toContain('include:');
  });

  it('carries NO `app`-gated condition — the hole is one `if:` wide', () => {
    // The load-bearing assertion, and criterion 1 of the card. Everything else
    // in this file is scaffolding around it: a documentation-only pull request
    // that does not run this job is the exact state MOTIR-4408 was filed for.
    // Asserted as the ABSENCE OF ANY `if:` rather than of the one expression,
    // because the next way to switch a job off will not be spelled the way this
    // one was — MOTIR-3148 already moved these gates once, from a branch-prefix
    // test to a `changes` output, and a check written against the old spelling
    // would have survived that move saying nothing.
    expect(guardCode).not.toContain('needs.changes.outputs.app');
    expect(guardCode).not.toContain('startsWith(github.head_ref');
    expect([...guardCode.matchAll(/^ {4}if:(.*)$/gm)]).toEqual([]);
  });

  it('runs the docs config, and needs no database to do it', () => {
    expect(guardCode).toContain('pnpm test:docs-guards');
    expect(packageJson.scripts['test:docs-guards']).toBe(
      'vitest run --config vitest.docs.config.ts',
    );
    // A Postgres service would put this lane back in the cost class the
    // `app=false` classification exists to avoid — which is the thing this card
    // explicitly does not spend. `prisma generate` is a different matter and IS
    // here: `catch-up-disposition-adr.test.ts` imports the job registry, which
    // reaches `@/generated/prisma/client` at module scope. Generating a client
    // is a local codegen step against a schema file; standing up a database is
    // not, and only the second is what makes the sharded job expensive.
    expect(guardCode).not.toContain('actions/postgres');
    expect(guardCode).not.toContain('services:');
  });

  it('leaves the classifier alone — `docs/**` is still not app code (criterion 1)', () => {
    // The remedy this card explicitly refuses. Reclassifying `docs/` in the
    // `changes` job would make these guards run and would ALSO buy every
    // documentation pull request the full sharded lane, its Postgres and its
    // coverage merge — and from the guard job's side it would look identical to
    // a pass. So the fix is asserted to be the LANE, by holding the
    // classification in place.
    const changes = codeOf(ciJobs.get('changes') ?? '');
    expect(changes, 'the changes job exists').not.toBe('');
    expect(changes).toMatch(/docs\/\*\|design\/\*\|scripts\/plan-seed\/\*\|\*\.md/);
    for (const job of ['test', 'coverage']) {
      expect(codeOf(ciJobs.get(job) ?? ''), job).toContain("needs.changes.outputs.app == 'true'");
    }
  });

  it('is gated through `CI complete` like every other job', () => {
    // A job absent from `needs` is a job whose failure merges. The gate's own
    // test asserts that list is TOTAL, so this is the same claim read from this
    // card's side.
    const gateCode = codeOf(ciJobs.get(GATE_JOB) ?? '');
    expect(gateCode).toMatch(new RegExp(`\\b${GUARD_JOB}\\b`));
  });

  it('every file in the lane EXISTS and is a test', () => {
    // A rename that misses this list would silently shrink the lane, and Vitest
    // exits 0 on an `include` that matches no files.
    for (const spec of DOCS_GUARD_SPECS) {
      expect(ALL_TEST_FILES, `${spec} is listed in the lane but not present`).toContain(spec);
    }
  });

  it('RUNS EVERY spec that reads a `docs/**` file as its subject (criterion 3)', () => {
    // The drift guard, and the reason this file is worth its length. Re-derived
    // from the tree rather than restated, so it cannot agree with a stale list.
    //
    // If this trips with an empty derivation the PREDICATE broke, not the lane,
    // and every assertion around it would pass vacuously — so the population is
    // asserted non-empty first.
    expect(DOCS_READERS.length).toBeGreaterThanOrEqual(5);

    const excluded = new Set(Object.keys(DELIBERATELY_OUT));
    const unaccounted = DOCS_READERS.filter((f) => !UNCONDITIONAL_LANES(f) && !excluded.has(f));

    // The message is the point: a new guard names itself here rather than
    // merging green over a documentation edit weeks later.
    expect(
      unaccounted,
      `These specs read a \`docs/**\` file as their subject and run in NO unconditional lane, ` +
        `so a documentation-only pull request never executes them. Add each to ` +
        `DOCS_GUARD_SPECS in tests/helpers/docsGuardLane.ts, or — if it genuinely does not ` +
        `read a document — to DELIBERATELY_OUT with the reason.`,
    ).toEqual([]);
  });

  it('keeps the lane honest in the OTHER direction too', () => {
    // A member that has stopped reading a document is a spec paying for a
    // second run and telling a reader something false about why it is here.
    // Same tightness the exclusion register is held to below.
    for (const spec of DOCS_GUARD_SPECS) {
      expect(
        DOCS_READERS,
        `${spec} is in the lane but no longer reads a docs/** file — remove it`,
      ).toContain(spec);
    }
  });

  it('every CARRIED_BY_ANOTHER_LANE row is really carried — the claim is CHECKED', () => {
    // A row here says "another unconditional lane already holds this file", and
    // that is a claim about a different config, not a licence. Read against that
    // lane's own membership, so a row whose lane later drops the file fails here
    // instead of quietly exempting a guard nothing runs.
    for (const [file, why] of Object.entries(CARRIED_BY_ANOTHER_LANE)) {
      expect(ALL_TEST_FILES, `${file} is claimed carried but does not exist`).toContain(file);
      expect(DOCS_READERS, `${file} is claimed carried but reads no docs/** file`).toContain(file);
      expect(
        UNCONDITIONAL_LANES(file),
        `${file} is claimed carried by another unconditional lane, and no lane holds it`,
      ).toBe(true);
      expect(
        (DOCS_GUARD_SPECS as readonly string[]).includes(file),
        `${file} is in BOTH this lane and the register that says it is elsewhere`,
      ).toBe(false);
      expect(why.length, `${file}'s reason does not name the lane`).toBeGreaterThan(40);
    }
  });

  it('keeps the exclusion register honest in both directions', () => {
    // Otherwise `DELIBERATELY_OUT` becomes a place to park anything
    // inconvenient, which is how an exception list stops meaning anything. A row
    // that no longer describes a real reader is a mute button nobody would
    // notice, so it fails rather than lingers.
    for (const [file, why] of Object.entries(DELIBERATELY_OUT)) {
      expect(ALL_TEST_FILES, `${file} is declared out but does not exist`).toContain(file);
      expect(
        DOCS_READERS,
        `${file} is declared out but no longer matches — delete the row`,
      ).toContain(file);
      expect(why.length, `${file}'s reason does not say why`).toBeGreaterThan(40);
    }
  });

  it('every form states WHY it is a carrier, and none is a dead letter', () => {
    // The two form lists ARE the derivation. An entry with no reason beside it
    // is an enumeration again, one layer up — and an entry that matches nothing
    // anywhere under `tests/` is a claim nobody has checked, so the second half
    // names the ones that are deliberately forward-looking rather than letting
    // the list rot silently.
    for (const form of [...DOCS_PATH_FORMS, ...FILE_READ_FORMS]) {
      expect(form.why.length, `${form.id} carries no reason`).toBeGreaterThan(60);
    }

    const matchedPaths = new Set(ALL_TEST_FILES.flatMap((f) => docsPathFormsIn(readStripped(f))));
    for (const form of DOCS_PATH_FORMS) {
      expect(
        matchedPaths,
        `${form.id} matches nothing under tests/ — has the shape moved?`,
      ).toContain(form.id);
    }

    const matchedReads = new Set(ALL_TEST_FILES.flatMap((f) => fileReadFormsIn(readStripped(f))));
    for (const form of FILE_READ_FORMS) {
      if (FORWARD_LOOKING_FORMS.includes(form.id)) continue;
      expect(
        matchedReads,
        `${form.id} matches nothing under tests/ — has the shape moved?`,
      ).toContain(form.id);
    }
    // And the exemption list cannot grow to cover a form that HAS gone live:
    // a forward-looking entry that starts matching is no longer forward-looking.
    for (const id of FORWARD_LOOKING_FORMS) {
      expect(FILE_READ_FORMS.map((f) => f.id)).toContain(id);
    }
  });
});

// ── The derivation, DEMONSTRATED (criterion 4) ────────────────────────────────
//
// The assertions above rule on THIS tree, and a predicate that has quietly
// stopped matching passes every one of them. Asserting only the passing
// direction is the failure mode MOTIR-3806 shipped: its tripwire compared a
// version to ITSELF and could not fire at all, and every test it had was green.
//
// So the derivation runs here against a SYNTHETIC tree that does not exist on
// disk — the SAME `docsReadingSpecsIn` the real run uses, over a file list and a
// reader supplied by hand. A control that re-implements the predicate proves the
// control works, not the predicate (the reasoning
// `tests/hosting/abandonedPathGuard.ts` is split out for, and the bar
// `tests/ci-structural-guards-lane.test.ts` sets with its own synthetic cases).
describe('the membership predicate FIRES on a docs-reading spec — demonstrated, not assumed', () => {
  // ⚠️ Written as joined line arrays rather than indented template literals, for
  // the reason `tests/navigation/loading-boundary-guard.test.ts` records: an
  // indented fixture stops being the shape it stands for, and a fixture that has
  // drifted from the real thing proves nothing about the real thing.
  const SYNTHETIC_READERS: Readonly<Record<string, string>> = {
    'docs/ path literal': [
      "import { readFileSync } from 'node:fs';",
      "const LADDER = readFileSync('docs/styles/3d-immersive.md', 'utf8');",
      "it('holds', () => expect(LADDER).toContain('x'));",
    ].join('\n'),
    'docs path segment': [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const DOC = join(ROOT, 'docs', 'decisions', 'permission-inventory.md');",
      "it('holds', () => expect(readFileSync(DOC, 'utf8')).toContain('x'));",
    ].join('\n'),
  };

  it('covers every path form the list declares — the fixture set cannot go stale', () => {
    // If a form is added without a fixture, this fails rather than the
    // demonstration silently shrinking back to the rows somebody remembered.
    expect(Object.keys(SYNTHETIC_READERS).sort()).toEqual(DOCS_PATH_FORMS.map((f) => f.id).sort());
  });

  it.each(DOCS_PATH_FORMS.map((f) => [f.id] as const))(
    'a spec reaching a document through %s is IN the derived population',
    (id) => {
      const spec = 'tests/synthetic/reads-a-doc.test.ts';
      const files = [spec];
      const read = () => SYNTHETIC_READERS[id]!;

      expect(docsPathFormsIn(SYNTHETIC_READERS[id]!)).toContain(id);
      expect(docsReadingSpecsIn(files, read)).toEqual([spec]);
    },
  );

  it('and a spec ABSENT from the lane makes the membership assertion RED (criterion 4)', () => {
    // The whole point, stated as the assertion it actually is: the derivation
    // has to produce a NON-EMPTY unaccounted set for a docs-reading spec that
    // is in neither the lane nor the exclusion register. This is the failing
    // direction the real assertion above cannot exercise on a tree where — by
    // construction, once this card lands — nothing is unaccounted for.
    const rogue = 'tests/synthetic/unlisted-doc-guard.test.ts';
    const files = [rogue];
    const read = () => SYNTHETIC_READERS['docs/ path literal']!;

    const inLane = new Set<string>(DOCS_GUARD_SPECS);
    const excluded = new Set(Object.keys(DELIBERATELY_OUT));
    const unaccounted = docsReadingSpecsIn(files, read).filter(
      (f) => !inLane.has(f) && !excluded.has(f),
    );
    expect(unaccounted).toEqual([rogue]);
  });

  it('does NOT fire on a spec that only MENTIONS a document — the control', () => {
    // Without this the cases above pass on a predicate that matches everything,
    // which would sweep in every spec citing an ADR in an assertion message —
    // `fast-lane-latency-budget` and `proseVsGraph` among them, neither of which
    // a `docs/**` diff can break.
    const spec = 'tests/synthetic/mentions-a-doc.test.ts';
    const files = [spec];
    const read = () =>
      [
        "import { budget } from '@/lib/jobs/latencyBudget';",
        "it('holds', () => {",
        '  expect(budget).toBeDefined(); // See docs/decisions/job-lane-occupancy.md §6.',
        "  expect(String(budget)).not.toContain('docs/decisions/x.md');",
        '});',
      ].join('\n');

    expect(fileReadFormsIn(read())).toEqual([]);
    expect(docsReadingSpecsIn(files, read)).toEqual([]);
  });

  it('does NOT fire on a spec that reads a file somewhere ELSE — the other control', () => {
    // The mirror of the control above: the conjunction needs BOTH halves, so a
    // spec that opens a document tree which is NOT `docs/` is not swept in by
    // the read alone. The legal-content tree is the fixture because it is the
    // other prior instance of this mechanism (MOTIR-3806), and because it is
    // the one such tree the sibling lane guards do not derive membership from —
    // a fixture naming the design tree would make THIS file a member of the
    // design lane by `tests/ci-design-guards-lane.test.ts`'s own predicate,
    // which reads raw source and cannot tell a fixture from a read.
    const spec = 'tests/synthetic/reads-elsewhere.test.ts';
    const files = [spec];
    const read = () =>
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const doc = readFileSync(join(ROOT, 'content', 'legal', 'terms.md'), 'utf8');",
        "it('holds', () => expect(doc).toContain('x'));",
      ].join('\n');

    expect(docsPathFormsIn(read())).toEqual([]);
    expect(docsReadingSpecsIn(files, read)).toEqual([]);
  });

  it('does NOT fire on a NON-spec module, however much it reads', () => {
    // The lane runs SPECS. A scanner module that opens the same document
    // reaches the tree only through its callers, so listing it would put a file
    // in an `include` that Vitest has nothing to collect from.
    const helper = 'tests/helpers/ladderReader.ts';
    const files = [helper];
    const read = () => SYNTHETIC_READERS['docs/ path literal']!;

    expect(docsReadingSpecsIn(files, read)).toEqual([]);
  });

  it('reads the source COMMENT-STRIPPED — a citation is not a read', () => {
    // The half that keeps `tests/jobs/engine-units.test.ts` out after this card
    // split its one document-reading assertion away: the file still names the
    // ADR in the header of the describe block, and still opens files nowhere.
    // Driven through the real `stripComments`, so a change to that helper's
    // timidity fails here rather than silently widening the population.
    const spec = 'tests/synthetic/cites-in-a-comment.test.ts';
    const files = [spec];
    const raw = [
      "import { readFileSync } from 'node:fs';",
      "// The value on each job is taken from 'docs/decisions/job-queue-foundation.md' §11.4.",
      "const fixture = readFileSync('tests/fixtures/jobs.json', 'utf8');",
      "it('holds', () => expect(fixture).toContain('x'));",
    ].join('\n');

    // Un-stripped it WOULD match, which is what makes the stripping load-bearing
    // rather than decorative.
    expect(docsPathFormsIn(raw)).toEqual(['docs/ path literal']);
    expect(docsReadingSpecsIn(files, () => raw)).toEqual([spec]);
    expect(docsReadingSpecsIn(files, () => stripComments(raw))).toEqual([]);
  });
});
