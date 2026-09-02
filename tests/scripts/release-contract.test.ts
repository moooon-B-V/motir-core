import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISHED_PACKAGES, tagFor } from '../../scripts/releaseTags.mjs';

// MOTIR-3971 — the release contract is written down in four places that no
// compiler relates to each other, and this file is the only thing that does.
//
// ── The four homes ──────────────────────────────────────────────────────────
//
//   A. `.changeset/config.json` + the workspace manifests — WHICH packages get
//      versioned at all.
//   B. `scripts/releaseTags.mjs`'s `PUBLISHED_PACKAGES` — which packages get
//      TAGGED, and with what prefix.
//   C. five workflows' `on.push.tags` globs — which tags actually FIRE a lane.
//   D. `packages/cli/sandbox/smoke/assert-current.mjs`'s `TAG_PREFIX` — what
//      the morning tripwire looks for when it decides the image is stale.
//
// Every one of them is a string. Each file is individually correct and the
// relationship between them lives only in whoever wrote them, so nothing today
// would notice the lane pushing `cli-v0.4.0` while `release-cli.yml` had been
// re-globbed, or a fourth package joining `packages/*` and quietly never
// releasing.
//
// ⚠️ AND THE FAILURE IS SILENT IN THE WORST DIRECTION. A mismatched tag does
// not error — it pushes cleanly and fires nothing, so the release simply does
// not happen and the `sandbox-staleness` tripwire stays red with no explanation
// anywhere. That is the exact condition Story MOTIR-3966 exists to end, which
// is why the gate is a test rather than a paragraph in a header.
//
// ── How it is built, and why that shape ─────────────────────────────────────
//
// Every check is a PURE function of file CONTENT, and each is called twice:
// once with the bytes of the shipped file (so the gate cannot pass against a
// copy that has drifted), and once with a fixture in which one home has been
// moved (so the assertion has been seen to fail rather than merely to pass).
// An assertion that cannot fail is worse than no assertion, and these four are
// all the shape that passes by accident — comparing a string to itself, or
// reading a file that is not the one shipped.
//
// The four shipped-file failures were also produced for real, by editing each
// home on this branch and running this file; the four outputs are quoted in the
// pull request. That is the half a permanently-green fixture cannot buy.
//
// ── No YAML parser, deliberately ────────────────────────────────────────────
//
// The repository has none, and `tests/ci-job-timeouts.test.ts` /
// `tests/ci-complete-gate.test.ts` both hand-parse `.github/workflows/` for the
// one property they need rather than add a dependency to read one file. This
// reads the same directory for a different property and keeps that trade.
//
// ── What this file deliberately does NOT assert ─────────────────────────────
//
// `tests/scripts/release-tags.test.ts` (MOTIR-3970) owns the derivation's own
// behaviour — idempotence, the refusals, the blind read — and `release.yml`'s
// internal wiring, including that the file nowhere reaches for
// `secrets.GITHUB_TOKEN`. None of that is restated here. What is here is only
// the CROSS-FILE seam that card's header hands over by name, plus one relation
// neither file could state alone: that the lane runs the very module whose
// package set and tag prefixes checks (1)–(3) have just verified.
//
// Nor does it reach for the first real release: whether a pushed tag truly
// fires a lane, and whether all three packages then become obtainable
// anonymously, is MOTIR-3967's to observe. No test in this repository can
// perform it.

const ROOT = process.cwd();

const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const CHANGESET_CONFIG = '.changeset/config.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const TRIPWIRE = 'packages/cli/sandbox/smoke/assert-current.mjs';
const DERIVATION = 'scripts/releaseTags.mjs';
const RUNNER = 'scripts/push-release-tags.mjs';
const RELEASE_LANE = '.github/workflows/release.yml';

const read = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8');

/** `runner-v*` releases the self-hosted runner IMAGE, which is not a published npm package. */
const NON_PACKAGE_TAG_GLOBS = ['runner-v*'];

type Pkg = { name: string; dir: string; tagPrefix: string; lane: string };
const PACKAGES = PUBLISHED_PACKAGES as Pkg[];

// ── YAML, only as far as this file needs it ─────────────────────────────────

