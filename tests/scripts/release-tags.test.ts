import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT_BLIND_READ,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  PUBLISHED_PACKAGES,
  classifyTagRead,
  deriveTags,
  formatPlan,
  tagFor,
} from '../../scripts/releaseTags.mjs';

// MOTIR-3970 — the release lane, and the derivation that decides which tags
// `main` now needs.
//
// The lane's whole value is that a tag pushed by the App token FIRES the five
// existing release lanes, and its whole risk is that every way of getting this
// wrong is SILENT. A tag pushed with the workflow's own `GITHUB_TOKEN` appears
// and triggers nothing. A version read as `undefined` produces `cli-vundefined`,
// which pushes cleanly and matches no glob. A re-run over the same `main` that
// re-derives every tag pushes over history a shallow checkout could not see.
// None of those is an error anywhere.
//
// So the two things asserted here are the two a runtime test cannot reach:
//
//   1. The DERIVATION is idempotent and refuses what it cannot read — including
//      the deliberate negatives (a missing version, a version that is not one,
//      an empty tag list), each of which would otherwise be trusted because no
//      red run has contradicted it.
//   2. The LANE is wired to the script it claims to run, on the trigger it
//      claims to run on, with the App token and no publish step. A workflow file
//      is not typechecked, linted or executed by any suite; this is the only
//      place a regression in it can be caught.
//
// ⚠️ WHAT IS DELIBERATELY *NOT* HERE. The cross-file seam — that the tags this
// derivation produces are matched by the five lanes' own `on.push.tags` globs,
// that `TAG_PREFIX` in the staleness script agrees, and that the changeset
// config covers exactly this package set — is MOTIR-3971's, by that card's own
// scope. Asserting it twice would put the story's gate in two places and let one
// of them drift.

const ROOT = process.cwd();

/** The versions on `main` as of this card, read from the real manifests. */
const currentVersions = (): Record<string, string> =>
  Object.fromEntries(
    PUBLISHED_PACKAGES.map((p: { name: string; dir: string }) => [
      p.name,
      JSON.parse(readFileSync(join(ROOT, p.dir, 'package.json'), 'utf8')).version as string,
    ]),
  );

/** A fixed fixture, so a version bump on `main` cannot quietly change a case. */
const VERSIONS = {
  '@motir/cli': '0.4.0',
  '@motir/brand': '0.2.1',
  '@motir/design-system': '0.1.2',
};

/** Enough tags that the read is not classified blind, but none of ours. */
const UNRELATED_TAGS = ['runner-v1.0.0', 'cli-v0.3.0'];

describe('the derivation produces this repository’s tag format (MOTIR-3970)', () => {
  it('names exactly the three published packages', () => {
    // A fourth published package must fail a test rather than silently never
    // release; this is the local half of that (the config/manifest agreement is
    // MOTIR-3971's).
    expect(PUBLISHED_PACKAGES.map((p: { name: string }) => p.name)).toEqual([
      '@motir/cli',
      '@motir/brand',
      '@motir/design-system',
    ]);
  });

  it('derives `<prefix>-v<version>`, not the tool’s `@scope/name@version` default', () => {
    const { create } = deriveTags({ versions: VERSIONS, existingTags: UNRELATED_TAGS });
    expect(create.map((t: { tag: string }) => t.tag)).toEqual([
      'cli-v0.4.0',
      'brand-v0.2.1',
      'design-system-v0.1.2',
    ]);
    // The negative is the point: Changesets' own tagging emits this, and thirty
    // files in this repository trigger on the other one.
    for (const t of create) expect(t.tag).not.toContain('@');
  });

  it('names the lane each tag will fire, so a refusal can say what stopped', () => {
    const { create } = deriveTags({ versions: VERSIONS, existingTags: UNRELATED_TAGS });
    expect(create.map((t: { lane: string }) => t.lane)).toEqual([
      '.github/workflows/release-cli.yml',
      '.github/workflows/release-brand.yml',
      '.github/workflows/release-design-system.yml',
    ]);
  });

  it('derives a usable tag for every version actually on `main` today', () => {
    // Guards the fixture above from drifting into fiction: the same derivation,
    // run against the real manifests, must produce three tags and no problems.
    const { create, problems } = deriveTags({
      versions: currentVersions(),
      existingTags: UNRELATED_TAGS,
    });
    expect(problems).toEqual([]);
    expect(create).toHaveLength(3);
    for (const t of create) expect(t.tag).toMatch(/^[a-z-]+-v\d+\.\d+\.\d+/);
  });
});

