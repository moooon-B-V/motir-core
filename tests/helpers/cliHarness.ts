import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The harness the CLI story suite drives the BUILT `motir` binary with (Story
// 7.9 · Subtask 7.9.5 · MOTIR-883).
//
// Everything here exists so the suite tests the SHIPPED artifact rather than a
// re-import of its source: the binary is the tsup bundle `package.json#bin`
// points at, it runs as a real child process, and it reaches the server over a
// socket (tests/helpers/mcpHttpServer.ts). The only things faked are the two
// programs Motir SHELLS OUT TO and deliberately does not own — the user's coding
// agent (BYOK: the agent is the user's, Motir only launches it) and `gh`. Both
// are recorded so the suite can assert what the CLI actually asked them to do.

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root — `tests/helpers/` is two levels down. */
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_DIR = join(REPO_ROOT, 'packages', 'cli');
const CLI_ENTRY = join(CLI_DIR, 'dist', 'index.js');

let built = false;

/**
 * Build `packages/cli` and return the path to the built entrypoint.
 *
 * Built from THIS commit's source on every run (never a stale `dist/` a previous
 * build left behind) — the same reason the design-system CI job rebuilds before
 * running its barrel guard. Memoized per process: one worker, one build. Keep
 * every binary-spawning test in ONE file, so two workers can never build into
 * the same `dist/` concurrently.
 */
export function ensureCliBuilt(): string {
  if (built) return CLI_ENTRY;
  // tsup is a devDependency OF the package, so pnpm links it under the
  // package's own `node_modules/.bin` (not the root's).
  const tsup = join(CLI_DIR, 'node_modules', '.bin', 'tsup');
  const result = spawnSync(tsup, [], { cwd: CLI_DIR, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(
      `Building @motir/cli failed (exit ${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`,
    );
  }
  if (!existsSync(CLI_ENTRY)) throw new Error(`tsup reported success but ${CLI_ENTRY} is missing.`);
  built = true;
  return CLI_ENTRY;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for assertions that don't care which stream a line took. */
  output: string;
}

export interface CliRunOptions {
  /** Working directory the command runs in (defaults to the workspace root). */
  cwd?: string;
  /** Extra environment for this invocation (e.g. MOTIR_AGENT). */
  env?: Record<string, string>;
}

/**
 * One CLI workspace: a temp workspace root (where `.motir.json` lands), a temp
 * config home (the credential store + the session exclude list), and a temp
 * `bin` on PATH holding the fake `gh`.
 */
export interface CliWorkspace {
  /** The workspace root — the folder `motir link` binds. */
  root: string;
  /** `MOTIR_CONFIG_HOME` for every command (never a real home). */
  configHome: string;
  /** Directory prepended to PATH; holds the fake `gh`. */
  binDir: string;
  /** Run the built binary with the workspace's env. ASYNC on purpose — see
   *  {@link makeCliWorkspace}. */
  run(args: string[], opts?: CliRunOptions): Promise<CliResult>;
  /** Absolute path inside the workspace root. */
  path(...segments: string[]): string;
}

export function makeCliWorkspace(): CliWorkspace {
  const base = mkdtempSync(join(tmpdir(), 'motir-cli-'));
  const root = join(base, 'workspace');
  const configHome = join(base, 'config-home');
  const binDir = join(base, 'bin');
  const home = join(base, 'home');
  for (const dir of [root, configHome, binDir, home]) mkdirSync(dir, { recursive: true });

  const entry = ensureCliBuilt();

  const run = async (args: string[], opts: CliRunOptions = {}): Promise<CliResult> => {
    // ASYNC, never `spawnSync`: the MCP endpoint the CLI connects to is served by
    // an HTTP listener on THIS process's event loop (tests/helpers/mcpHttpServer),
    // and a synchronous spawn blocks that loop — the child's request would never
    // be answered and every command would hang to its timeout.
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: opts.cwd ?? root,
      shell: false,
      // A CLEAN environment: PATH (+ the fake bin), a temp HOME and config home,
      // and nothing else. Inheriting the runner's env would let a real
      // MOTIR_TOKEN / MOTIR_AGENT on the machine change what the CLI does.
      env: {
        // `NODE_ENV` is the one inherited value: the repo's ProcessEnv type
        // requires it, and the CLI never reads it.
        NODE_ENV: process.env.NODE_ENV,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        MOTIR_CONFIG_HOME: configHome,
        // git needs an identity for the commits the session-branch tests make.
        GIT_AUTHOR_NAME: 'Motir Test',
        GIT_AUTHOR_EMAIL: 'test@motir.invalid',
        GIT_COMMITTER_NAME: 'Motir Test',
        GIT_COMMITTER_EMAIL: 'test@motir.invalid',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      // A hung command must fail its own test, not stall the whole file.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectExit(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolveExit(signal ? 1 : (code ?? 1));
      });
    });

    return { exitCode, stdout, stderr, output: stdout + stderr };
  };

  return { root, configHome, binDir, run, path: (...segments) => join(root, ...segments) };
}

