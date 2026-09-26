// The HOSTED AGENT's one-shot entrypoint (Story MOTIR-683 · Subtask MOTIR-687).
//
// One run, one process, one exit — the opposite of the local sandbox's
// long-lived shell. Handed ONE dispatch run's inputs as environment, it:
//
//   1. reads and validates those inputs;
//   2. fetches the card's dispatch prompt with the RUN credential;
//   3. clones the repository with the GIT credential;
//   4. initialises codegraph on the checkout, installs its sync hooks and
//      registers its MCP server in OpenCode's global config;
//   5. hands OpenCode the gateway's egress-contract config (§2) — and nothing
//      else — as `OPENCODE_CONFIG_CONTENT`;
//   6. runs `opencode run` headless on the chosen model;
//   7. on exit 0 with changes: commits as the dispatcher, pushes a branch named
//      for the card and the run, and opens the pull request;
//   8. reports every phase to the SHARED ingest a local run uses
//      (`POST /api/v1/dispatch-runs/{id}/events`), so the run panel is one panel;
//   9. exits with a code the end path reads (EXIT below).
//
// It runs with Node's own type stripping (`node entrypoint.ts`) and imports
// nothing but `node:` builtins, so the image carries no build step and no
// dependency tree of its own.
//
// ── The vocabulary is the SHARED one (docs/decisions/hosted-agent-run.md §2) ─
// `checkout_ready`, `agent_started`, `log`, `agent_exited`, `delivery_linked` —
// the kinds a local run already emits. `run_opened` is the start path's and
// `run_closed` is the end path's; neither is written here, and nothing here
// invents a kind.
//
// ── Only the MODEL credential reaches the agent ─────────────────────────────
// The container holds three credentials (§3–§4 of the decision): the run token
// (Motir), the git token (GitHub) and the run key (the gateway). OpenCode needs
// exactly one of them. The agent is spawned with an ALLOW-LISTED environment
// (AGENT_ENV_KEYS) — so the run token and the git token are not in its
// environment, and git is authenticated per command with an `http.extraHeader`
// that is never written to `.git/config`. That narrows what a confused or
// hostile agent can pick up by reading its own environment or the checkout;
// it is not a privilege boundary (both run as the same user), and the egress
// contract's §4 says plainly that the lock is the credential's own scope.

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the end path reads from the container's exit status. */
const EXIT = {
  /** The agent exited 0, its changes were pushed and the pull request opened. */
  delivered: 0,
  /** The agent exited non-zero (or was killed). No push, no pull request. */
  agentFailed: 10,
  /** The agent exited 0 and changed nothing. No push, no pull request. */
  noChanges: 11,
  /** A required input was missing or malformed, or a setup step failed. */
  setupFailed: 20,
  /** The agent's work could not be committed, pushed or opened as a pull request. */
  deliveryFailed: 21,
} as const;

/**
 * The ONLY environment the agent process receives. Everything else — the run
 * token, the git token, the Motir API URL — stays with this process.
 */
const AGENT_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'MOTIR_GATEWAY_URL',
  'MOTIR_RUN_KEY',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_DISABLE_AUTOUPDATE',
  'OPENCODE_DISABLE_MODELS_FETCH',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'CODEGRAPH_TELEMETRY',
] as const;

/** Bytes of agent output that accumulate before one `log` event is sent. */
const LOG_CHUNK_BYTES = 4096;
/** How often a partial log chunk is sent anyway, so the panel and the stall watchdog see progress. */
const LOG_FLUSH_MS = 5000;
/** The ingest accepts at most 200 events per append. */
const MAX_EVENTS_PER_APPEND = 200;
/** How much of the agent's output `agent_exited` carries when it failed. */
const LOG_TAIL_CHARS = 4000;
/**
 * A prompt longer than this is attached as a file rather than passed as an
 * argument — Linux refuses a single argv string past 128 KiB (MAX_ARG_STRLEN).
 */
const MAX_ARGV_PROMPT_BYTES = 100 * 1024;

const CODEGRAPH_HOOK_MARKER = 'motir-hosted-agent codegraph sync hook';

const HERE = dirname(fileURLToPath(import.meta.url));