/**
 * The lines strictly indented under `<indent spaces><key>:`, in `lines`.
 *
 * Blank and whole-line comment lines never TERMINATE a block — a `#` at column
 * zero sits inside `on:` in more than one workflow here — but they are dropped
 * from the result, because nothing downstream wants them. Returns `null` when
 * the key is absent, which every caller treats as a finding rather than as an
 * empty answer: a parser that silently returns nothing is exactly the failure
 * mode this whole file exists to make loud.
 */
function blockUnder(lines: string[], key: string, indent: number): string[] | null {
  const header = new RegExp(`^ {${indent}}${key}:\\s*$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body;
}

/**
 * The `on.push.tags` globs a workflow triggers on, or `[]` when it is not
 * tag-triggered. `null` is not in the range: a workflow with no `on:` block at
 * all is a parse finding, and `tagTriggeredLanes` below reports it as one.
 */
export function tagGlobsOf(workflow: string): string[] | null {
  const lines = workflow.split('\n');
  const on = blockUnder(lines, 'on', 0);
  if (on === null) return null;
  const push = blockUnder(on, 'push', 2);
  if (push === null) return [];
  const tags = blockUnder(push, 'tags', 4);
  if (tags === null) return [];
  return tags
    .map((l) => /^\s*-\s*(.+?)\s*$/.exec(l)?.[1])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/^['"]|['"]$/g, ''));
}

/**
 * GitHub's tag filter pattern, as a predicate. `*` matches any run of
 * characters except `/`, `**` crosses `/`, `?` matches one non-`/` character;
 * everything else is literal.
 */
export function globMatches(glob: string, value: string): boolean {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*|\?/g, (token) => {
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return '[^/]';
  });
  return new RegExp(`^${pattern}$`).test(value);
}

// ── (1) The package set agrees ──────────────────────────────────────────────

type Manifest = { dir: string; json: { name?: unknown; version?: unknown; private?: unknown } };

/**
 * The directories a pnpm workspace glob covers. Only the trailing-`/*` form is
 * supported, and anything else is REFUSED rather than approximated: a glob this
 * cannot resolve would silently shrink the population the gate measures, which
 * is the same silent under-count as reading the wrong file.
 */
export function workspaceDirs(
  workspaceYaml: string,
  listDir: (dir: string) => string[],
): { dirs: string[]; problems: string[] } {
  const block = blockUnder(workspaceYaml.split('\n'), 'packages', 0);
  const problems: string[] = [];
  if (block === null || block.length === 0) {
    return {
      dirs: [],
      problems: [`${WORKSPACE_FILE}: no \`packages:\` globs — nothing to compare ${DERIVATION} to`],
    };
  }
  const dirs: string[] = [];
  for (const line of block) {
    const glob = /^\s*-\s*(.+?)\s*$/.exec(line)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (glob === undefined) continue;
    const trailing = /^([^*?]+)\/\*$/.exec(glob);
    if (!trailing) {
      problems.push(
        `${WORKSPACE_FILE} declares the glob \`${glob}\`, which this gate cannot enumerate — widen \`workspaceDirs\` in this file, or the packages it covers are invisible to ${DERIVATION}`,
      );
      continue;
    }
    for (const entry of listDir(trailing[1]!)) dirs.push(`${trailing[1]}/${entry}`);
  }
  return { dirs: dirs.sort(), problems };
}

/**
 * Which packages Changesets will version, against which packages the derivation
 * will tag. Changesets covers every workspace package that is not
 * `private: true` and is not named in the config's `ignore` list, so those two
 * files plus every manifest have to agree with `PUBLISHED_PACKAGES` — and the
 * message for each disagreement names the two homes that hold it.
 */
export function packageSetProblems(input: {
  rootManifest: { private?: unknown };
  manifests: Manifest[];
  changesetConfig: { ignore?: unknown };
  packages?: Pkg[];
}): string[] {
  const packages = input.packages ?? PACKAGES;
  const problems: string[] = [];

  if (input.rootManifest.private !== true) {
    problems.push(
      `package.json is not \`private: true\`, so Changesets (${CHANGESET_CONFIG}) covers the root app as well as the ${packages.length} packages ${DERIVATION} tags`,
    );
  }

  const ignore = Array.isArray(input.changesetConfig.ignore)
    ? (input.changesetConfig.ignore as unknown[]).map(String)
    : [];

  const publishable = input.manifests
    .filter((m) => m.json.private !== true)
    .map((m) => ({ name: String(m.json.name), dir: m.dir }));

  const tagged = new Map(packages.map((p) => [p.name, p]));

  for (const pkg of publishable) {
    if (!tagged.has(pkg.name)) {
      problems.push(
        `${pkg.dir}/package.json publishes \`${pkg.name}\` but ${DERIVATION}'s PUBLISHED_PACKAGES does not carry it — Changesets would version it and no tag would ever be pushed for it, so it would silently never release`,
      );
    }
    if (ignore.includes(pkg.name)) {
      problems.push(
        `${CHANGESET_CONFIG} ignores \`${pkg.name}\` while ${DERIVATION} still tags it — the tag would be pushed for a version Changesets never bumped`,
      );
    }
  }

  const publishableNames = new Set(publishable.map((p) => p.name));
  for (const pkg of packages) {
    if (!publishableNames.has(pkg.name)) {
      problems.push(
        `${DERIVATION} tags \`${pkg.name}\` but ${pkg.dir}/package.json does not publish it (missing, renamed, or \`private: true\`) — the derivation would refuse on a version it cannot read`,
      );
    }
  }

  return problems;
}

// ── (2) The tag format agrees, end to end ───────────────────────────────────

/**
 * The tag each package's CURRENT version would be released on, run against the
 * real `on.push.tags` glob of that package's own lane. Two hand-written
 * constants comparing equal proves nothing; this runs the shipped derivation
 * against the shipped globs.
 */
export function tagFormatProblems(input: {
  versions: Record<string, string>;
  globsByLane: Record<string, string[] | null>;
  packages?: Pkg[];
}): string[] {
  const packages = input.packages ?? PACKAGES;
  const problems: string[] = [];

  for (const pkg of packages) {
    const version = input.versions[pkg.name];
    if (typeof version !== 'string') {
      problems.push(`${pkg.dir}/package.json declares no version — ${DERIVATION} cannot tag it`);
      continue;
    }
    const tag = tagFor(pkg, version);
    const globs = input.globsByLane[pkg.lane];
    if (globs === undefined || globs === null) {
      problems.push(
        `${DERIVATION} says \`${pkg.name}\` fires ${pkg.lane}, and that workflow could not be read for an \`on.push.tags\` glob`,
      );
      continue;
    }
    if (!globs.some((g) => globMatches(g, tag))) {
      problems.push(
        `${DERIVATION} would push \`${tag}\` for ${pkg.name}, and ${pkg.lane} triggers on ${globs.length === 0 ? 'no tag at all' : globs.map((g) => `\`${g}\``).join(', ')} — the tag would push cleanly and fire nothing`,
      );
    }
  }

  return problems;
}

/**
 * Every tag-triggered lane in the directory, against the prefixes the
 * derivation produces. This is the direction the check above cannot see: a
 * SIXTH lane globbing a tag no published package produces is a release nobody
 * will ever cut, and it is invisible from `PUBLISHED_PACKAGES`.
 */
export function laneCoverageProblems(input: {
  globsByLane: Record<string, string[] | null>;
  packages?: Pkg[];
  allowed?: string[];
}): string[] {
  const packages = input.packages ?? PACKAGES;
  const allowed = input.allowed ?? NON_PACKAGE_TAG_GLOBS;
  const problems: string[] = [];

  for (const [lane, globs] of Object.entries(input.globsByLane)) {
    if (globs === null) {
      problems.push(`${lane}: no \`on:\` block could be parsed — the parser, not the workflow`);
      continue;
    }
    for (const glob of globs) {
      if (allowed.includes(glob)) continue;
      const fired = packages.some((p) => globMatches(glob, tagFor(p, '9.9.9')));
      if (!fired) {
        problems.push(
          `${lane} triggers on \`${glob}\`, which no package in ${DERIVATION}'s PUBLISHED_PACKAGES produces — that lane can never fire from a release`,
        );
      }
    }
  }

  return problems;
}