// ── the fake coding agent ───────────────────────────────────────────────────

/** One recorded agent invocation — everything the BYOK contract promises the
 *  agent receives (agentRun.ts: the prompt on BOTH stdin and $MOTIR_PROMPT_FILE,
 *  launched in the resolved checkout). */
export interface AgentInvocation {
  /** The directory the agent was launched in — the repo-routing assertion. */
  cwd: string;
  /** The prompt as delivered on STDIN. */
  stdin: string;
  /** The value of `$MOTIR_PROMPT_FILE`. */
  promptFile: string | null;
  /** The prompt as read back from `$MOTIR_PROMPT_FILE`. */
  promptFromFile: string | null;
  argv: string[];
}

/** What a scripted agent does on its Nth invocation. */
export interface AgentStep {
  /** Exit code (default 0). */
  exit?: number;
  /** Directory to create, relative to the agent's cwd — the bootstrap agent
   *  "cloning" the repo it was sent to create. */
  create?: string;
  /**
   * Do what a session-lineage prompt tells a real agent to do: branch from the
   * session branch on origin, commit `file`, push it back — IN the directory the
   * agent was launched in.
   *
   * The branch is not configured here; the agent READS it out of the prompt it
   * was handed (the GIT WORKFLOW section names it), which is both what a real
   * agent does and the only way a test can know a run-id-stamped branch name.
   */
  integrate?: { file: string };
}

export interface FakeAgent {
  /** The command line to pass as `--agent`. */
  command: string;
  /** Every invocation so far, in order. */
  invocations(): AgentInvocation[];
  /** Re-script the agent (the steps are consumed in order; the last one repeats). */
  script(steps: AgentStep[]): void;
}

/**
 * Write a scripted fake agent into `dir` and return its command line.
 *
 * It records what it was given and exits per the script — never an LLM, never a
 * network call (the acceptance criterion: "the fake agent never needs a real
 * LLM"). The `integrate` step is what makes a session-branch run REAL: the agent
 * commits on the session branch exactly as the prompt's GIT WORKFLOW section
 * tells a real one to, so the end-of-run push + pull request act on true commits.
 */
export function writeFakeAgent(dir: string): FakeAgent {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'fake-agent.mjs');
  const logPath = join(dir, 'agent-log.jsonl');
  const planPath = join(dir, 'agent-plan.json');

  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LOG = ${JSON.stringify(logPath)};
const PLAN = ${JSON.stringify(planPath)};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // No stdin at all (or an immediate close) is a legitimate case — the prompt
    // is also on disk at $MOTIR_PROMPT_FILE.
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

const stdin = await readStdin();
const promptFile = process.env.MOTIR_PROMPT_FILE ?? null;
appendFileSync(
  LOG,
  JSON.stringify({
    cwd: process.cwd(),
    stdin,
    promptFile,
    promptFromFile: promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null,
    argv: process.argv.slice(2),
  }) + '\\n',
);

const plan = existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, 'utf8')) : { steps: [] };
const index = readFileSync(LOG, 'utf8').trim().split('\\n').length - 1;
const steps = plan.steps ?? [];
const step = steps[index] ?? steps[steps.length - 1] ?? {};

if (step.create) mkdirSync(join(process.cwd(), step.create), { recursive: true });

if (step.integrate) {
  const repo = process.cwd();
  // The branch comes from the PROMPT, exactly as a real agent reads it out of
  // the GIT WORKFLOW section — never from the test's own knowledge.
  const branch = (stdin.match(/motir\\/auto-[0-9]{8}-[0-9]{6}/) ?? [])[0];
  if (!branch) {
    process.stderr.write('fake-agent: no session branch in the prompt\\n');
    process.exit(9);
  }
  const git = (...args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (res.status !== 0) {
      process.stderr.write('fake-agent git ' + args.join(' ') + ': ' + (res.stderr || '') + '\\n');
    }
    return res;
  };
  git('fetch', 'origin');
  git('checkout', '-B', branch, 'origin/' + branch);
  writeFileSync(join(repo, step.integrate.file), 'work by the fake agent\\n');
  git('add', step.integrate.file);
  git('commit', '-m', 'feat: ' + step.integrate.file);
  git('push', 'origin', branch);
}

