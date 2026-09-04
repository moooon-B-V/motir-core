import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE WORKSPACE PACKAGES ARE BUILT IN EVERY LANE THAT LOADS ONE
// (Story MOTIR-4292 · MOTIR-4299, filed from motir-core#2585's CI).
//
// ── The defect this pins, which cost two red runs ───────────────────────────
// `packages/*/dist` is GIT-IGNORED. Nothing in a checkout produces it; the ROOT
// `postinstall` does, as a side effect of `pnpm install`. And every lane's
// install step carries `if: …cache-hit != 'true'`, so on a warm runner the
// install — and with it the only thing that builds the packages — does not run.
// The lane then resolves `@motir/…` against a directory that is not there.
//
// It fails DIFFERENTLY in each lane, and none of the three failures names the
// cause:
//
//   * `typecheck` reported `TS2305: … has no exported member 'Button'` across
//     app files the diff never touched — the `components/ui/*` shims re-export
//     `@motir/design-system`, so a missing `dist` reads as a broken tree;
//   * `e2e` threw `No "exports" main defined` / `Cannot find module` at IMPORT
//     time for every spec in the leg, before one test ran, because Playwright
//     loads `tests/e2e/_helpers/job-registry.ts` in its own process and that
//     pulls `lib/jobs/registry` → `lib/orchestrator` → `@motir/orchestrator`;
//   * `build` and `test` would fail the same way, one on `next build` and one
//     on the specs that import the package directly.
//
// ── Why a DECLARED list of lanes ────────────────────────────────────────────
// The honest invariant is "a lane that RESOLVES a workspace package at run time
// must build the packages unconditionally", and no cheap property of a workflow
// file says which lanes those are. So the four below are named WITH the reason
// each one resolves — and the ones deliberately absent (`lint`,
// `structural-guards`, `design-guards`, `coverage`) are absent because they read
// source text or merge reports and never load a package's artefact. Adding the
// step to those would be cargo cult, paid on every run.
//
// The package lanes (`design-system`, `cli`, `orchestrator`) are absent for the
// opposite reason: each BUILDS its own package as an explicit step, and none of
// them caches node_modules at all.

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml');
const E2E_ACTION = join(ROOT, '.github/actions/e2e-setup/action.yml');

/** `pnpm … --filter './packages/*' build`, however it is spelled. */
const BUILD_STEP = /pnpm .*--filter\s+'?\.\/packages\/\*'?\s+build/;

interface Lane {
  /** The ci.yml job id, or `null` for the composite action. */
  job: string | null;
  /** What in this lane resolves a package at run time. */
  why: string;
}

const LANES: readonly Lane[] = [
  { job: 'typecheck', why: '`tsc -b` reads each package’s emitted `dist/*.d.ts`' },
  { job: 'build', why: '`next build` bundles every package the app imports' },
  { job: 'test', why: 'specs import `@motir/orchestrator` through its barrel' },
  {
    job: null,
    why: 'Playwright’s own process requires `@motir/orchestrator` via `lib/orchestrator`',
  },
];

/** Comment lines are prose, and prose mentioning a command is not the command. */
const codeOf = (yaml: string): string =>
  yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The body of one top-level job in ci.yml, comments stripped. */
function jobBody(id: string): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^ {2}${id}:\\s*$`).test(l));
  expect(at, `no \`${id}\` job in ci.yml`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    body.push(line);
  }
  return codeOf(body.join('\n'));
}

const laneBody = (lane: Lane): string =>
  lane.job === null ? codeOf(readFileSync(E2E_ACTION, 'utf8')) : jobBody(lane.job);

const laneName = (lane: Lane): string => lane.job ?? '.github/actions/e2e-setup';

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('every lane that loads a workspace package builds one first', () => {
  it('the root `postinstall` is what builds them — the mechanism whose SKIP is the hazard', () => {
    // The step in each lane is a DUPLICATE of this, not a replacement: a fresh
    // runner still gets its packages from the install. Pinning it here is what
    // keeps the comments in those lanes true.
    expect(packageJson.scripts.postinstall).toMatch(/\bbuild\b/);
    expect(packageJson.scripts.postinstall).toContain('@motir/design-system');
    expect(packageJson.scripts.postinstall).toContain('@motir/orchestrator');
  });

  it.each(LANES)('$job builds `packages/*`, unconditionally', (lane) => {
    const body = laneBody(lane);
    expect(body, `${laneName(lane)} must build \`packages/*\` — ${lane.why}`).toMatch(BUILD_STEP);

    // …and with NO `if:`. A conditional build is the same defect one step over:
    // it would be skipped in exactly the case that needs it.
    const lines = body.split('\n');
    const at = lines.findIndex((l) => BUILD_STEP.test(l));
    expect(at).toBeGreaterThan(-1);
    const after = lines.slice(at + 1, at + 3).join('\n');
    // `shell: bash` is the composite action's required boilerplate, not a gate.
    expect(after, `${laneName(lane)}'s package build must carry no \`if:\``).not.toMatch(
      /^\s*if:/m,
    );
  });

  it.each(LANES.filter((l) => l.job !== null))(
    '$job really does skip its install on a cache hit — the hazard is present',
    (lane) => {
      // The half that makes the assertion above load-bearing rather than
      // decorative. If a lane ever installs unconditionally, its packages are
      // built by the install and this entry should be argued about, not kept.
      const body = laneBody(lane);
      expect(body).toMatch(/pnpm install --frozen-lockfile/);
      expect(body, `${laneName(lane)} no longer skips its install`).toMatch(
        /if:\s*steps\.cache-node-modules-[a-z-]+\.outputs\.cache-hit != 'true'/,
      );
    },
  );

  it('BITES on a lane that installs conditionally and never builds (mutation check)', () => {
    // ⚠️ A guard nobody has watched fail may be matching nothing. This is the
    // exact shape every lane had before motir-core#2585 — an install behind a
    // cache-hit gate, and no build.
    const regressed = codeOf(
      [
        '    steps:',
        '      - run: pnpm install --frozen-lockfile',
        "        if: steps.cache-node-modules-x.outputs.cache-hit != 'true'",
        '      - run: pnpm typecheck',
      ].join('\n'),
    );
    expect(BUILD_STEP.test(regressed)).toBe(false);

    // …and on the subtler regression: the step is there, but gated.
    const gated = codeOf(
      [
        '    steps:',
        "      - run: pnpm -r --filter './packages/*' build",
        "        if: steps.cache-node-modules-x.outputs.cache-hit != 'true'",
      ].join('\n'),
    );
    const lines = gated.split('\n');
    const at = lines.findIndex((l) => BUILD_STEP.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3).join('\n')).toMatch(/^\s*if:/m);
  });

  it('does not demand the step of a lane that never loads a package', () => {
    // The innocence case. `lint` reads source with ESLint and `design-guards`
    // reads `design/**`; neither resolves a package artefact, and a build there
    // is runner time spent on nothing. The census is a claim about WHICH lanes
    // load a package — it stops meaning that the moment it covers all of them.
    const named = LANES.map((l) => l.job);
    for (const absent of ['lint', 'structural-guards', 'design-guards', 'coverage']) {
      expect(named, `${absent} does not load a package`).not.toContain(absent);
    }
    expect(new Set(named).size).toBe(LANES.length);
  });
});
