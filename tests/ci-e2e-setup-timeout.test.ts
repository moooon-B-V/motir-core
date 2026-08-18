import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guard for MOTIR-2970: `.github/actions/e2e-setup` wraps both Playwright
// install paths in a 3-attempt retry loop, and that loop used to be written as
// `if pnpm exec playwright …; then exit 0; fi` — a shape that can only fire on a
// non-zero EXIT. The Ubuntu archive does not fail that way. On 2026-08-18 three
// legs across two PRs each wedged inside the `apt-get update` that
// `playwright install(-deps)` shells out to and burned 6h0m — GitHub's default
// per-job budget — with attempts 2 and 3 unreachable and `Run E2E` skipped
// (run 32073646174, job 95529249270: this step logged duration_ms=21531687).
//
// The fix is a per-attempt `timeout`, which converts a wedge into a failed
// attempt the existing retry already handles. These assertions keep it from
// being unwound, and — because the workflow files are not type-checked, linted
// or executed by any other suite — they do it by RUNNING the shipped script
// rather than by matching text against it. The text assertions exist only to
// prove the extraction found the real thing.

const ACTION_PATH = join(process.cwd(), '.github/actions/e2e-setup/action.yml');
const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');

const CACHE_MISS_STEP = 'Install Playwright browser + OS deps (cache miss)';
const CACHE_HIT_STEP = 'Install Playwright OS deps (cache hit)';

interface Step {
  name: string;
  /** The step's `run: |` block, dedented to column 0. */
  run: string;
  /** The step's `env:` mapping, as declared on the step itself. */
  env: Record<string, string>;
}

/**
 * Pull a composite action's steps out of its manifest without a YAML dependency
 * (the repo has none — see tests/ci-postgres-container.test.ts, which parses
 * workflow jobs the same way). A step begins at `    - name: …`; its block runs
 * to the next step at that indent or to a dedent out of `runs.steps`.
 */