// ── (3) The tripwire agrees ─────────────────────────────────────────────────

/** `TAG_PREFIX` as the shipped tripwire declares it, or `null` when it moved. */
export function tagPrefixIn(source: string): string | null {
  return /^export const TAG_PREFIX = '([^']*)';$/m.exec(source)?.[1] ?? null;
}

export function tripwireProblems(input: { source: string; packages?: Pkg[] }): string[] {
  const packages = input.packages ?? PACKAGES;
  const cli = packages.find((p) => p.name === '@motir/cli');
  if (!cli) {
    return [`${DERIVATION} no longer carries \`@motir/cli\`, which ${TRIPWIRE} watches`];
  }
  const declared = tagPrefixIn(input.source);
  if (declared === null) {
    return [
      `${TRIPWIRE} no longer declares \`export const TAG_PREFIX = '…'\` — nothing can be compared to ${DERIVATION}'s \`${cli.tagPrefix}\``,
    ];
  }
  return declared === cli.tagPrefix
    ? []
    : [
        `${TRIPWIRE} looks for \`${declared}\` while ${DERIVATION} derives \`${cli.tagPrefix}\` for ${cli.name} — the morning staleness check would read a tag list that never grows`,
      ];
}

// ── (4) The lane runs THIS derivation, under the App token ──────────────────

