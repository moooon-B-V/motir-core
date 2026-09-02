import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-4050 — the merge queue, and the half of it that lives in this
// repository.
//
// The control has two halves and only one of them is a file. GitHub's side is
// the `merge_queue` rule on ruleset 17227448, which nothing here can read; this
// side is `ci.yml`, and the two are useless apart. The failure modes that
// follow from getting THIS half wrong are all silent, which is why they are
// asserted rather than reviewed:
//
//   1. NO `merge_group:` TRIGGER. `protect-main` requires `CI complete`, and a
//      queue entry waits for that context to report against the
//      `gh-readonly-queue/main/pr-<n>-<sha>` branch. A workflow that does not
//      run on `merge_group` never reports it, the entry times out on
//      `check_response_timeout_minutes`, and the pull request is ejected with no
//      failing check to explain why. Nothing goes red — merges just stop.
//   2. THE MATRIX LEFT THE PUSH LANE AND DID NOT ARRIVE IN THE QUEUE. The whole
//      trade is that `main` stops re-running what the queue ran. If a job is
//      gated off `push` and is not reachable on `merge_group` either, it has
//      quietly stopped being a gate anywhere, and every check still reports
//      green.
//   3. A JOB `deploy` NEEDS IS SKIPPED ON A PUSH. A skipped `needs` entry makes
//      its dependents skip, so this does not gate the release — it stops it, and
//      `main` simply never ships again. `deploy-freshness.yml` is what would
//      eventually say so, an hour and a half later.
//
// Read as text, not by running it: workflow YAML is neither type-checked nor
// linted by any suite (the premise `tests/ci-complete-gate.test.ts` and
// `tests/ci-fly-deploy.test.ts` share, and the same no-YAML-dependency
// constraint — the repo has no YAML parser).
//
// ⚠️ The `if:` expressions are RESOLVED against a fabricated `github` context
// rather than matched as strings, for the reason MOTIR-4095 recorded in the
// acceptance lane: reachability is arithmetic, not structure, and a regex that
// agrees with `!= 'push'` agrees just as happily with an expression that means
// the opposite. The evaluator below throws on any construct it does not
// implement, so it cannot go green by returning `undefined`.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const ci = readFileSync(CI_PATH, 'utf8');

/** Split the `jobs:` mapping into { jobId → body }. Job ids sit at two spaces. */
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

/** The same text with whole-line comments dropped — a job's prose describes its
 *  neighbours, and every assertion here is about what a job DOES. */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const jobCode = (id: string): string => codeOf(ciJobs.get(id) ?? '');
const header = codeOf(ci.split(/^jobs:\s*$/m)[0] ?? '');

/** The JOB-level `if:` — four spaces exactly (`jobs:` → id → key). */
function jobIf(id: string): string | null {
  const m = /^ {4}if:(.*)$/m.exec(jobCode(id));
  return m ? m[1]!.trim() : null;
}

