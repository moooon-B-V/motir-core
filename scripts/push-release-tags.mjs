#!/usr/bin/env node
/**
 * Push the release tags for whatever versions are now on `main` (MOTIR-3970).
 *
 * Run it from a FULL-DEPTH checkout, after a **Version Packages** pull request
 * has merged:
 *
 *   node scripts/push-release-tags.mjs
 *   node scripts/push-release-tags.mjs --dry-run
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
import { appendFileSync, readFileSync } from 'node:fs';
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
} from './releaseTags.mjs';

const ROOT = process.cwd();

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** Every package's declared version, or `undefined` where the manifest cannot be read. */
function readVersions(packages) {
  const versions = {};
  for (const pkg of packages) {
    try {
      versions[pkg.name] = JSON.parse(
        readFileSync(join(ROOT, pkg.dir, 'package.json'), 'utf8'),
      ).version;
    } catch {
      // Left undefined on purpose: `deriveTags` turns that into a REFUSAL that
      // names the package, which is more useful than a stack trace here.
      versions[pkg.name] = undefined;
    }
  }
  return versions;
}

/** The verdict on the first screen of a run, not only in the step log. */
function summarize(text) {
  const path = process.env['GITHUB_STEP_SUMMARY'];
  if (!path) return;
  // Synchronous, and that is load-bearing — see the MOTIR-3989 note above.
  appendFileSync(path, `### Release tags\n\n\`\`\`\n${text}\n\`\`\`\n`, 'utf8');
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown[0]}`);
    console.error('usage: node scripts/push-release-tags.mjs [--dry-run]');
    return EXIT_USAGE;
  }

  const read = classifyTagRead(git('tag', '-l').split('\n').filter(Boolean));
  if (read.blind) {
    console.error(read.summary);
    summarize(read.summary);
    return EXIT_BLIND_READ;
  }
  console.log(read.summary);

  const plan = deriveTags({
    versions: readVersions(PUBLISHED_PACKAGES),
    existingTags: git('tag', '-l').split('\n').filter(Boolean),
  });

  const report = formatPlan(plan);
  console.log(report);
  summarize(report);

  if (plan.problems.length > 0) return EXIT_REFUSED;

  for (const { tag } of plan.create) {
    if (dryRun) {
      console.log(`--dry-run: would push ${tag}`);
      continue;
    }
    // A LIGHTWEIGHT tag, which is what the release procedure every lane's header
    // documents does by hand (`git tag cli-v<x.y.z> && git push origin <tag>`).
    // It also needs no `user.name` / `user.email`, so this step does not depend
    // on an identity some earlier step happened to configure.
    git('tag', tag);
    git('push', 'origin', tag);
    console.log(`pushed ${tag}`);
  }

  return EXIT_OK;
}

process.exitCode = main(process.argv.slice(2));