function stepsOf(source: string): Step[] {
  const lines = source.split('\n');
  const steps: Step[] = [];
  let current: { name: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    steps.push({
      name: current.name,
      run: runBlockOf(current.body),
      env: envBlockOf(current.body),
    });
    current = null;
  };
  for (const line of lines) {
    const header = /^ {4}- name: (.+)$/.exec(line);
    if (header) {
      flush();
      current = { name: header[1]!.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return steps;
}

/** The `      run: |` block of a step body, dedented by its own indent. */
function runBlockOf(body: string[]): string {
  const at = body.findIndex((l) => /^ {6}run: \|\s*$/.test(l));
  if (at === -1) return '';
  const collected: string[] = [];
  for (const line of body.slice(at + 1)) {
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    if (!line.startsWith('        ')) break;
    collected.push(line.slice(8));
  }
  return collected.join('\n');
}

/** The `      env:` mapping of a step body. */
function envBlockOf(body: string[]): Record<string, string> {
  const at = body.findIndex((l) => /^ {6}env:\s*$/.test(l));
  const env: Record<string, string> = {};
  if (at === -1) return env;
  for (const line of body.slice(at + 1)) {
    const entry = /^ {8}([A-Za-z_][A-Za-z0-9_]*): (.+)$/.exec(line);
    if (!entry) break;
    env[entry[1]!] = entry[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const steps = stepsOf(readFileSync(ACTION_PATH, 'utf8'));
const installSteps = [CACHE_MISS_STEP, CACHE_HIT_STEP].map((name) => {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`e2e-setup has no step named "${name}"`);
  return step;
});

/**
 * A PATH directory holding only the fakes this test needs plus the real
 * coreutils, so a case never asserts a property of the MACHINE. `sleep` is
 * stubbed to return instantly (the loop backs off 15s between attempts, which
 * would otherwise put a 3-attempt case past the 15s testTimeout), so the fake
 * `pnpm` must block on an ABSOLUTE-path sleep or it would shadow itself.
 */
const REAL_SLEEP = ['/usr/bin/sleep', '/bin/sleep'].find((p) => existsSync(p));

function fakeBin(pnpmScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-setup-timeout-'));
  writeFileSync(join(dir, 'pnpm'), `#!/usr/bin/env bash\n${pnpmScript}\n`);
  // Instant backoff. `timeout` is unaffected — it counts wall-clock itself.
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  // Record what the step asks root to do, rather than letting the case depend
  // on whether THIS machine happens to have sudo (it is the runner that does).
  writeFileSync(join(dir, 'sudo'), `#!/usr/bin/env bash\necho "$@" >> "$SUDO_LOG"\nexit 0\n`);
  for (const bin of ['pnpm', 'sleep', 'sudo']) chmodSync(join(dir, bin), 0o755);
  return dir;
}

/** Run a shipped step body under the same shell flags GitHub Actions uses. */
function runStep(step: Step, pnpmScript: string, timeoutOverride: string) {
  const dir = fakeBin(pnpmScript);
  const sudoLog = join(dir, 'sudo.log');
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        PLAYWRIGHT_INSTALL_TIMEOUT: timeoutOverride,
        FAKE_STATE: join(dir, 'attempts'),
        SUDO_LOG: sudoLog,
      },
    },
  );
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    sudo: existsSync(sudoLog) ? readFileSync(sudoLog, 'utf8') : '',
  };
}

describe('e2e-setup install retry bounds each attempt (MOTIR-2970)', () => {
  it('finds both install steps, each with a 3-attempt loop', () => {
    // Anti-vacuous: a manifest restructure (or a parser regression) would
    // otherwise make every assertion below pass against an empty string.
    expect(installSteps.map((s) => s.name)).toEqual([CACHE_MISS_STEP, CACHE_HIT_STEP]);
    for (const step of installSteps) {
      expect(step.run).toMatch(/^for attempt in 1 2 3; do$/m);
      expect(step.run).toMatch(/playwright install/);
    }
  });

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s bounds the attempt INSIDE the loop',
    (_name, step) => {
      const lines = step.run.split('\n');
      const loopStart = lines.findIndex((l) => /^for attempt in 1 2 3; do$/.test(l));
      const loopEnd = lines.findIndex((l) => /^done$/.test(l));
      const timed = lines.findIndex((l) => /^\s*timeout .*playwright install/.test(l));
      expect(loopStart).toBeGreaterThanOrEqual(0);
      expect(loopEnd).toBeGreaterThan(loopStart);
      // Inside the loop, not wrapped around it: a `timeout` around the whole
      // loop would cap the damage at one budget and still lose attempts 2 & 3.
      expect(timed).toBeGreaterThan(loopStart);
      expect(timed).toBeLessThan(loopEnd);
      // The kill escalation is what guarantees the attempt returns at all.
      expect(lines[timed]).toContain('--kill-after=');
      // The pre-2970 shape reads the status through `if`, which yields 0 when
      // no branch is taken — so it can neither see a hang nor name one.
      expect(step.run).not.toMatch(/if pnpm exec playwright/);
      expect(step.run).toMatch(/\|\| status=\$\?/);
    },
  );

  it('pins a budget on each step, generous for the work that step does', () => {
    const [cacheMiss, cacheHit] = installSteps as [Step, Step];
    const seconds = (s: Step) => {
      const raw = s.env['PLAYWRIGHT_INSTALL_TIMEOUT'];
      expect(raw, `${s.name} declares no PLAYWRIGHT_INSTALL_TIMEOUT`).toMatch(/^\d+s$/);
      return Number.parseInt(raw!, 10);
    };
    // Well above the ~30–60s a healthy runner takes, well below the 6h budget
    // the wedge used to consume.
    expect(seconds(cacheHit)).toBeGreaterThanOrEqual(120);
    expect(seconds(cacheHit)).toBeLessThanOrEqual(900);
    // The cache-miss path also downloads the browser bundle, so it must not be
    // held to a budget sized for apt alone.
    expect(seconds(cacheMiss)).toBeGreaterThan(seconds(cacheHit));
  });
});