/**
 * Checks (1)–(3) are worthless if the workflow runs some other module: they
 * would go on agreeing with each other about a derivation nothing executes.
 * This is the relation neither `release-tags.test.ts` nor this file's other
 * checks can state alone — the lane, the runner and the module, as one chain,
 * credentialed by the App installation token that is the only reason a pushed
 * tag fires anything at all.
 */
export function laneRunsDerivationProblems(input: {
  lane: string;
  runner: string;
  packages?: Pkg[];
}): string[] {
  const problems: string[] = [];
  const code = input.lane
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  if (!code.includes(`run: node ${RUNNER}`)) {
    problems.push(
      `${RELEASE_LANE} does not run \`node ${RUNNER}\` — whatever this file has verified about ${DERIVATION} is about a module the lane never executes`,
    );
  }
  if (
    !/^import \{[\s\S]*?\bPUBLISHED_PACKAGES\b[\s\S]*?\} from '\.\/releaseTags\.mjs';$/m.test(
      input.runner,
    )
  ) {
    problems.push(
      `${RUNNER} does not import \`PUBLISHED_PACKAGES\` from ./releaseTags.mjs — the lane would tag a package set this file never checked against ${WORKFLOW_DIR.replace(`${ROOT}/`, '')}`,
    );
  }
  const appToken = code.match(/steps\.app-token\.outputs\.token/g) ?? [];
  if (appToken.length === 0) {
    problems.push(
      `${RELEASE_LANE} mints no App installation token — a tag pushed with the workflow's own credential appears, succeeds, and starts none of the lanes ${DERIVATION} names`,
    );
  }
  if (!/id: app-token\b/.test(code)) {
    problems.push(
      `${RELEASE_LANE} references \`steps.app-token.outputs.token\` with no step declaring \`id: app-token\` — the expression resolves to the empty string and the push is unauthenticated`,
    );
  }

  return problems;
}

// ── The shipped files, read once ────────────────────────────────────────────

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

const globsByLane: Record<string, string[] | null> = Object.fromEntries(
  workflowFiles.map((f) => [`.github/workflows/${f}`, tagGlobsOf(read(`.github/workflows/${f}`))]),
);

const shippedManifests: Manifest[] = workspaceDirs(read(WORKSPACE_FILE), (dir) =>
  readdirSync(join(ROOT, dir)),
).dirs.map((dir) => ({ dir, json: JSON.parse(read(`${dir}/package.json`)) }));

const shippedVersions: Record<string, string> = Object.fromEntries(
  shippedManifests.map((m) => [String(m.json.name), String(m.json.version)]),
);

/** A published set with one member the shipped tree does not have. */
const withFourth: Pkg[] = [
  ...PACKAGES,
  { name: '@motir/runner', dir: 'packages/runner', tagPrefix: 'runner-v', lane: 'nope.yml' },
];

