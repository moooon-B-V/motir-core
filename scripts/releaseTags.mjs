/**
 * The LOGIC half of `scripts/push-release-tags.mjs` (MOTIR-3970).
 *
 * WHAT IT ANSWERS: after a **Version Packages** pull request has merged, which
 * release tags does `main` now need, and which does it already have?
 *
 * ⚠️ THE TAG FORMAT IS DELIBERATELY *NOT* THE TOOL'S DEFAULT. Changesets' own
 * tagging emits `@motir/cli@0.4.0`. This repository releases on
 * `cli-v0.4.0` / `brand-v0.2.1` / `design-system-v0.1.2`, and that is what the
 * five existing tag-triggered lanes' `on.push.tags` globs match. Measured at
 * `eef7cc76b` with
 *
 *   git grep -lE '(cli|brand|design-system|runner)-v([0-9]+\.[0-9]+|\*)' \
 *     origin/main -- . ':!*CHANGELOG.md'
 *
 * → 30 files / 117 occurrences: nine workflows, the staleness tripwire and its
 * `TAG_PREFIX`, four sandbox smoke scripts, five guard tests and the docs.
 * `packages/cli/sandbox/smoke/assert-current.mjs` records why the format exists
 * at all — *"package-scoped, because a monorepo cannot use a bare `v*`"*.
 * Adopting the tool's default would mean editing all thirty files to gain
 * nothing a reader can see. Matching a tool by default is right; this is the
 * case where a counted cost buys the exception.
 *
 * ⚠️ AND THE LANE DOES NOT PUBLISH. `release-cli.yml`, `release-brand.yml` and
 * `release-design-system.yml` already build, test, pack and
 * `npm publish --access public --provenance` under OIDC trusted publishing.
 * Pushing the tag is what makes them fire; letting `changesets/action` publish
 * instead would duplicate them while losing their pre-publish assertions and
 * their provenance attestation, and would leave two publish paths for one
 * package. So this module derives tags and nothing else.
 *
 * ⚠️ EVERY BRANCH HERE IS PURE — it takes what was read and returns a verdict —
 * so the runner is a thin caller that shells out to `git`, prints, and sets an
 * exit code, exactly as `scripts/deployFreshness.mjs` is to
 * `scripts/assert-deploy-freshness.mjs`. That split is what lets the fixture
 * where one of three tags already exists be a unit test rather than a release.
 *
 * ⚠️ "COULD NOT READ THE TAGS" IS A THIRD STATE, NEVER AN EMPTY ONE. A shallow
 * checkout answers `git tag -l` with nothing, which is byte-identical to "this
 * repository has never released" — and on that reading the lane would derive
 * every tag afresh and push over history it could not see. The read is REFUSED
 * instead (`EXIT_BLIND_READ`), the same split `assert-current.mjs` makes for the
 * same reason: a probe whose failure is indistinguishable from its answer is not
 * a probe.
 */

/** Exit codes, shared with the runner so the workflow and the tests agree. */
export const EXIT_OK = 0;
/** A manifest was unreadable, missing a version, or carried one that is not a version. */
export const EXIT_REFUSED = 1;
/** Usage — an argument this script does not take. */
export const EXIT_USAGE = 2;
/** The tag list could not be established (a shallow checkout: CI needs `fetch-depth: 0`). */
export const EXIT_BLIND_READ = 3;

/**
 * The packages this repository PUBLISHES, and the tag prefix each one's release
 * lane triggers on. Exactly the three non-private workspace packages —
 * `pnpm-workspace.yaml` is `packages/*` and the root app is `private: true`, so
 * this list and the set Changesets covers are the same set by construction.
 *
 * `lane` is carried so a failure can name the workflow that will not fire, and
 * so the story's gate card (MOTIR-3971) can run this real derivation against
 * those real globs rather than comparing two hand-written constants.
 */
export const PUBLISHED_PACKAGES = [
  {
    name: '@motir/cli',
    dir: 'packages/cli',
    tagPrefix: 'cli-v',
    lane: '.github/workflows/release-cli.yml',
  },
  {
    name: '@motir/brand',
    dir: 'packages/brand',
    tagPrefix: 'brand-v',
    lane: '.github/workflows/release-brand.yml',
  },
  {
    name: '@motir/design-system',
    dir: 'packages/design-system',
    tagPrefix: 'design-system-v',
    lane: '.github/workflows/release-design-system.yml',
  },
];

/**
 * Semver, as a tag is allowed to carry it. Deliberately strict: a version that
 * is `undefined`, `''`, `'0.4'` or `'workspace:*'` must REFUSE rather than
 * produce `cli-vundefined`, which would push cleanly and fire nothing.
 */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The tag a given package at a given version releases on. */
export const tagFor = (pkg, version) => `${pkg.tagPrefix}${version}`;

/**
 * Was the tag list actually READ, or is this a checkout that has none?
 *
 * Takes EVERY tag in the repository, not only the ones matching a prefix: a
 * repository that has released three packages cannot have zero tags, so zero is
 * evidence about the CHECKOUT rather than about the releases.
 */
export const classifyTagRead = (allTags) =>
  allTags.length === 0
    ? {
        blind: true,
        summary:
          'no tag exists in this checkout — either nothing has ever been released, or the tags were not fetched (CI needs `fetch-depth: 0`). Refusing to derive tags from a list that may be empty for the wrong reason.',
      }
    : { blind: false, summary: `${allTags.length} tag(s) read from the checkout` };

/**
 * Which tags `main` needs, and which it already has.
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.versions  package name → the `version` its manifest declares
 * @param {string[]} input.existingTags             every tag the checkout holds
 * @param {typeof PUBLISHED_PACKAGES} [input.packages]
 * @returns {{ create: Array<{name: string, version: string, tag: string, lane: string}>,
 *             skipped: Array<{name: string, version: string, tag: string}>,
 *             problems: string[] }}
 *
 * IDEMPOTENT BY CONSTRUCTION: a tag already in `existingTags` lands in
 * `skipped`, so feeding one run's `create` back in as existing tags yields an
 * empty `create`. That is the property the lane's re-run safety rests on, and it
 * is asserted in `tests/scripts/release-tags.test.ts` rather than argued for.
 */
export function deriveTags({ versions, existingTags, packages = PUBLISHED_PACKAGES }) {
  const have = new Set(existingTags);
  const create = [];
  const skipped = [];
  const problems = [];

  for (const pkg of packages) {
    const version = versions[pkg.name];
    if (typeof version !== 'string' || !VERSION.test(version)) {
      // Loud, not skipped. A package whose version cannot be read is a package
      // that will silently never release — the exact failure this lane exists
      // to end — and `cli-vundefined` would push and satisfy nothing.
      problems.push(
        `${pkg.name}: ${pkg.dir}/package.json declares no usable \`version\` (got ${JSON.stringify(version)})`,
      );
      continue;
    }
    const tag = tagFor(pkg, version);
    (have.has(tag) ? skipped : create).push({ name: pkg.name, version, tag, lane: pkg.lane });
  }

  return { create, skipped, problems };
}

/** The one-screen report, for the log and the run summary. */
export function formatPlan({ create, skipped, problems }) {
  const lines = [];
  for (const p of problems) lines.push(`REFUSED  ${p}`);
  for (const t of create) lines.push(`tag      ${t.tag}  (${t.name}) — fires ${t.lane}`);
  for (const t of skipped) lines.push(`skip     ${t.tag}  (${t.name}) — already exists`);
  if (lines.length === 0) lines.push('nothing to do — no published package was found');
  return lines.join('\n');
}