type Inputs = {
  runId: string;
  workItemKey: string;
  workItemTitle: string | null;
  repository: string;
  baseRef: string;
  apiUrl: string;
  runToken: string;
  gitToken: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  gatewayUrl: string;
  runKey: string;
  model: string;
  workspace: string;
  remoteUrl: string;
  githubApiUrl: string;
};

type RunEvent = {
  kind: 'checkout_ready' | 'agent_started' | 'log' | 'agent_exited' | 'delivery_linked';
  workItemKey?: string;
  data?: unknown;
  body?: string;
  exitCode?: number;
};

class StageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── Inputs ────────────────────────────────────────────────────────────────

function required(name: string, problems: string[]): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') problems.push(name);
  return value;
}

/** Read and validate every input, naming ALL the missing ones at once. */
function readInputs(): Inputs {
  const problems: string[] = [];
  const inputs: Inputs = {
    runId: required('MOTIR_DISPATCH_RUN_ID', problems),
    workItemKey: required('MOTIR_WORK_ITEM_KEY', problems),
    workItemTitle: process.env.MOTIR_WORK_ITEM_TITLE?.trim() || null,
    repository: required('MOTIR_REPOSITORY', problems),
    baseRef: required('MOTIR_BASE_REF', problems),
    apiUrl: required('MOTIR_API_URL', problems).replace(/\/+$/, ''),
    runToken: required('MOTIR_RUN_TOKEN', problems),
    gitToken: required('MOTIR_GIT_TOKEN', problems),
    gitAuthorName: required('MOTIR_GIT_AUTHOR_NAME', problems),
    gitAuthorEmail: required('MOTIR_GIT_AUTHOR_EMAIL', problems),
    gatewayUrl: required('MOTIR_GATEWAY_URL', problems).replace(/\/+$/, ''),
    runKey: required('MOTIR_RUN_KEY', problems),
    model: required('MOTIR_MODEL', problems),
    workspace: process.env.MOTIR_WORKSPACE?.trim() || '/workspace',
    remoteUrl: '',
    githubApiUrl: (process.env.MOTIR_GITHUB_API_URL?.trim() || 'https://api.github.com').replace(
      /\/+$/,
      '',
    ),
  };
  if (problems.length > 0) {
    throw new StageError(`missing required input(s): ${problems.join(', ')}`, EXIT.setupFailed);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(inputs.repository)) {
    throw new StageError(
      `MOTIR_REPOSITORY must be "owner/name", got "${inputs.repository}"`,
      EXIT.setupFailed,
    );
  }
  // Only the anthropic provider is enabled (egress contract §2), and the start
  // path adds the `anthropic/` prefix to the bare gateway id (decision §7).
  if (!/^anthropic\/[A-Za-z0-9._-]+$/.test(inputs.model)) {
    throw new StageError(
      `MOTIR_MODEL must be "anthropic/<model id>", got "${inputs.model}"`,
      EXIT.setupFailed,
    );
  }
  inputs.remoteUrl =
    process.env.MOTIR_GIT_REMOTE_URL?.trim() || `https://github.com/${inputs.repository}.git`;
  return inputs;
}

// ── Reporting through the shared ingest ───────────────────────────────────

/**
 * Posts events IN ORDER, one append at a time. Reporting observes the run and
 * never changes it: a refused or failed append is written to stderr and the
 * run carries on.
 */