describe('the tag step is idempotent — a re-run over the same `main` pushes nothing new', () => {
  it('skips a tag that already exists and creates the other two', () => {
    // The fixture the card asks for by name: one of the three tags is already
    // there. Running the lane twice over one `main` must push exactly one tag
    // per CHANGED package, which means the second run pushes none.
    const { create, skipped, problems } = deriveTags({
      versions: VERSIONS,
      existingTags: [...UNRELATED_TAGS, 'cli-v0.4.0'],
    });
    expect(problems).toEqual([]);
    expect(create.map((t: { tag: string }) => t.tag)).toEqual([
      'brand-v0.2.1',
      'design-system-v0.1.2',
    ]);
    expect(skipped.map((t: { tag: string }) => t.tag)).toEqual(['cli-v0.4.0']);
  });

  it('creates NOTHING when the first run’s output is fed back as existing tags', () => {
    const first = deriveTags({ versions: VERSIONS, existingTags: UNRELATED_TAGS });
    expect(first.create).toHaveLength(3);

    const second = deriveTags({
      versions: VERSIONS,
      existingTags: [...UNRELATED_TAGS, ...first.create.map((t: { tag: string }) => t.tag)],
    });
    expect(second.create).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    expect(second.problems).toEqual([]);
  });

  it('is not fooled by a tag that merely shares a prefix', () => {
    // `cli-v0.3.0` is present in every fixture above. A prefix match rather than
    // an exact one would report `cli-v0.4.0` as already released and never cut
    // it — the silent non-release this whole lane exists to end.
    const { create } = deriveTags({ versions: VERSIONS, existingTags: ['cli-v0.3.0'] });
    expect(create.map((t: { tag: string }) => t.tag)).toContain('cli-v0.4.0');
  });
});

