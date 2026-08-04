#!/usr/bin/env node
//
// IS THE PUBLISHED IMAGE THE ONE THE DOCS DESCRIBE? (MOTIR-2131)
//
// `assert-public.mjs` next door asks whether a stranger can PULL the image.
// This asks the next question down: having pulled it, are they holding what
// `main` says they are holding? On 2026-08-04 they were not. `cli-v0.1.0` was
// eleven commits behind, so the first thing the image printed — a credential
// banner naming one tier and telling you to log in on the HOST — contradicted
// the sentence in `docs/cli.md` that sent the reader to it. `motir login` was
// not in the image at all. Every internal signal stayed green throughout: CI
// passed, the docs were accurate about `main`, and `motir auto` in a normal
// console worked, because none of those consume the artifact.
//
// ── Why drift is not, by itself, the defect ────────────────────────────────
//
// `release-sandbox.yml` deliberately has NO push-to-main trigger: a `:latest`
// that moves on every merge is not a sandbox anyone can reproduce a run in.
// Drift between releases is therefore EXPECTED, by design, and a check that
// went red on the first merge after a release would be muted inside a week —
// and a muted tripwire is worse than none, because it reads as coverage.
//
// So drift is REPORTED always and FAILS only once it has SAT: the age of the
// OLDEST unreleased commit, against a grace window. "How long have users been
// getting something other than what we document?" is the question that has an
// unacceptable answer; "is there anything unreleased right now?" does not.
//
// ── Why the version check alone would have missed this ─────────────────────
//
// The obvious guard — does `packages/cli/package.json` match the newest
// `cli-v*` tag? — is necessary and would NOT have caught MOTIR-2131: the
// version sat at `0.1.0`, matching `cli-v0.1.0` perfectly, for the entire five
// days the images were stale. Nobody forgot to tag a bump; nobody bumped. That
// arm catches a different failure (a release prepared and never cut) and both
// are checked here, separately, because they need different fixes.
//
// ── Three-valued, like its sibling ─────────────────────────────────────────
//
// 0 current (or drifting inside the window) · 1 a definite staleness defect ·
// 2 could not tell. The third code is not decoration: a repository cloned
// without tags answers "no release exists" to a shallow `git tag`, and that is
// indistinguishable from a project that has genuinely never released unless
// the caller is told which one it is looking at. `assert-public.mjs` makes the
// same split for the same reason — collapsing "could not measure" into a
// verdict is how a broken probe starts reporting reassuring answers.
//
// Usage:
//   assert-current.mjs [--repo <dir>] [--max-age-days <n>] [--paths <a,b>]
//                      [--ref HEAD] [--json]
//
// Runs anywhere with git and a checkout that has tags — no Docker, no network,
// no registry credential. In CI it wants `fetch-depth: 0`.

/** The release tag prefix. `cli-v<x.y.z>` — package-scoped, because a monorepo
 *  cannot use a bare `v*` (it would fire for the app too). */
export const TAG_PREFIX = 'cli-v';

/**
 * How long unreleased work may sit before it is a defect rather than a state.
 *
 * THREE DAYS, and the number is derived rather than round. The first draft of
 * this script used a week, was run against the tree that produced MOTIR-2131 —
 * eleven commits, oldest five days old — and returned exit 0. A human had
 * already found the defect by then, by pulling the image and reading what it
 * printed. A tripwire that fires on day eight for something a person hits on
 * day five is not a tripwire; it is a record kept after the fact.
 *
 * So the window is set below the only observed detection time there is. It
 * still leaves a couple of days for a burst of merges to settle before anyone
 * is asked to cut anything, which is the muting risk it has to stay clear of,
 * and `--max-age-days` moves it for a caller who knows better.
 */
export const DEFAULT_MAX_DRIFT_DAYS = 3;

/** What, when it changes, changes the ARTIFACT. `packages/cli` covers the CLI
 *  source, the Dockerfile, the entrypoint and the per-agent install arms —
 *  everything the image is built from that is ours. `@motir/cli` has no
 *  workspace dependencies (only `commander` and the MCP SDK), so nothing
 *  outside this path can change the binary's own behaviour.
 *
 *  The lockfile is deliberately NOT watched by default. A `commander` bump does
 *  change the image, but it is not a change to what Motir documents, and
 *  watching it would mark almost every pull request as drift — which is the
 *  muting failure mode above, arrived at from the other direction. Pass
 *  `--paths` to widen it for a release that cares. */
export const DEFAULT_WATCH_PATHS = ['packages/cli'];

const MS_PER_DAY = 86_400_000;

/**
 * Parse `x.y.z` (with an optional `-prerelease`) into comparable pieces.
 * Returns null for anything that is not a version, which is how a stray tag
 * like `cli-vnext` gets ignored rather than sorted somewhere arbitrary.
 */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: match[0],
  };
}

/**
 * Order two parsed versions. Numeric fields first; then a prerelease sorts
 * BELOW its own release (`0.2.0-rc.1` < `0.2.0`), which is the only prerelease
 * rule this needs — the tags here are plain releases and the rule exists so an
 * `-rc` tag cannot outrank the real one it precedes.
 */
