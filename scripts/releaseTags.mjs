/**
 * The LOGIC half of `scripts/push-release-tags.mjs` (MOTIR-3970).
 *
 * WHAT IT ANSWERS: which release tags does `main` now need, which does it
 * already have, and which commit does each new one belong on? It runs on every
 * push to `main` and acts only when a published version moved (MOTIR-7717).
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

/**
 * The commit at which a manifest most recently BECAME `version` (MOTIR-7717).
 *
 * WHY A TAG DOES NOT GO ON `HEAD`. The lane used to tag only in the run whose
 * changesets sync found nothing pending, on the theory that such a run is the
 * one in which the Version Packages pull request merged — so `HEAD` was the
 * release commit. A changeset that reached `main` before that merge broke the
 * theory: the merge run reported `hasChangesets: true`, skipped the tag step,
 * stayed green, and 0.9.0 / 0.4.0 never published. Tagging now runs on EVERY
 * push, and on a push that is not the release commit `HEAD` can already carry
 * source changes whose changeset is still pending. A tag on `HEAD` would ship
 * them under the older version number, so each tag goes on the commit that
 * moved its version instead.
 *
 * @param {object} input
 * @param {string} input.version              the version the ref declares
 * @param {string[]} input.shas               the commits that touched the manifest,
 *                                            NEWEST FIRST, along the ref's first-parent
 *                                            history (`git log --first-parent -- <manifest>`)
 * @param {(sha: string) => unknown} input.versionAt  the manifest's version AT a commit
 * @returns {string | null}  the oldest commit of the newest unbroken run declaring
 *                           `version`, or `null` when no listed commit declares it
 *
 * A commit that touched the manifest without moving the version (a dependency
 * bump) extends the run rather than ending it, which is why this walks to the
 * first DIFFERENT version rather than stopping at the newest commit. It stops
 * there, so the cost is the length of the run, not of the history.
 */
export function introducedAt({ version, shas, versionAt }) {
  let found = null;
  for (const sha of shas) {
    if (versionAt(sha) !== version) break;
    found = sha;
  }
  return found;
}

/**
 * Pin every tag in `plan.create` to the commit that set its version.
 *
 * A tag whose commit cannot be found is moved to `problems` rather than
 * defaulted to `HEAD` — defaulting is exactly the mistake `introducedAt`
 * exists to prevent, and the runner pushes nothing while any problem stands.
 *
 * @param {ReturnType<typeof deriveTags>} plan
 * @param {(entry: {name: string, version: string, tag: string}) => string | null} locate
 */
export function pinTags(plan, locate) {
  const create = [];
  const problems = [...plan.problems];
  for (const entry of plan.create) {
    const commit = locate(entry);
    if (commit) create.push({ ...entry, commit });
    else
      problems.push(
        `${entry.name}: no commit on this ref's first-parent history sets version ${entry.version} — refusing to guess where ${entry.tag} belongs`,
      );
  }
  return { create, skipped: plan.skipped, problems };
}

/** The one-screen report, for the log and the run summary. */
export function formatPlan({ create, skipped, problems }) {
  const lines = [];
  for (const p of problems) lines.push(`REFUSED  ${p}`);
  for (const t of create) {
    const at = t.commit ? ` at ${t.commit.slice(0, 12)}` : '';
    lines.push(`tag      ${t.tag}${at}  (${t.name}) — fires ${t.lane}`);
  }
  for (const t of skipped) lines.push(`skip     ${t.tag}  (${t.name}) — already exists`);
  if (lines.length === 0) lines.push('nothing to do — no published package was found');
  return lines.join('\n');
}
