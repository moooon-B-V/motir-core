import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Server Action SALT is pinned across builds (MOTIR-3948).
//
// Next hashes every Server Action id with the build's `encryptionKey`
// (`serverReferenceHashSalt`), and generates that key randomly per build unless
// `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set. Unpinned, every release re-salts
// every id: a browser holding the previous build's JavaScript posts ids the new
// build has never heard of and gets a 404 on every write until it reloads.
//
// Nothing about that is visible from a green build — which is why the assertions
// below are about WIRING, in the style `tests/monitoring/sentry-wiring.test.ts`
// established for the deploy job. The failure they guard against is not a bug
// somebody writes; it is a line somebody deletes while tidying the Dockerfile.

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

const KEY = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';

/** The `deploy` job's YAML, sliced out the way the other deploy guards do. */
function deployJob(): string {
  const start = ci.indexOf('\n  deploy:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/**
 * The single `RUN … next build` instruction, comments dropped and line
 * continuations joined. The comments have to go FIRST: this file explains
 * `next build` at length, and a comment paragraph attaches to whichever
 * instruction precedes it — three chunks match the phrase otherwise, none of
 * them by running the command.
 */
function nextBuildRun(): string {
  const runs = dockerfile
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .split(/\n(?=[A-Z]+ )/)
    .map((instruction) => instruction.replace(/\\\n\s*/g, ' '))
    .filter((instruction) => instruction.startsWith('RUN ') && instruction.includes('next build'));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe('the Dockerfile bakes the salt into the build that uses it', () => {
  it('mounts the key as a build SECRET on the very RUN that calls `next build`', () => {
    // Both halves matter and only together: the salt is applied by `next build`
    // itself, so a mount on any other instruction — or an `ENV` in a stage the
    // build does not run in — configures nothing while reading as solved.
    const run = nextBuildRun();
    expect(run).toContain(`--mount=type=secret,id=${KEY}`);
    expect(run).toContain(`export ${KEY}`);
  });

  it('reads it defensively, so a build with no secret still succeeds', () => {
    // The self-host contract: `docker build` with no secret leaves the value
    // empty, Next falls back to a per-build key, and the image builds. An
    // unguarded `cat` under `set -eu` would fail the build instead.
    expect(nextBuildRun()).toMatch(
      new RegExp(`${KEY}="\\$\\(cat /run/secrets/${KEY} 2>/dev/null \\|\\| true\\)"`),
    );
  });

  it('is never a build ARG — it encrypts the arguments actions close over', () => {
    // A `--build-arg` value is recorded in the build's own metadata. This is the
    // same line the Sentry auth token is on, and for the same reason.
    expect(dockerfile).not.toMatch(new RegExp(`^ARG ${KEY}`, 'm'));
    expect(deployJob()).not.toContain(`--build-arg "${KEY}`);
  });
});

describe('the deploy job supplies it, and refuses to release without it', () => {
  it('passes it to `flyctl deploy` as a build secret', () => {
    expect(deployJob()).toContain(`--build-secret "${KEY}=$${KEY}"`);
  });

  it('stops the release when the secret is unset, rather than shipping a re-salted build', () => {
    // An empty value is not a degraded release — it is THIS bug, shipped again,
    // silently: the build succeeds, the machines are healthy, and every open tab
    // loses its writes. So the deploy stops, exactly as it does for a missing
    // monitoring secret.
    const deploy = deployJob();
    expect(deploy).toContain(`Missing ${KEY}`);
    expect(deploy).toMatch(new RegExp(`if \\[ -z "\\$\\{${KEY}:-\\}" \\]; then`));
  });

  it('reads the value from a repository secret, never from a literal', () => {
    expect(deployJob()).toContain(`${KEY}: \${{ secrets.${KEY} }}`);
  });
});