describe('a version it cannot read is REFUSED, never tagged', () => {
  // Each of these would otherwise push a tag that matches no glob, fires no
  // lane, and reports success.
  const cases: Array<[string, unknown]> = [
    ['missing entirely', undefined],
    ['empty', ''],
    ['not a string', 4],
    ['a range rather than a version', '^0.4.0'],
    ['a workspace protocol', 'workspace:*'],
    ['two components', '0.4'],
  ];

  for (const [label, version] of cases) {
    it(`refuses a version that is ${label}`, () => {
      const { create, problems } = deriveTags({
        versions: { ...VERSIONS, '@motir/cli': version },
        existingTags: UNRELATED_TAGS,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('@motir/cli');
      expect(problems[0]).toContain('packages/cli/package.json');
      // The other two are still derived, so the report names what would have
      // shipped alongside the refusal — but the runner exits non-zero on any
      // problem, so nothing is pushed.
      expect(create.map((t: { tag: string }) => t.tag)).toEqual([
        'brand-v0.2.1',
        'design-system-v0.1.2',
      ]);
      expect(formatPlan({ create, skipped: [], problems })).toContain('REFUSED');
    });
  }

  it('accepts a prerelease and a build-metadata version', () => {
    const { create, problems } = deriveTags({
      versions: { ...VERSIONS, '@motir/cli': '1.0.0-rc.1' },
      existingTags: UNRELATED_TAGS,
    });
    expect(problems).toEqual([]);
    expect(create[0]?.tag).toBe('cli-v1.0.0-rc.1');
  });
});

describe('an empty tag list is a BLIND READ, never "nothing has been released"', () => {
  it('refuses when the checkout holds no tags at all', () => {
    // A shallow clone answers `git tag -l` with nothing, which is
    // byte-identical to a repository that has genuinely never released. On the
    // second reading the lane would re-derive every tag and push over history it
    // could not see, so the read is refused instead.
    const read = classifyTagRead([]);
    expect(read.blind).toBe(true);
    expect(read.summary).toContain('fetch-depth: 0');
  });

  it('reads a non-empty tag list as an answer', () => {
    const read = classifyTagRead(UNRELATED_TAGS);
    expect(read.blind).toBe(false);
    expect(read.summary).toContain('2 tag(s)');
  });

  it('gives the blind read its own exit code, distinct from a refusal', () => {
    expect(new Set([EXIT_OK, EXIT_REFUSED, EXIT_USAGE, EXIT_BLIND_READ]).size).toBe(4);
    expect(EXIT_OK).toBe(0);
  });
});

describe('the report names each tag and what it will fire', () => {
  it('says what it will tag, what it will skip and what it refused', () => {
    const plan = deriveTags({
      versions: { ...VERSIONS, '@motir/brand': undefined },
      existingTags: [...UNRELATED_TAGS, 'cli-v0.4.0'],
    });
    const report = formatPlan(plan);
    expect(report).toContain('skip     cli-v0.4.0');
    expect(report).toContain('tag      design-system-v0.1.2');
    expect(report).toContain('release-design-system.yml');
    expect(report).toContain('REFUSED');
  });

  it('composes a tag from a package and a version', () => {
    expect(tagFor({ tagPrefix: 'cli-v' }, '9.9.9')).toBe('cli-v9.9.9');
  });
});

describe('the release lane is wired to the script it claims to run (MOTIR-3970)', () => {
  // The derivation above is worthless if the workflow calls something else, on a
  // trigger that never fires, with a credential that triggers nothing. A
  // workflow file is not typechecked, linted or executed by any suite — the same
  // reason `tests/scripts/assert-deploy-freshness.test.ts` reads its own lane.
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  /** The same text with whole-line comments dropped — a header quotes all of this. */
  const code = workflow
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('runs on every push to `main`', () => {
    expect(code).toMatch(/^on:\n\s+push:\n\s+branches: \[main\]$/m);
  });

  it('mints an App installation token from the two release secrets', () => {
    expect(code).toContain('uses: actions/create-github-app-token@v2');
    expect(code).toContain('id: app-token');
    expect(code).toContain('app-id: ${{ secrets.RELEASE_APP_ID }}');
    expect(code).toContain('private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
  });

  it('uses that token for EVERY git and API operation, and never `secrets.GITHUB_TOKEN`', () => {
    // The whole reason a GitHub App is in this story: a tag pushed with the
    // workflow's own token appears and fires nothing.
    expect(code).not.toContain('secrets.GITHUB_TOKEN');
    expect(code).toContain('token: ${{ steps.app-token.outputs.token }}');
    const appTokenUses = code.match(/steps\.app-token\.outputs\.token/g) ?? [];
    // The checkout, the changesets action, and the tag step.
    expect(appTokenUses.length).toBeGreaterThanOrEqual(3);
  });

  it('grants the automatic token nothing, because nothing here uses it', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
  });

  it('fetches the tags the derivation reads', () => {
    expect(code).toContain('fetch-depth: 0');
  });

  it('versions with `changesets/action` and does NOT let it publish', () => {
    expect(code).toContain('uses: changesets/action@v1');
    expect(code).toContain('version: pnpm changeset:version');
    // The three existing lanes publish, with provenance, under trusted
    // publishing. A `publish:` input here would duplicate them and lose that.
    expect(code).not.toMatch(/^\s+publish:/m);
  });

  it('pushes the tags only once the Version Packages pull request has merged', () => {
    expect(code).toContain("if: steps.changesets.outputs.hasChangesets == 'false'");
    expect(code).toContain('run: node scripts/push-release-tags.mjs');
  });

  it('serialises release runs without cancelling one in flight', () => {
    expect(code).toMatch(
      /^concurrency:\n\s+group: release-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false$/m,
    );
  });

  it('bounds its own runtime', () => {
    // `tests/ci-job-timeouts.test.ts` discovers this file with `readdirSync`, so
    // it is already in that guard's population — asserted here too because a
    // ceiling is the one property of this lane whose absence costs six hours.
    const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(code)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThan(360);
  });

  it('edits no existing workflow — the five tag lanes still trigger on their own globs', () => {
    // The card's boundary, as a check rather than as a promise: if this diff had
    // touched a sibling lane, the design it rests on has been abandoned.
    const lane = (f: string) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
    expect(lane('release-cli.yml')).toContain("- 'cli-v*'");
    expect(lane('release-brand.yml')).toContain("- 'brand-v*'");
    expect(lane('release-design-system.yml')).toContain("- 'design-system-v*'");
    expect(lane('release-sandbox.yml')).toContain("- 'cli-v*'");
    expect(lane('release-runner-image.yml')).toContain("- 'runner-v*'");
  });
});