function createReporter(inputs: Inputs) {
  let chain: Promise<void> = Promise.resolve();
  const url = `${inputs.apiUrl}/api/v1/dispatch-runs/${encodeURIComponent(inputs.runId)}/events`;

  const post = async (events: RunEvent[]): Promise<void> => {
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_APPEND) {
      const batch = events.slice(i, i + MAX_EVENTS_PER_APPEND);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${inputs.runToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ events: batch }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          process.stderr.write(
            `motir-hosted-agent: the ingest refused ${batch.length} event(s): ${res.status} ${text.slice(0, 500)}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `motir-hosted-agent: could not reach the ingest: ${(err as Error).message}\n`,
        );
      }
    }
  };

  return {
    /** Queue events behind every earlier one. */
    send(events: RunEvent[]): Promise<void> {
      const stamped = events.map((e) => ({ ...e, workItemKey: inputs.workItemKey }));
      chain = chain.then(() => post(stamped));
      return chain;
    },
    /** Resolve once everything queued so far has been attempted. */
    drain(): Promise<void> {
      return chain;
    },
  };
}

type Reporter = ReturnType<typeof createReporter>;

/**
 * The `log` producer: accumulates the agent's output into chunks of at most
 * LOG_CHUNK_BYTES, sends a chunk when it fills, and sends whatever is pending
 * every LOG_FLUSH_MS so a quiet-but-alive agent still shows progress.
 */
function createLogTee(reporter: Reporter) {
  let buffer = '';
  let tail = '';
  const emit = (): void => {
    if (buffer === '') return;
    const bodies: string[] = [];
    // ≤ 4096 chars is ≤ 16 KiB of UTF-8 — the ingest's own body ceiling.
    for (let i = 0; i < buffer.length; i += LOG_CHUNK_BYTES) {
      bodies.push(buffer.slice(i, i + LOG_CHUNK_BYTES));
    }
    buffer = '';
    void reporter.send(bodies.map((body) => ({ kind: 'log' as const, body })));
  };
  const timer = setInterval(emit, LOG_FLUSH_MS);
  timer.unref();
  return {
    write(chunk: string): void {
      buffer += chunk;
      tail = (tail + chunk).slice(-LOG_TAIL_CHARS);
      if (Buffer.byteLength(buffer) >= LOG_CHUNK_BYTES) emit();
    },
    /** Send what is left. Call once, before `agent_exited`. */
    flush(): void {
      clearInterval(timer);
      emit();
    },
    tail(): string {
      return tail;
    },
  };
}

/** A run-level `log` line — the one-line account of a step that is not the agent's own output. */
function note(reporter: Reporter, line: string): Promise<void> {
  process.stderr.write(`motir-hosted-agent: ${line}\n`);
  return reporter.send([{ kind: 'log', body: `[motir-hosted-agent] ${line}\n` }]);
}

// ── Git ───────────────────────────────────────────────────────────────────

/**
 * The GitHub credential as a per-command header. Never written to
 * `.git/config`, never in the remote URL, never in the agent's environment.
 */
function gitAuthArgs(inputs: Inputs): string[] {
  const basic = Buffer.from(`x-access-token:${inputs.gitToken}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

function git(args: string[], cwd: string, what: string, exitCode: number): string {
  const res: SpawnSyncReturns<string> = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0) {
    // The header is an argument, not output — git never echoes it — so the
    // message below cannot carry the token.
    throw new StageError(
      `${what} failed (git exit ${res.status ?? res.signal}): ${(res.stderr || res.stdout).trim().slice(-2000)}`,
      exitCode,
    );
  }
  return res.stdout;
}

// ── Codegraph ─────────────────────────────────────────────────────────────

function codegraphHookBody(): string {
  return [
    '#!/bin/sh',
    `# ${CODEGRAPH_HOOK_MARKER}`,
    'command -v codegraph >/dev/null 2>&1 || exit 0',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    '[ -d "$root/.codegraph" ] && codegraph sync --quiet "$root" >/dev/null 2>&1',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Index the checkout, keep the index fresh as the branch moves, and give
 * OpenCode the codegraph MCP server. Best-effort: an agent without a code map
 * is slower, not wrong, so a failure here is reported and the run continues.
 */
async function setUpCodegraph(repoDir: string, reporter: Reporter): Promise<void> {
  const env = { ...process.env, CODEGRAPH_TELEMETRY: '0' };
  const init = spawnSync('codegraph', ['init', repoDir], { cwd: repoDir, encoding: 'utf8', env });
  if (init.error || init.status !== 0) {
    await note(
      reporter,
      `codegraph init failed — the agent runs without a code graph (${init.error?.message ?? (init.stderr || '').trim().slice(-500)})`,
    );
    return;
  }
  const hooks = join(repoDir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['post-merge', 'post-checkout']) {
    const path = join(hooks, hook);
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(CODEGRAPH_HOOK_MARKER)) continue;
    writeFileSync(path, codegraphHookBody());
    chmodSync(path, 0o755);
  }
  const install = spawnSync(
    'codegraph',
    ['install', '--target', 'opencode', '--location', 'global', '--yes'],
    { cwd: repoDir, encoding: 'utf8', env },
  );
  if (install.error || install.status !== 0) {
    await note(reporter, 'could not register the codegraph MCP server with OpenCode');
  }
}

// ── The agent ─────────────────────────────────────────────────────────────

/** The egress contract §2 document, verbatim (`opencode.egress.json`). */
function egressConfig(): string {
  return readFileSync(join(HERE, 'opencode.egress.json'), 'utf8');
}

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runAgent(
  inputs: Inputs,
  prompt: string,
  repoDir: string,
  tee: ReturnType<typeof createLogTee>,
): Promise<{ exitCode: number; signal: string | null }> {
  const args = ['run', '--model', inputs.model, '--auto'];
  if (Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES) {
    const file = join(inputs.workspace, 'motir-dispatch-prompt.md');
    writeFileSync(file, prompt);
    args.push('--file', file, 'Carry out the task described in the attached file.');
  } else {
    args.push(prompt);
  }
  return new Promise((resolve) => {
    const child = spawn('opencode', args, {
      cwd: repoDir,
      env: agentEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      tee.write(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      tee.write(`[motir-hosted-agent] could not start opencode: ${err.message}\n`);
    });
    child.on('close', (code, signal) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve({ exitCode: code ?? 128, signal: signal ?? null });
    });
  });
}

// ── Delivery ──────────────────────────────────────────────────────────────

function branchName(inputs: Inputs): string {
  const safeRun = inputs.runId.replace(/[^A-Za-z0-9_-]/g, '');
  return `hosted/${inputs.workItemKey}-${safeRun}`;
}

/** Commit any remaining work as the dispatcher, push, and open the pull request. */
async function deliver(
  inputs: Inputs,
  repoDir: string,
): Promise<{ url: string; number: number; branch: string } | null> {
  const fail = EXIT.deliveryFailed;
  const dirty = git(['status', '--porcelain'], repoDir, 'git status', fail).trim() !== '';
  if (dirty) {
    git(['add', '--all'], repoDir, 'git add', fail);
    const subject = inputs.workItemTitle
      ? `${inputs.workItemKey} ${inputs.workItemTitle}`
      : `${inputs.workItemKey}: changes from hosted run ${inputs.runId}`;
    git(
      ['commit', '--no-verify', '-m', subject, '-m', `Hosted run ${inputs.runId} (Motir).`],
      repoDir,
      'git commit',
      fail,
    );
  }
  const ahead = git(
    ['rev-list', '--count', `origin/${inputs.baseRef}..HEAD`],
    repoDir,
    'git rev-list',
    fail,
  ).trim();
  if (ahead === '0') return null;

  const branch = branchName(inputs);
  git(
    [...gitAuthArgs(inputs), 'push', 'origin', `HEAD:refs/heads/${branch}`],
    repoDir,
    'git push',
    fail,
  );

  const firstSubject = git(
    ['log', '--reverse', '--format=%s', `origin/${inputs.baseRef}..HEAD`],
    repoDir,
    'git log',
    fail,
  )
    .split('\n')[0]
    ?.trim();
  const title = inputs.workItemTitle
    ? `${inputs.workItemKey} ${inputs.workItemTitle}`
    : firstSubject || `${inputs.workItemKey}: changes from hosted run`;
  const body = [
    `Delivers **${inputs.workItemKey}**, built by Motir's hosted agent (OpenCode, \`${inputs.model}\`) in run \`${inputs.runId}\`.`,
    '',
    `Dispatched by ${inputs.gitAuthorName}.`,
  ].join('\n');

  let res: Response;
  try {
    res = await fetch(`${inputs.githubApiUrl}/repos/${inputs.repository}/pulls`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${inputs.gitToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title, head: branch, base: inputs.baseRef, body }),
    });
  } catch (err) {
    throw new StageError(`opening the pull request failed: ${(err as Error).message}`, fail);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new StageError(
      `opening the pull request failed: ${res.status} ${text.slice(0, 500)}`,
      fail,
    );
  }
  const pr = (await res.json()) as { html_url?: string; number?: number };
  if (typeof pr.html_url !== 'string' || typeof pr.number !== 'number') {
    throw new StageError('the pull request response carried no html_url / number', fail);
  }
  return { url: pr.html_url, number: pr.number, branch };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let inputs: Inputs;
  try {
    inputs = readInputs();
  } catch (err) {
    // Nothing to report to: without the run id, the API URL and the run
    // token there is no ingest to address. The container log is the record.
    process.stderr.write(`motir-hosted-agent: ${(err as Error).message}\n`);
    return EXIT.setupFailed;
  }
  const reporter = createReporter(inputs);

  try {
    // 2 · the prompt
    const promptUrl = `${inputs.apiUrl}/api/v1/work-items/${encodeURIComponent(inputs.workItemKey)}/dispatch-prompt`;
    let prompt: string;
    try {
      const res = await fetch(promptUrl, {
        headers: { authorization: `Bearer ${inputs.runToken}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 500)}`);
      const payload = (await res.json()) as { prompt?: unknown };
      if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '') {
        throw new Error('the response carried no prompt');
      }
      prompt = payload.prompt;
    } catch (err) {
      throw new StageError(
        `fetching the dispatch prompt failed: ${(err as Error).message}`,
        EXIT.setupFailed,
      );
    }

    // 3 · the checkout, with the dispatcher as the identity for every commit —
    // the agent's own included.
    mkdirSync(inputs.workspace, { recursive: true });
    const repoDir = join(inputs.workspace, 'repo');
    const home = process.env.HOME ?? inputs.workspace;
    git(
      ['config', '--global', 'user.name', inputs.gitAuthorName],
      home,
      'git config',
      EXIT.setupFailed,
    );
    git(
      ['config', '--global', 'user.email', inputs.gitAuthorEmail],
      home,
      'git config',
      EXIT.setupFailed,
    );
    git(
      [
        ...gitAuthArgs(inputs),
        'clone',
        '--branch',
        inputs.baseRef,
        '--single-branch',
        inputs.remoteUrl,
        repoDir,
      ],
      inputs.workspace,
      'git clone',
      EXIT.setupFailed,
    );

    // The code graph's index lives IN the checkout, so it is excluded from
    // every commit — the pull request must carry the agent's work and nothing
    // the container made to support it.
    const exclude = join(repoDir, '.git', 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, '\n.codegraph/\n');

    // 4 · codegraph
    await setUpCodegraph(repoDir, reporter);
    await reporter.send([
      {
        kind: 'checkout_ready',
        data: { repositories: [inputs.repository], baseRef: inputs.baseRef, failures: 0 },
      },
    ]);

    // 5 · OpenCode's configuration: the egress contract's document, verbatim.
    process.env.OPENCODE_CONFIG_CONTENT = egressConfig();
    process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    process.env.OPENCODE_DISABLE_CLAUDE_CODE = 'true';

    // 6 · the agent
    await reporter.send([
      { kind: 'agent_started', data: { agent: 'opencode', model: inputs.model } },
    ]);
    const tee = createLogTee(reporter);
    const result = await runAgent(inputs, prompt, repoDir, tee);
    tee.flush();
    const failed = result.exitCode !== 0;
    await reporter.send([
      {
        kind: 'agent_exited',
        exitCode: result.exitCode,
        data: {
          model: inputs.model,
          signal: result.signal,
          ...(failed ? { logTail: tee.tail() } : {}),
        },
      },
    ]);
    if (failed) {
      await reporter.drain();
      return EXIT.agentFailed;
    }

    // 7 · delivery
    const delivered = await deliver(inputs, repoDir);
    if (!delivered) {
      await note(reporter, 'the agent exited 0 and changed nothing — no pull request opened');
      await reporter.drain();
      return EXIT.noChanges;
    }
    await reporter.send([
      {
        kind: 'delivery_linked',
        data: { url: delivered.url, number: delivered.number, branch: delivered.branch },
      },
    ]);
    await reporter.drain();
    return EXIT.delivered;
  } catch (err) {
    const code = err instanceof StageError ? err.exitCode : EXIT.setupFailed;
    await note(reporter, (err as Error).message);
    await reporter.drain();
    return code;
  }
}

process.exitCode = await main();