export function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Turn raw `git tag --list` output into release tags, newest FIRST.
 *
 * Sorted by version rather than by creation date on purpose: a patch cut from
 * an older line lands after a newer minor in time but is not the newest
 * release, and "newest" here means "the version the moving `:claude` tag points
 * at", which is a version question.
 */
export function parseReleaseTags(tags) {
  return (tags ?? [])
    .map((line) => String(line).trim())
    .filter((line) => line.startsWith(TAG_PREFIX))
    .map((tag) => ({ tag, version: parseVersion(tag.slice(TAG_PREFIX.length)) }))
    .filter((entry) => entry.version !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The whole judgement, as a pure function of measurements.
 *
 * `commits` are those touching the watched paths between the newest release tag
 * and the ref under test, each `{ sha, date, subject }` — the caller collects
 * them; this decides what they mean. `now` is injected rather than read so the
 * tests can pin it: a test that compares a fixture date against wall-clock time
 * passes until it silently does not.
 */
export function assessRelease({
  packageVersion,
  tags,
  commits = [],
  now,
  maxDriftDays = DEFAULT_MAX_DRIFT_DAYS,
} = {}) {
  const releases = parseReleaseTags(tags);
  const declared = parseVersion(packageVersion);

  if (!declared) {
    return {
      verdict: 'unreadable',
      exitCode: 2,
      summary: `packages/cli/package.json declares no usable version (got ${JSON.stringify(packageVersion ?? null)}) — nothing to compare a tag against`,
    };
  }
  if (releases.length === 0) {
    // Not a staleness verdict: with no release there is no published artifact
    // for `main` to have drifted from. Reported as "could not tell" so a
    // tagless clone (a shallow CI checkout, a fresh fork) cannot be mistaken
    // for a repository that is behind.
    return {
      verdict: 'never-released',
      exitCode: 2,
      declaredVersion: declared.raw,
      summary: `no ${TAG_PREFIX}* tag exists — either nothing has been released, or this checkout has no tags (CI needs fetch-depth: 0)`,
    };
  }

  const latest = releases[0];
  const drift = summarizeDrift(commits, now);
  const base = {
    declaredVersion: declared.raw,
    latestTag: latest.tag,
    latestVersion: latest.version.raw,
    ...drift,
  };
  const order = compareVersions(declared, latest.version);

  if (order > 0) {
    // The bump merged and the tag was never pushed. A real and separate
    // failure: the release is half-cut, and the next person to look sees a
    // version number that no image anywhere carries.
    return {
      ...base,
      verdict: 'untagged-bump',
      exitCode: 1,
      summary: `packages/cli is at ${declared.raw} but the newest tag is ${latest.tag} — the version bump merged and the tag was never pushed. Cut it: git tag ${TAG_PREFIX}${declared.raw} <the merge commit> && git push origin ${TAG_PREFIX}${declared.raw}`,
    };
  }
  if (order < 0) {
    // Only reachable by a revert or a hand-edit, and worth its own arm: the
    // remedy is the opposite one, so folding it into "untagged bump" would send
    // someone to push a tag for a version that has gone backwards.
    return {
      ...base,
      verdict: 'version-behind-tag',
      exitCode: 1,
      summary: `packages/cli declares ${declared.raw} but ${latest.tag} is already published — the working version went BACKWARDS past a release. Do not re-tag; reconcile package.json first`,
    };
  }
  if (drift.commitCount === 0) {
    return {
      ...base,
      verdict: 'current',
      exitCode: 0,
      summary: `${latest.tag} is current — nothing has touched the watched paths since it was cut`,
    };
  }
  if (drift.oldestAgeDays !== null && drift.oldestAgeDays > maxDriftDays) {
    return {
      ...base,
      verdict: 'stale',
      exitCode: 1,
      maxDriftDays,
      summary: `the published image is ${drift.commitCount} commit${drift.commitCount === 1 ? '' : 's'} behind and the oldest has been unreleased for ${drift.oldestAgeDays} days (limit ${maxDriftDays}) — everyone pulling ghcr.io/moooon-b-v/motir-sandbox is getting ${latest.version.raw}, not what main documents. Cut a release: bump packages/cli/package.json, merge, then tag the merge commit`,
    };
  }
  return {
    ...base,
    verdict: 'drifting',
    exitCode: 0,
    maxDriftDays,
    summary: `${drift.commitCount} unreleased commit${drift.commitCount === 1 ? '' : 's'} since ${latest.tag}, oldest ${drift.oldestAgeDays ?? '?'} day${drift.oldestAgeDays === 1 ? '' : 's'} old — within the ${maxDriftDays}-day window, so not yet a defect`,
  };
}

/**
 * Reduce the commit list to the two numbers the verdict turns on: how many, and
 * how long the oldest has waited. Kept separate so the counting is testable
 * against an empty list, an undated commit, and a list whose git order is not
 * its date order.
 */
function summarizeDrift(commits, now) {
  const entries = (commits ?? []).filter(Boolean);
  const times = entries
    .map((commit) => Date.parse(commit?.date ?? ''))
    .filter((time) => Number.isFinite(time));
  if (entries.length === 0) {
    return { commitCount: 0, commits: [], oldestAgeDays: null, oldestCommitDate: null };
  }
  const oldest = times.length > 0 ? Math.min(...times) : null;
  const reference = (now instanceof Date ? now : new Date()).getTime();
  return {
    commitCount: entries.length,
    commits: entries,
    // Floored: "6.9 days old" against a 7-day window is 6 days of grace left,
    // not a rounding argument about whether it has expired.
    oldestAgeDays: oldest === null ? null : Math.floor((reference - oldest) / MS_PER_DAY),
    oldestCommitDate: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/**
 * Gather the measurements from a checkout through the injected git seam, then
 * assess them. Every git failure becomes a `could not tell`, never a staleness
 * verdict — the whole point of the third exit code.
 */
export async function collectAndAssess(io, options = {}) {
  const paths = options.paths ?? DEFAULT_WATCH_PATHS;
  const ref = options.ref ?? 'HEAD';
  let packageVersion;
  let tags;
  try {
    packageVersion = await io.readVersion();
    tags = await io.listTags(`${TAG_PREFIX}*`);
  } catch (err) {
    return {
      verdict: 'unreadable',
      exitCode: 2,
      summary: `could not read the repository: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const releases = parseReleaseTags(tags);
  let commits = [];
  if (releases.length > 0) {
    try {
      commits = await io.commitsBetween(releases[0].tag, ref, paths);
    } catch (err) {
      // The tag exists but the range could not be walked — a shallow clone is
      // the usual cause. Refuse to answer rather than report "0 commits", which
      // would read as `current` and is the single most dangerous wrong answer
      // this script could give.
      return {
        verdict: 'unreadable',
        exitCode: 2,
        latestTag: releases[0].tag,
        summary: `${releases[0].tag} exists but the range ${releases[0].tag}..${ref} could not be walked (${err instanceof Error ? err.message : String(err)}) — a shallow clone reports no commits, which would look exactly like "up to date"`,
      };
    }
  }

  return {
    ...assessRelease({
      packageVersion,
      tags,
      commits,
      now: io.now ? io.now() : new Date(),
      maxDriftDays: options.maxDriftDays,
    }),
    watchedPaths: paths,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

export async function main(argv, io) {
  const maxAge = argOf(argv, 'max-age-days');
  const pathsArg = argOf(argv, 'paths');
  const result = await collectAndAssess(io, {
    ref: argOf(argv, 'ref'),
    paths: pathsArg ? pathsArg.split(',').filter(Boolean) : undefined,
    maxDriftDays: maxAge === undefined ? undefined : Number(maxAge),
  });

  if (argv.includes('--json')) {
    io.log(JSON.stringify(result, null, 2));
  } else {
    io.log(`verdict  ${result.verdict.toUpperCase()}`);
    if (result.latestTag) io.log(`latest   ${result.latestTag}`);
    if (result.declaredVersion) io.log(`declared ${result.declaredVersion}`);
    if (result.commitCount) {
      io.log(`drift    ${result.commitCount} commit(s) since ${result.latestTag}`);
      // The commits themselves, not just the count — the reader's next question
      // is always "behind by WHAT", and answering it here is what turns a red
      // check into a release decision instead of an investigation.
      for (const commit of (result.commits ?? []).slice(0, 20)) {
        io.log(
          `         ${String(commit.sha ?? '').slice(0, 8)} ${commit.date ?? ''} ${commit.subject ?? ''}`,
        );
      }
      if ((result.commits ?? []).length > 20) {
        io.log(`         … and ${result.commits.length - 20} more`);
      }
    }
    io.log(result.summary);
  }

  if (result.exitCode === 1) io.error(`::error::${result.summary}`);
  else if (result.exitCode === 2) io.error(`::warning::${result.summary}`);
  return result.exitCode;
}

// Only when executed, never when imported by the unit tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile } = await import('node:fs/promises');
  const run = promisify(execFile);
  const repo = argOf(process.argv.slice(2), 'repo', process.cwd());
  const git = async (args) => (await run('git', ['-C', repo, ...args], { maxBuffer: 32e6 })).stdout;

  const io = {
    readVersion: async () =>
      JSON.parse(await readFile(`${repo}/packages/cli/package.json`, 'utf8')).version,
    listTags: async (pattern) =>
      (await git(['tag', '--list', pattern])).split('\n').filter(Boolean),
    commitsBetween: async (tag, ref, paths) =>
      (await git(['log', '--format=%H%x09%aI%x09%s', `${tag}..${ref}`, '--', ...paths]))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, date, ...subject] = line.split('\t');
          return { sha, date, subject: subject.join('\t') };
        }),
    now: () => new Date(),
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => console.error(line),
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