describe('the parser reads the shipped files, and says so when it does not (MOTIR-3971)', () => {
  // Every check below is only as good as this. A regex that silently matches
  // nothing turns four gates into four green tautologies, which is the exact
  // shape the card was written against.
  it('finds an `on.push.tags` glob in each of the five tag-triggered lanes', () => {
    const tagTriggered = Object.entries(globsByLane).filter(([, g]) => g !== null && g.length > 0);
    expect(tagTriggered.map(([lane]) => lane)).toEqual([
      '.github/workflows/release-brand.yml',
      '.github/workflows/release-cli.yml',
      '.github/workflows/release-design-system.yml',
      '.github/workflows/release-runner-image.yml',
      '.github/workflows/release-sandbox.yml',
    ]);
  });

  it('parses every workflow in the directory, so none drops out of the population', () => {
    expect(workflowFiles.length).toBeGreaterThan(5);
    for (const [lane, globs] of Object.entries(globsByLane)) {
      expect(globs, `${lane}: no \`on:\` block parsed`).not.toBeNull();
    }
  });

  it('enumerates the workspace packages the manifests actually declare', () => {
    const resolved = workspaceDirs(read(WORKSPACE_FILE), (dir) => readdirSync(join(ROOT, dir)));
    expect(resolved.problems).toEqual([]);
    expect(resolved.dirs.length).toBeGreaterThan(0);
    expect(shippedManifests.every((m) => typeof m.json.name === 'string')).toBe(true);
  });

  it('matches a GitHub tag glob the way GitHub does', () => {
    expect(globMatches('cli-v*', 'cli-v0.4.0')).toBe(true);
    expect(globMatches('cli-v*', 'design-system-v0.1.3')).toBe(false);
    // `*` stops at a `/`, which is why a lane globbing `cli-v*` is not fired by
    // a ref that merely starts with it.
    expect(globMatches('cli-v*', 'cli-v0.4.0/1')).toBe(false);
    expect(globMatches('cli-v**', 'cli-v0.4.0/1')).toBe(true);
  });
});