process.exit(step.exit ?? 0);
`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);
  writeFileSync(planPath, JSON.stringify({ steps: [{ exit: 0 }] }));

  return {
    command: `${process.execPath} ${script}`,
    invocations: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as AgentInvocation)
        : [],
    script: (steps) => writeFileSync(planPath, JSON.stringify({ steps })),
  };
}

// ── the fake `gh` ───────────────────────────────────────────────────────────

export interface GhInvocation {
  args: string[];
  cwd: string;
}

export interface FakeGh {
  /** Every `gh` call the CLI made, in order. */
  invocations(): GhInvocation[];
  /** Just the `gh pr create` calls, parsed into their flags. */
  pullRequests(): { head: string; base: string; title: string; body: string; cwd: string }[];
}

/**
 * Install a fake `gh` on the workspace's PATH.
 *
 * `motir auto` opens the session pull request by shelling out to `gh` (git.ts).
 * A CI runner has no authenticated `gh`, and a test must never open a real pull
 * request — so this records the invocation and answers as GitHub would: no open
 * PR for a fresh branch (`pr list` prints nothing), a URL from `pr create`.
 * Recording is what lets the suite assert ONE pull request per touched repo, its
 * title and body, and — the no-auto-merge invariant — that `pr merge` was never
 * called at all.
 */
export function installFakeGh(binDir: string): FakeGh {
  mkdirSync(binDir, { recursive: true });
  const logPath = join(binDir, 'gh-log.jsonl');
  const script = join(binDir, 'gh');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
// \`gh pr list --head <branch> …\` → nothing open yet (exit 0, empty stdout).
if (args[0] === 'pr' && args[1] === 'list') process.exit(0);
if (args[0] === 'pr' && args[1] === 'create') {
  const head = args[args.indexOf('--head') + 1] ?? 'branch';
  process.stdout.write('https://github.test/motir/pull/1?head=' + head + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unsupported command ' + args.join(' ') + '\\n');
process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);

  const invocations = (): GhInvocation[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as GhInvocation)
      : [];

  return {
    invocations,
    pullRequests: () =>
      invocations()
        .filter((call) => call.args[0] === 'pr' && call.args[1] === 'create')
        .map((call) => ({
          head: valueOf(call.args, '--head'),
          base: valueOf(call.args, '--base'),
          title: valueOf(call.args, '--title'),
          body: valueOf(call.args, '--body'),
          cwd: call.cwd,
        })),
  };
}

function valueOf(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

// ── git checkouts ───────────────────────────────────────────────────────────

/** Run git in `cwd`, throwing on failure (a broken fixture must not read as a
 *  CLI bug). */
export function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, env: gitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Motir Test',
    GIT_AUTHOR_EMAIL: 'test@motir.invalid',
    GIT_COMMITTER_NAME: 'Motir Test',
    GIT_COMMITTER_EMAIL: 'test@motir.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

export interface LocalRepo {
  /** The working checkout — where the CLI routes the agent. */
  path: string;
  /** The bare repo standing in for `origin`. */
  originPath: string;
  /** The commit `main` points at on origin, for the no-auto-merge assertion. */
  originMain(): string;
  /** Whether a branch exists on origin. */
  hasBranchOnOrigin(branch: string): boolean;
}

/**
 * Create `<root>/<name>` as a real git checkout of a real (bare, on-disk)
 * `origin`.
 *
 * Real git, not a stub: `motir auto` creates the session branch by pushing
 * `origin/main` to a new ref, the fake agent commits and pushes onto it, and the
 * close-out pushes anything left — assertions about that are only worth
 * anything against a genuine repository.
 */
export function makeLocalRepo(root: string, name: string): LocalRepo {
  const originPath = join(root, '.origins', `${name}.git`);
  const path = join(root, name);
  mkdirSync(dirname(originPath), { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', originPath);
  git(root, 'clone', originPath, path);
  writeFileSync(join(path, 'README.md'), `# ${name}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', 'chore: initial commit');
  git(path, 'push', 'origin', 'main');
  return {
    path,
    originPath,
    originMain: () => git(originPath, 'rev-parse', 'refs/heads/main'),
    hasBranchOnOrigin: (branch) => {
      const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: originPath,
        encoding: 'utf8',
        env: gitEnv(),
      });
      return res.status === 0;
    },
  };
}

/** Write a `.motir.json` by hand — for the cases that need a link the CLI's own
 *  `motir link` cannot make (a stale project, a repo override). */
export function writeLinkFile(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, '.motir.json'), JSON.stringify(config, null, 2) + '\n');
}

/** Read a workspace's `.motir.json` back. */
export function readLinkFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.motir.json'), 'utf8')) as Record<string, unknown>;
}
