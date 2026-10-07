#!/usr/bin/env node
/**
 * Push the release tags for whatever versions are now on `main` (MOTIR-3970).
 *
 * Run it from a FULL-DEPTH checkout, on any commit of `main` — it only acts
 * when a published version has moved (MOTIR-7717):
 *
 *   node scripts/push-release-tags.mjs
 *   node scripts/push-release-tags.mjs --dry-run
 *   node scripts/push-release-tags.mjs --ref <commit> [--dry-run]
 *
 * ⚠️ THE VERSIONS ARE READ FROM `--ref` (default `HEAD`), NEVER FROM THE WORKING
 * TREE, AND EACH TAG GOES ON THE COMMIT THAT SET ITS VERSION. In the release
 * lane this runs after `changesets/action`, which — whenever changesets are
 * pending — checks out `changeset-release/main` and writes the NEXT versions
 * into the manifests. A working-tree read there would tag versions that have
 * not merged. The lane passes `--ref "$GITHUB_SHA"`, the commit that was
 * pushed to `main`; `introducedAt` in `releaseTags.mjs` then finds, along that
 * ref's first-parent history, the commit each version arrived in.
 *
 * WHAT IT DOES, and why the decision is not in this file: see
 * `scripts/releaseTags.mjs`, which holds the whole derivation and is the file
 * with the tests. This runner does four things only — read the three manifests,
 * read the tag list, create and push what is missing, print — so that the part
 * with a decision in it is callable without a git repository, a network or a
 * `process.exit`.
 *
 * ⚠️ IT DOES NOT `process.exit()`. It sets `process.exitCode` and returns, so
 * Node drains its pending I/O first. MOTIR-3989 is why that sentence is here:
 * the sibling release lane wrote its `$GITHUB_OUTPUT` with an unawaited
 * `appendFile` and then called `process.exit(0)`, which does not flush pending
 * asynchronous I/O — so the gate downstream read an empty string, its commit
 * step was SKIPPED, and the whole job stayed green while recording nothing.
 * Every write below is synchronous for the same reason.
 *
 * ⚠️ IT PUSHES WITH WHATEVER CREDENTIAL THE CHECKOUT PERSISTED, AND IN CI THAT
 * MUST BE THE APP INSTALLATION TOKEN. A tag pushed with the workflow's own
 * `GITHUB_TOKEN` succeeds, appears, and triggers NOTHING — GitHub deliberately
 * refuses to start workflow runs from its own token, to prevent loops. The push
 * would be green, the tag would exist, and no package would ever be published.
 * That is the entire reason `.github/workflows/release.yml` mints an App token.
 *
 * EXIT CODES: 0 done (including "nothing to do") · 1 a manifest refused ·
 * 2 usage · 3 the tag read was blind.
 */
/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  EXIT_BLIND_READ,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  PUBLISHED_PACKAGES,
  classifyTagRead,
  deriveTags,
  formatPlan,
  introducedAt,
  pinTags,
} from './releaseTags.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const manifestOf = (pkg) => `${pkg.dir}/package.json`;

/** A manifest's `version` at a commit, or `undefined` where it cannot be read there. */
function versionAt(sha, pkg) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${sha}:${manifestOf(pkg)}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).version;
  } catch {
    return undefined;
  }
}

/** Every package's declared version at `sha`, or `undefined` where the manifest cannot be read. */
function readVersions(packages, sha) {
  const versions = {};
  // An unreadable manifest is left `undefined` on purpose: `deriveTags` turns
  // that into a REFUSAL that names the package, which is more useful than a
  // stack trace here.
  for (const pkg of packages) versions[pkg.name] = versionAt(sha, pkg);
  return versions;
}

/** The verdict on the first screen of a run, not only in the step log. */
function summarize(text) {
  const path = process.env['GITHUB_STEP_SUMMARY'];
  if (!path) return;
  // Synchronous, and that is load-bearing — see the MOTIR-3989 note above.
  appendFileSync(path, `### Release tags\n\n\`\`\`\n${text}\n\`\`\`\n`, 'utf8');
}

const USAGE = 'usage: node scripts/push-release-tags.mjs [--ref <commit>] [--dry-run]';

function main(argv) {
  let dryRun = false;
  let ref = 'HEAD';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--ref' && argv[i + 1] && !argv[i + 1].startsWith('--')) ref = argv[++i];
    else {
      console.error(arg === '--ref' ? '--ref needs a commit' : `unknown argument: ${arg}`);
      console.error(USAGE);
      return EXIT_USAGE;
    }
  }

  let sha;
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    sha = '';
  }
  if (!sha) {
    console.error(`--ref ${ref} does not name a commit in this checkout`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  console.log(`reading versions at ${sha}`);

  const read = classifyTagRead(git('tag', '-l').split('\n').filter(Boolean));
  if (read.blind) {
    console.error(read.summary);
    summarize(read.summary);
    return EXIT_BLIND_READ;
  }
  console.log(read.summary);

  const derived = deriveTags({
    versions: readVersions(PUBLISHED_PACKAGES, sha),
    existingTags: git('tag', '-l').split('\n').filter(Boolean),
  });
  // Only a tag that is about to be CREATED needs its commit, so a run in which
  // no version moved walks no history at all.
  const plan = pinTags(derived, ({ name, version }) => {
    const pkg = PUBLISHED_PACKAGES.find((p) => p.name === name);
    const shas = git('log', '--first-parent', '--format=%H', sha, '--', manifestOf(pkg))
      .split('\n')
      .filter(Boolean);
    return introducedAt({ version, shas, versionAt: (c) => versionAt(c, pkg) });
  });

  const report = formatPlan(plan);
  console.log(report);
  summarize(report);

  if (plan.problems.length > 0) return EXIT_REFUSED;

  for (const { tag, commit } of plan.create) {
    if (dryRun) {
      console.log(`--dry-run: would push ${tag} at ${commit}`);
      continue;
    }
    // A LIGHTWEIGHT tag, which is what the release procedure every lane's header
    // documents does by hand (`git tag cli-v<x.y.z> && git push origin <tag>`).
    // It also needs no `user.name` / `user.email`, so this step does not depend
    // on an identity some earlier step happened to configure.
    git('tag', tag, commit);
    git('push', 'origin', tag);
    console.log(`pushed ${tag}`);
  }

  return EXIT_OK;
}

process.exitCode = main(process.argv.slice(2));