/** `needs:` entries in either YAML form. */
function declaredNeeds(id: string): string[] {
  const code = jobCode(id);
  const flow = /needs:\s*\[([^\]]*)\]/.exec(code);
  if (flow) {
    return flow[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const block = /needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/.exec(code);
  if (block) return [...block[1]!.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  return [];
}

type Event = 'pull_request' | 'merge_group' | 'push';

/**
 * A fabricated context per event. Two values are chosen rather than obvious and
 * both are the CONSERVATIVE choice — they make a job MORE likely to look
 * reachable, so a job this evaluator calls unreachable really is:
 *
 *   • `needs.changes.outputs.*` is `'true'` for every event, because that is
 *     what the `changes` job actually emits: it fails open on anything that is
 *     not a pull request, and on a pull request the interesting case is the one
 *     where the diff DOES touch app code.
 *   • the at-scale LABEL is absent, because the property under test is what an
 *     ORDINARY pull request and an ordinary queue entry run. A label can only
 *     add lanes.
 */
const contextFor = (event: Event): Record<string, string> => ({
  'github.event_name': event,
  'github.ref': event === 'push' ? 'refs/heads/main' : 'refs/pull/1/merge',
  'needs.changes.outputs.app': 'true',
  'needs.changes.outputs.images': 'true',
});

/**
 * Resolve one workflow expression to a boolean. Implements exactly the
 * constructs this file's job-level conditions use — `&&`, `||`, parentheses,
 * `==`/`!=` against a single-quoted literal, `contains(<labels>, '<literal>')`,
 * and a bare context lookup — and throws on anything else.
 */
function evaluate(expression: string, github: Record<string, string>): boolean {
  const body = expression
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
  const tokens = body.match(/\(|\)|,|&&|\|\||==|!=|'[^']*'|[A-Za-z0-9_.*[\]-]+/g);
  if (!tokens) throw new Error(`unreadable workflow expression: ${expression}`);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`expression ended early: ${expression}`);
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected \`${expected}\`, found \`${token}\` in: ${expression}`);
    }
    return token;
  };

  /** A literal, or a context path this evaluator knows. Unknown paths throw. */
  const value = (token: string): string => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token in github) return github[token]!;
    // `github.event.pull_request.labels.*.name` is the only unfabricated path,
    // and it is handled by `contains` below — anything else reaching here is a
    // context this guard has never been told how to read.
    throw new Error(`unknown context \`${token}\` in: ${expression}`);
  };

  function primary(): boolean {
    if (peek() === '(') {
      take('(');
      const inner = or();
      take(')');
      return inner;
    }
    const first = take();
    if (first === 'always') {
      take('(');
      take(')');
      // For REACHABILITY, `always()` is unconditional. It says something else
      // about failed needs, which no assertion here reads.
      return true;
    }
    if (first === 'contains') {
      take('(');
      const haystack = take();
      take(',');
      const needle = take();
      take(')');
      if (haystack !== 'github.event.pull_request.labels.*.name') {
        throw new Error(`\`contains\` over an unmodelled collection: ${haystack}`);
      }
      // No labels in the fabricated context — see `contextFor`.
      void needle;
      return false;
    }
    const operator = peek();
    if (operator !== '==' && operator !== '!=') {
      throw new Error(`bare value \`${first}\` used as a condition in: ${expression}`);
    }
    take();
    const right = take();
    return operator === '==' ? value(first) === value(right) : value(first) !== value(right);
  }

  function and(): boolean {
    let left = primary();
    while (peek() === '&&') {
      take();
      const right = primary();
      left = left && right;
    }
    return left;
  }

  function or(): boolean {
    let left = and();
    while (peek() === '||') {
      take();
      const right = or();
      left = left || right;
    }
    return left;
  }

  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in: ${expression}`);
  return result;
}

/** Does this job run, for this event? A job with no `if:` always runs. */
function runsOn(id: string, event: Event): boolean {
  const condition = jobIf(id);
  if (condition === null) return true;
  return evaluate(condition, contextFor(event));
}

/**
 * The full gate — every job that verifies the change itself. This is the set
 * that used to run twice, on the pull request and again on the push, and now
 * runs on the pull request and in the QUEUE.
 */
const MATRIX = ['lint', 'typecheck', 'structural-guards', 'build', 'test', 'coverage', 'e2e'];
/** Gated off the pull-request lane by MOTIR-3148 — the queue is its only run. */
const QUEUE_ONLY = ['e2e-at-scale'];
/**
 * What a push still runs: the tripwire a BYPASSED merge would meet. All of it is
 * cheap and none of it is serial — the longest is `lint` at ~4 minutes and the
 * rest finish inside that — so the lane's length is set by one job, not seven.
 */
const PUSH_LANE = [
  'lint',
  'typecheck',
  'structural-guards',
  'design-system',
  'design-guards',
  'cli',
  'build',
];
/**
 * …and the subset `deploy` waits for. Narrower than the lane on purpose, and
 * with the reasoning the deploy job's own comment already carried: the package
 * and design lanes are not part of this service's artifact. `build` is here for
 * the schema-drift and NFT assertions it makes, not for the bundle it produces.
 */
const TRIPWIRE = ['lint', 'typecheck', 'build'];

describe('the merge queue reports the required check (MOTIR-4050)', () => {
  it('finds the workflow it is meant to guard', () => {
    // A parser regression would otherwise make every assertion below vacuous.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(ciJobs.has('ci-complete')).toBe(true);
    expect(ciJobs.has('deploy')).toBe(true);
  });

  it('triggers on `merge_group`, alongside the pull request and the push', () => {
    // Failure mode 1. Without this line every queue entry is ejected on a
    // timeout, and no check anywhere goes red.
    expect(header).toMatch(/^on:\s*$/m);
    expect(header).toMatch(/^ {2}merge_group:\s*$/m);
    expect(header).toMatch(/^ {2}pull_request:\s*$/m);
    expect(header).toMatch(/^ {2}push:\s*\n {4}branches: \[main\]$/m);
  });

  it('reports `CI complete` on a queue entry', () => {
    // The required context must exist on `merge_group` or the entry never
    // settles. `if: always()` is what makes that true regardless of what skips.
    expect(runsOn('ci-complete', 'merge_group')).toBe(true);
    expect(jobIf('ci-complete')).toBe('always()');
  });
});

describe('the queue runs the whole gate, and the push lane no longer does', () => {
  it.each(MATRIX)('%s runs on a queue entry', (job) => {
    // Failure mode 2 — the one that leaves a check green and gating nothing.
    expect(ciJobs.has(job), `${job} exists`).toBe(true);
    expect(runsOn(job, 'merge_group')).toBe(true);
  });

  it.each(QUEUE_ONLY)('%s runs on a queue entry and NOT on an ordinary PR', (job) => {
    // MOTIR-3148's property, restated where the legs now live: once per merge,
    // never on an unlabelled pull request.
    expect(runsOn(job, 'merge_group')).toBe(true);
    expect(runsOn(job, 'pull_request')).toBe(false);
    expect(runsOn(job, 'push')).toBe(false);
  });

  it('leaves only the tripwire on a push', () => {
    // The saving. Anything else still running here is the duplicate this card
    // set out to remove — and the deploy-starvation window MOTIR-3106 fixed is
    // this lane's length, so it growing back is a regression in two directions.
    const onPush = [...ciJobs.keys()].filter(
      (id) => id !== 'deploy' && id !== 'ci-complete' && id !== 'changes' && runsOn(id, 'push'),
    );
    expect(onPush.sort()).toEqual([...PUSH_LANE].sort());
  });

  it('runs every job somewhere', () => {
    // A job reachable on no event is dead code that still reports a green
    // skipped check — the shape of failure mode 2 for a job nobody listed above.
    for (const id of ciJobs.keys()) {
      const events: Event[] = ['pull_request', 'merge_group', 'push'];
      expect(
        events.some((event) => runsOn(id, event)),
        `${id} runs on some event`,
      ).toBe(true);
    }
  });
});

describe('the release is still gated, and can still be reached', () => {
  it('waits only for jobs that actually run on a push', () => {
    // Failure mode 3, and the reason this file exists rather than a review
    // comment. A skipped `needs` entry makes its dependents skip: leaving a
    // queue-only job in this list does not gate the release, it ends it.
    for (const need of declaredNeeds('deploy')) {
      expect(runsOn(need, 'push'), `deploy needs ${need}, which must run on a push`).toBe(true);
    }
  });

  it('waits for the tripwire, so a BYPASSED merge still meets a gate', () => {
    // Ruleset 17227448 has a bypass actor, so a merge can reach `main` without
    // passing through any queue. This is the only thing that verifies it.
    for (const gate of TRIPWIRE) expect(declaredNeeds('deploy')).toContain(gate);
  });

  it('does not deploy from a queue entry', () => {
    // A queue entry's branch is thrown away if the entry is ejected. Shipping
    // from one would release a commit that never became `main`.
    expect(runsOn('deploy', 'merge_group')).toBe(false);
    expect(runsOn('deploy', 'push')).toBe(true);
  });
});