describe('(1) the package set agrees — `.changeset/config.json` ⟷ the manifests ⟷ the derivation', () => {
  it('covers exactly the packages the derivation will tag', () => {
    expect(
      packageSetProblems({
        rootManifest: JSON.parse(read('package.json')),
        manifests: shippedManifests,
        changesetConfig: JSON.parse(read(CHANGESET_CONFIG)),
      }),
    ).toEqual([]);
  });

  it('fails when a published package joins the workspace and nothing tags it', () => {
    const problems = packageSetProblems({
      rootManifest: { private: true },
      manifests: [
        ...shippedManifests,
        { dir: 'packages/runner', json: { name: '@motir/runner', version: '1.0.0' } },
      ],
      changesetConfig: { ignore: [] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages/runner/package.json');
    expect(problems[0]).toContain(DERIVATION);
    expect(problems[0]).toContain('silently never release');
  });

  it('fails when the config OMITS a published package by ignoring it', () => {
    // The card's own negative: `.changeset/config.json` stops covering a package
    // the derivation still tags, so the tag is pushed for a version nothing bumped.
    const problems = packageSetProblems({
      rootManifest: { private: true },
      manifests: shippedManifests,
      changesetConfig: { ignore: ['@motir/cli'] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(CHANGESET_CONFIG);
    expect(problems[0]).toContain('@motir/cli');
    expect(problems[0]).toContain(DERIVATION);
  });

  it('fails when the derivation tags a package the manifests do not publish', () => {
    const problems = packageSetProblems({
      rootManifest: { private: true },
      manifests: shippedManifests,
      changesetConfig: { ignore: [] },
      packages: withFourth,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@motir/runner');
    expect(problems[0]).toContain('packages/runner/package.json');
  });

  it('fails when the root app stops being private and Changesets swallows it', () => {
    const problems = packageSetProblems({
      rootManifest: { private: false },
      manifests: shippedManifests,
      changesetConfig: { ignore: [] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(CHANGESET_CONFIG);
    expect(problems[0]).toContain('root app');
  });
});

describe('(2) the tag format agrees — the derivation ⟷ the lanes’ `on.push.tags` globs', () => {
  it('produces, for every published package at its CURRENT version, a tag its own lane triggers on', () => {
    expect(tagFormatProblems({ versions: shippedVersions, globsByLane })).toEqual([]);
  });

  it('leaves no tag-triggered lane that a release can never fire', () => {
    expect(laneCoverageProblems({ globsByLane })).toEqual([]);
  });

  it('fails when a lane is re-globbed away from the tag the derivation pushes', () => {
    // The card's own negative: `release-cli.yml` answers to something else while
    // the lane keeps pushing `cli-v<version>`.
    const problems = tagFormatProblems({
      versions: shippedVersions,
      globsByLane: { ...globsByLane, '.github/workflows/release-cli.yml': ['motir-cli-v*'] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`cli-v${shippedVersions['@motir/cli']}`);
    expect(problems[0]).toContain('release-cli.yml');
    expect(problems[0]).toContain('fire nothing');
  });

  it('fails when a lane drops its tag trigger entirely', () => {
    const problems = tagFormatProblems({
      versions: shippedVersions,
      globsByLane: { ...globsByLane, '.github/workflows/release-brand.yml': [] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no tag at all');
  });

  it('fails when the derivation names a lane that cannot be read', () => {
    const problems = tagFormatProblems({
      versions: shippedVersions,
      globsByLane: { ...globsByLane, '.github/workflows/release-design-system.yml': null },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('release-design-system.yml');
  });

  it('fails when a lane triggers on a tag no published package produces', () => {
    const problems = laneCoverageProblems({
      globsByLane: { ...globsByLane, '.github/workflows/release-agent.yml': ['agent-v*'] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('agent-v*');
    expect(problems[0]).toContain('can never fire from a release');
  });
});

describe('(3) the tripwire agrees — `TAG_PREFIX` ⟷ the prefix the derivation gives `@motir/cli`', () => {
  it('looks for exactly the prefix the lane will push', () => {
    expect(tripwireProblems({ source: read(TRIPWIRE) })).toEqual([]);
  });

  it('reads the prefix out of the shipped file rather than assuming it', () => {
    // A regex that matched nothing would make the check above vacuous.
    expect(tagPrefixIn(read(TRIPWIRE))).toBe('cli-v');
  });

  it('fails when `TAG_PREFIX` disagrees with the derivation', () => {
    const problems = tripwireProblems({
      source: read(TRIPWIRE).replace(
        "export const TAG_PREFIX = 'cli-v';",
        "export const TAG_PREFIX = '@motir/cli@';",
      ),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@motir/cli@');
    expect(problems[0]).toContain('cli-v');
    expect(problems[0]).toContain('never grows');
  });

  it('fails when `TAG_PREFIX` stops being declared at all', () => {
    const problems = tripwireProblems({ source: '// no prefix here\n' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(TRIPWIRE);
  });
});

describe('(4) the lane runs THIS derivation, under the App installation token', () => {
  it('wires `release.yml` → `push-release-tags.mjs` → `releaseTags.mjs`, App-credentialed', () => {
    expect(laneRunsDerivationProblems({ lane: read(RELEASE_LANE), runner: read(RUNNER) })).toEqual(
      [],
    );
  });

  it('fails when the token expression is swapped back to `secrets.GITHUB_TOKEN`', () => {
    // The card's own negative, and the one no runtime test can reach: the push
    // succeeds, the tag appears, and GitHub starts nothing.
    const problems = laneRunsDerivationProblems({
      lane: read(RELEASE_LANE).replaceAll(
        '${{ steps.app-token.outputs.token }}',
        '${{ secrets.GITHUB_TOKEN }}',
      ),
      runner: read(RUNNER),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mints no App installation token');
    expect(problems[0]).toContain('starts none of the lanes');
  });

  it('fails when the `app-token` step is renamed and the expression resolves to nothing', () => {
    const problems = laneRunsDerivationProblems({
      lane: read(RELEASE_LANE).replace('id: app-token', 'id: token'),
      runner: read(RUNNER),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty string');
  });

  it('fails when the lane stops running the runner this file verified', () => {
    const problems = laneRunsDerivationProblems({
      lane: read(RELEASE_LANE).replace(`run: node ${RUNNER}`, 'run: pnpm changeset tag'),
      runner: read(RUNNER),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a module the lane never executes');
  });

  it('fails when the runner stops taking its package set from the checked module', () => {
    const problems = laneRunsDerivationProblems({
      lane: read(RELEASE_LANE),
      runner: read(RUNNER).replace('PUBLISHED_PACKAGES,', ''),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never checked');
  });
});