describe('e2e-setup install retry, executed (MOTIR-2970)', () => {
  it('has a real sleep to block on', () => {
    // The hang cases below are meaningless if the fake `pnpm` cannot block.
    expect(REAL_SLEEP).toBeDefined();
  });

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a HANG fails that attempt and still reaches attempts 2 and 3',
    (_name, step) => {
      // The exact 2026-08-18 failure: the command never returns. Before the
      // wrapper this consumed the whole job budget on attempt 1.
      const { status, out } = runStep(step, `exec ${REAL_SLEEP} 120`, '1s');
      expect(status).toBe(1);
      expect(out).toContain('attempt 1 TIMED OUT after 1s');
      expect(out).toContain('attempt 2 TIMED OUT after 1s');
      expect(out).toContain('attempt 3 TIMED OUT after 1s');
      expect(out).toMatch(/::error::playwright install.* failed after 3 attempts/);
    },
    15_000,
  );

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a hang on attempt 1 RECOVERS when attempt 2 succeeds',
    (_name, step) => {
      // The point of the whole card: the retry that was written for this case
      // can now actually run. Before the wrapper, attempt 2 never happened.
      const { status, out } = runStep(
        step,
        `n=$(cat "$FAKE_STATE" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_STATE"; ` +
          `if [ "$n" -eq 0 ]; then exec ${REAL_SLEEP} 120; fi; exit 0`,
        '1s',
      );
      expect(status).toBe(0);
      expect(out).toContain('attempt 1 TIMED OUT after 1s');
      expect(out).not.toContain('attempt 2');
    },
    15_000,
  );

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a TIMED-OUT attempt kills the apt it orphaned before retrying',
    (_name, step) => {
      // `timeout` signals `pnpm`; the `sudo apt-get` underneath is root-owned
      // and outlives it, holding the apt flock — so without this kill the next
      // attempt dies on `Could not get lock`, which is what run 32128513614's
      // `a11y-2` leg did to the first version of this very fix.
      const { sudo } = runStep(step, `exec ${REAL_SLEEP} 120`, '1s');
      expect(sudo).toContain('pkill -9 -x apt-get');
      // `-x` matches the process NAME. `pkill -f apt-get` would match the
      // `sudo pkill …` command line itself and kill the cleanup mid-run.
      expect(sudo).not.toMatch(/pkill\s+(-\S+\s+)*-f\b/);
    },
    15_000,
  );

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a plain non-zero exit does NOT kill apt',
    (_name, step) => {
      // A command that RETURNED left nothing behind; killing a healthy apt a
      // sibling step started would be a new bug, not a cleanup.
      const { sudo } = runStep(step, 'exit 100', '30s');
      expect(sudo).toBe('');
    },
    15_000,
  );

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a non-zero EXIT is still retried, and reports its status',
    (_name, step) => {
      // The pre-existing behaviour the wrapper must not have regressed — the
      // transient-503 case the loop was originally written for.
      const { status, out } = runStep(step, 'exit 100', '30s');
      expect(status).toBe(1);
      expect(out).toContain('attempt 1 failed (exit 100)');
      expect(out).toContain('attempt 3 failed (exit 100)');
      expect(out).not.toContain('TIMED OUT');
    },
    15_000,
  );

  it.each(installSteps.map((s) => [s.name, s] as const))(
    '%s: a healthy install exits 0 on the first attempt, silently',
    (_name, step) => {
      const { status, out } = runStep(step, 'exit 0', '30s');
      expect(status).toBe(0);
      expect(out).not.toContain('attempt 1');
      expect(out).not.toContain('::error::');
    },
    15_000,
  );
});

describe('the E2E legs cannot hold CI complete for a job budget (MOTIR-2970)', () => {
  const ci = readFileSync(CI_PATH, 'utf8');

  /** The body of one job in a workflow, keyed at two spaces of indent. */
  function jobBody(source: string, id: string): string {
    const lines = source.split('\n');
    const at = lines.findIndex((l) => l === `  ${id}:`);
    expect(at, `ci.yml has no job "${id}"`).toBeGreaterThanOrEqual(0);
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      // Window to the NEXT job key, never slice-to-EOF: a slice-to-EOF window
      // equals "this job" only while it is the last one in the file, and then
      // silently widens when the next job is appended.
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
      body.push(line);
    }
    return body.join('\n');
  }

  it('the e2e matrix declares a timeout-minutes above the slowest real leg', () => {
    const body = jobBody(ci, 'e2e');
    // Anti-vacuous: prove the window actually caught the E2E job.
    expect(body).toContain('name: Playwright E2E (${{ matrix.id }})');
    const declared = /^ {4}timeout-minutes: (\d+)$/m.exec(body);
    expect(declared, 'the e2e job declares no timeout-minutes').not.toBeNull();
    const minutes = Number.parseInt(declared![1]!, 10);
    // Above the 17min slowest leg measured across six green runs (66 legs),
    // and far below the 360min default that the 2026-08-18 wedges consumed.
    expect(minutes).toBeGreaterThanOrEqual(25);
    expect(minutes).toBeLessThanOrEqual(90);
  });
});
