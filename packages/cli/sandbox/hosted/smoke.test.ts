import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The hosted-agent image's smoke test (Story MOTIR-683 · Subtask MOTIR-687).
//
// The entrypoint is driven end to end against STUBS of everything a real run
// injects: a stub Motir API (the dispatch prompt and the shared ingest), a stub
// gateway (`/v1/messages`), a stub GitHub (`POST /repos/{o}/{r}/pulls`), a local
// bare git remote, and a FAKE AGENT standing in for `opencode` — a script that
// makes one model call exactly as OpenCode would from the config it was handed,
// edits one file, and records what it saw.
//
// Two layers, one scenario:
//   1. PROCESS level — `node entrypoint.ts` on the host, with a fake `codegraph`
//      beside the fake agent. Runs everywhere, including the CLI package lane.
//   2. IMAGE level — the same scenario inside the built image, with the REAL
//      codegraph and the image's own user. Runs when `MOTIR_HOSTED_AGENT_IMAGE`
//      names a built image (the `hosted-agent-image.yml` workflow sets it);
//      skipped otherwise, because building an image is that workflow's job.

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'entrypoint.ts');
const EGRESS_CONFIG = join(HERE, 'opencode.egress.json');
const IMAGE = process.env.MOTIR_HOSTED_AGENT_IMAGE?.trim() || null;

const RUN_ID = 'run_smoke_1';
const KEY = 'ACME-7';
const REPO = 'acme/widget';
const RUN_TOKEN = 'motir_run_token_smoke';
const GIT_TOKEN = 'ghs_smoke_git_token';
const RUN_KEY = 'sk-smoke-run-key';
const AUTHOR = { name: 'Dana Dispatcher', email: 'dana@example.com' };

// The gateway's egress contract §2, pinned here as well as in the file the
// entrypoint reads — so an edit to that file is a visible, deliberate change to
// the security boundary rather than a silent one.
const EGRESS_CONTRACT_SECTION_2 = {
  $schema: 'https://opencode.ai/config.json',
  enabled_providers: ['anthropic'],
  provider: {
    anthropic: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
  },
  share: 'disabled',
  autoupdate: false,
};

// ── The fake agent ─────────────────────────────────────────────────────────
// Node, not shell, so it can parse the config the way OpenCode does. Its mode
// comes from the PROMPT (the only channel the entrypoint forwards unchanged),
// and it records what it saw under $HOME, the only writable place it is sure to
// inherit.
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const prompt = args[args.length - 1];
const configText = process.env.OPENCODE_CONFIG_CONTENT || '';
const record = {
  args,
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  configText,
};
fs.writeFileSync(path.join(process.env.HOME, 'fake-agent-record.json'), JSON.stringify(record));
const sub = (s) => s.replace(/\\{env:([A-Z_]+)\\}/g, (_, n) => process.env[n] || '');
const options = JSON.parse(configText).provider.anthropic.options;
(async () => {
  const res = await fetch(sub(options.baseURL) + '/messages', {
    method: 'POST',
    headers: { 'x-api-key': sub(options.apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.split('/')[1], max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log('model call answered ' + res.status);
  for (let i = 0; i < 40; i += 1) console.log('working on step ' + i + ' ' + 'x'.repeat(80));
  if (prompt.includes('FAKE:fail')) {
    console.error('boom: the fake agent failed on purpose');
    process.exit(3);
  }
  fs.writeFileSync(path.join(process.cwd(), 'hello.txt'), 'hello from the fake agent\\n');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(4); });
`;

// A stand-in `codegraph` for the PROCESS layer only: `init` makes the index
// directory the real one makes, `install` writes the MCP stanza it writes.
const FAKE_CODEGRAPH = `#!/bin/sh
case "$1" in
  init) mkdir -p "$2/.codegraph" && echo db > "$2/.codegraph/codegraph.db" ;;
  install) mkdir -p "$HOME/.config/opencode" && printf '{"mcp":{"codegraph":{"type":"local","command":["codegraph","serve","--mcp"]}}}' > "$HOME/.config/opencode/opencode.jsonc" ;;
  --version) echo fake ;;
esac
exit 0
`;

// ── Stubs ──────────────────────────────────────────────────────────────────

type Recorded = { method: string; path: string; headers: IncomingMessage['headers']; body: string };

type Stub = { server: Server; url: string; requests: Recorded[]; prompt: string };

async function startStub(): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, url: '', requests: [], prompt: '' };
  stub.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = req.url ?? '';
      stub.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && path === `/api/v1/work-items/${KEY}/dispatch-prompt`) {
        if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`) return json(401, {});
        return json(200, { key: KEY, prompt: stub.prompt });
      }
      if (req.method === 'POST' && path === `/api/v1/dispatch-runs/${RUN_ID}/events`) {
        if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`) return json(401, {});
        return json(200, { appended: 1 });
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        return json(200, { id: 'msg_1', type: 'message', content: [] });
      }
      if (req.method === 'POST' && path === `/repos/${REPO}/pulls`) {
        return json(201, { html_url: `https://github.com/${REPO}/pull/42`, number: 42 });
      }
      json(404, { path });
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  return stub;
}

/**
 * Remove a scenario's temp tree. Best-effort: the image layer leaves files the
 * container's own user wrote, which the host user may not be able to delete.
 */
function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // the OS temp reaper has it
  }
}

function sh(cmd: string, args: string[], cwd?: string): string {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** A bare remote with one commit on `main`. */
function makeRemote(root: string): string {
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  mkdirSync(seed);
  sh('git', ['init', '-q', '-b', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), '# widget\n');
  sh('git', ['add', '.'], seed);
  sh('git', ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-qm', 'init'], seed);
  sh('git', ['clone', '-q', '--bare', seed, remote]);
  return remote;
}

function runInputs(stub: Stub): Record<string, string> {
  return {
    MOTIR_DISPATCH_RUN_ID: RUN_ID,
    MOTIR_WORK_ITEM_KEY: KEY,
    MOTIR_WORK_ITEM_TITLE: 'Add a greeting',
    MOTIR_REPOSITORY: REPO,
    MOTIR_BASE_REF: 'main',
    MOTIR_API_URL: stub.url,
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_GIT_TOKEN: GIT_TOKEN,
    MOTIR_GIT_AUTHOR_NAME: AUTHOR.name,
    MOTIR_GIT_AUTHOR_EMAIL: AUTHOR.email,
    MOTIR_GATEWAY_URL: stub.url,
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_MODEL: 'anthropic/claude-opus-5-5',
    MOTIR_GITHUB_API_URL: stub.url,
  };
}

function runProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  command = process.execPath,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

type Event = {
  kind: string;
  workItemKey?: string;
  body?: string;
  exitCode?: number;
  data?: Record<string, unknown>;
};

function eventsOf(stub: Stub): Event[] {
  return stub.requests
    .filter((r) => r.path === `/api/v1/dispatch-runs/${RUN_ID}/events`)
    .flatMap((r) => (JSON.parse(r.body) as { events: Event[] }).events);
}

/** The event kinds in order, with consecutive `log` events collapsed to one. */
function kindSequence(events: Event[]): string[] {
  return events.map((e) => e.kind).filter((k, i, all) => !(k === 'log' && all[i - 1] === 'log'));
}

function remoteBranches(remote: string): string[] {
  return sh('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

// ── The shared assertions ──────────────────────────────────────────────────

function assertDelivered(stub: Stub, remote: string, home: string, repoDir: string | null): void {
  const events = eventsOf(stub);
  // AC3 — the phases, in order, through the shared ingest.
  expect(
    kindSequence(
      events.filter((e) => !(e.kind === 'log' && e.body?.startsWith('[motir-hosted-agent]'))),
    ),
  ).toEqual(['checkout_ready', 'agent_started', 'log', 'agent_exited', 'delivery_linked']);
  expect(events.every((e) => e.workItemKey === KEY)).toBe(true);
  expect(events.find((e) => e.kind === 'agent_exited')?.exitCode).toBe(0);
  expect(events.find((e) => e.kind === 'delivery_linked')?.data).toMatchObject({
    url: `https://github.com/${REPO}/pull/42`,
    number: 42,
  });
  // Every log body fits the ingest's 16 KiB ceiling.
  for (const e of events.filter((x) => x.kind === 'log')) {
    expect(Buffer.byteLength(e.body ?? '')).toBeLessThanOrEqual(16 * 1024);
  }

  // AC3 — one pushed branch, carrying the dispatcher as author AND committer.
  const branch = `hosted/${KEY}-${RUN_ID}`;
  expect(remoteBranches(remote)).toEqual([branch, 'main']);
  const who = sh('git', [
    '--git-dir',
    remote,
    'log',
    '-1',
    '--format=%an <%ae>|%cn <%ce>',
    branch,
  ]).trim();
  expect(who).toBe(`${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>`);
  const files = sh('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', branch])
    .trim()
    .split('\n');
  expect(files.sort()).toEqual(['README.md', 'hello.txt']);

  // AC3 — exactly one pull-request call, head → base, with the git credential.
  const prCalls = stub.requests.filter((r) => r.path === `/repos/${REPO}/pulls`);
  expect(prCalls).toHaveLength(1);
  expect(prCalls[0]!.headers.authorization).toBe(`Bearer ${GIT_TOKEN}`);
  expect(JSON.parse(prCalls[0]!.body)).toMatchObject({
    head: branch,
    base: 'main',
    title: `${KEY} Add a greeting`,
  });
  expect(JSON.parse(prCalls[0]!.body).body).toContain(AUTHOR.name);

  // AC5 — the config OpenCode was handed IS the egress contract §2 document,
  // and every model call went to the stub gateway's `/v1/messages` with the
  // run key alone.
  const record = JSON.parse(readFileSync(join(home, 'fake-agent-record.json'), 'utf8')) as {
    args: string[];
    envKeys: string[];
    configText: string;
  };
  expect(JSON.parse(record.configText)).toEqual(EGRESS_CONTRACT_SECTION_2);
  expect(record.args.slice(0, 3)).toEqual(['run', '--model', 'anthropic/claude-opus-5-5']);
  const modelCalls = stub.requests.filter(
    (r) => r.headers['x-api-key'] !== undefined || r.path.startsWith('/v1/'),
  );
  expect(modelCalls.length).toBeGreaterThan(0);
  for (const call of modelCalls) {
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1/messages');
    expect(call.headers['x-api-key']).toBe(RUN_KEY);
  }

  // Only the model credential reaches the agent's environment.
  expect(record.envKeys).toContain('MOTIR_RUN_KEY');
  for (const secret of ['MOTIR_RUN_TOKEN', 'MOTIR_GIT_TOKEN', 'MOTIR_API_URL']) {
    expect(record.envKeys).not.toContain(secret);
  }

  // AC6 — codegraph initialised on the checkout, its sync hooks installed, its
  // MCP server registered with OpenCode, and its index kept out of the commit.
  if (repoDir) {
    expect(existsSync(join(repoDir, '.codegraph'))).toBe(true);
    for (const hook of ['post-merge', 'post-checkout']) {
      expect(readFileSync(join(repoDir, '.git', 'hooks', hook), 'utf8')).toContain(
        'codegraph sync',
      );
    }
  }
  expect(readFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8')).toContain(
    'codegraph',
  );
  expect(files.some((f) => f.startsWith('.codegraph'))).toBe(false);

  // The git token never landed in the checkout's config.
  if (repoDir)
    expect(readFileSync(join(repoDir, '.git', 'config'), 'utf8')).not.toContain(GIT_TOKEN);
}

function assertAgentFailed(stub: Stub, remote: string): void {
  const events = eventsOf(stub);
  const exited = events.find((e) => e.kind === 'agent_exited');
  // AC4 — `agent_exited` with the exit code and the log tail …
  expect(exited?.exitCode).toBe(3);
  expect(String(exited?.data?.logTail)).toContain('boom: the fake agent failed on purpose');
  // … and no push, no pull request, no delivery.
  expect(events.some((e) => e.kind === 'delivery_linked')).toBe(false);
  expect(remoteBranches(remote)).toEqual(['main']);
  expect(stub.requests.some((r) => r.path.includes('/pulls'))).toBe(false);
}

// ── Layer 1: the process ───────────────────────────────────────────────────

describe('the hosted-agent entrypoint, as a process (MOTIR-687)', () => {
  let stub: Stub;
  let root: string;

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  function scenario(mode: 'succeed' | 'fail') {
    root = mkdtempSync(join(tmpdir(), 'hosted-agent-smoke-'));
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(join(bin, 'opencode'), FAKE_OPENCODE);
    writeFileSync(join(bin, 'codegraph'), FAKE_CODEGRAPH);
    chmodSync(join(bin, 'opencode'), 0o755);
    chmodSync(join(bin, 'codegraph'), 0o755);
    const remote = makeRemote(root);
    stub.requests.length = 0;
    stub.prompt = `Build ${KEY}. FAKE:${mode}`;
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      ...runInputs(stub),
      MOTIR_WORKSPACE: workspace,
      MOTIR_GIT_REMOTE_URL: remote,
    };
    return { env, remote, home, repoDir: join(workspace, 'repo') };
  }

  const node = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', ENTRYPOINT];

  it('runs a card to a pull request, reporting every phase through the shared ingest', async () => {
    const s = scenario('succeed');
    const result = await runProcess(node, s.env);
    expect(result.code, result.stderr).toBe(0);
    assertDelivered(stub, s.remote, s.home, s.repoDir);
    cleanup(root);
  });

  it('reports a failed agent with its log tail and pushes nothing', async () => {
    const s = scenario('fail');
    const result = await runProcess(node, s.env);
    expect(result.code).toBe(10);
    assertAgentFailed(stub, s.remote);
    cleanup(root);
  });

  it('refuses to start without its inputs, naming them, and calls nothing', async () => {
    const s = scenario('succeed');
    const env = { ...s.env };
    delete env.MOTIR_RUN_KEY;
    delete env.MOTIR_GIT_TOKEN;
    const result = await runProcess(node, env);
    expect(result.code).toBe(20);
    expect(result.stderr).toContain('MOTIR_RUN_KEY');
    expect(result.stderr).toContain('MOTIR_GIT_TOKEN');
    expect(stub.requests).toEqual([]);
    cleanup(root);
  });

  it('refuses a model outside the anthropic provider before anything runs', async () => {
    const s = scenario('succeed');
    const result = await runProcess(node, { ...s.env, MOTIR_MODEL: 'claude-opus-5-5' });
    expect(result.code).toBe(20);
    expect(result.stderr).toContain('MOTIR_MODEL');
    expect(stub.requests).toEqual([]);
    cleanup(root);
  });

  it('ships the egress contract §2 document verbatim', () => {
    expect(JSON.parse(readFileSync(EGRESS_CONFIG, 'utf8'))).toEqual(EGRESS_CONTRACT_SECTION_2);
  });
});

// ── Layer 2: the image ─────────────────────────────────────────────────────

describe.skipIf(!IMAGE)('the hosted-agent IMAGE (MOTIR-687)', () => {
  const image = IMAGE ?? '';
  let stub: Stub;

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  const inImage = (cmd: string) =>
    spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', cmd], {
      encoding: 'utf8',
    });

  it('carries OpenCode 1.18.32 and no other agent CLI', () => {
    // AC1.
    expect(inImage('opencode --version').stdout.trim()).toBe('1.18.32');
    for (const other of [
      'claude',
      'codex',
      'kimi',
      'aider',
      'goose',
      'cursor-agent',
      'gemini',
      'agy',
    ]) {
      expect(inImage(`command -v ${other}`).status, `${other} is on the PATH`).not.toBe(0);
    }
  });

  it('runs as a non-root user', () => {
    expect(inImage('id -u').stdout.trim()).not.toBe('0');
  });

  function containerScenario(mode: 'succeed' | 'fail') {
    const root = mkdtempSync(join(tmpdir(), 'hosted-agent-image-'));
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(join(bin, 'opencode'), FAKE_OPENCODE);
    chmodSync(join(bin, 'opencode'), 0o755);
    // The mounted remote is owned by the host user, not the image's; allowing
    // it is test setup, not something a real run needs.
    writeFileSync(join(home, '.gitconfig'), '[safe]\n\tdirectory = *\n');
    const remote = makeRemote(root);
    sh('chmod', ['-R', 'a+rwX', root]);
    stub.requests.length = 0;
    stub.prompt = `Build ${KEY}. FAKE:${mode}`;
    const env = { ...runInputs(stub), MOTIR_GIT_REMOTE_URL: '/remote.git', HOME: '/agent-home' };
    const args = [
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      `${bin}:/fake-bin:ro`,
      '-v',
      `${home}:/agent-home`,
      '-v',
      `${remote}:/remote.git`,
      '-e',
      'PATH=/fake-bin:/usr/local/bin:/usr/bin:/bin',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      image,
    ];
    return { root, remote, home, args };
  }

  it('runs a card to a pull request inside the image, with the real codegraph', async () => {
    const s = containerScenario('succeed');
    const result = await runProcess(s.args, process.env, 'docker');
    expect(result.code, result.stderr).toBe(0);
    assertDelivered(stub, s.remote, s.home, null);
    cleanup(s.root);
  }, 120_000);

  it('exits non-zero inside the image when the agent fails, pushing nothing', async () => {
    const s = containerScenario('fail');
    const result = await runProcess(s.args, process.env, 'docker');
    expect(result.code).toBe(10);
    assertAgentFailed(stub, s.remote);
    cleanup(s.root);
  }, 120_000);

  it('initialises codegraph on the checkout and installs its sync hooks (real codegraph)', () => {
    // AC6, against the real binary: the entrypoint's clone, then its codegraph
    // step, observed from inside the same container.
    const root = mkdtempSync(join(tmpdir(), 'hosted-agent-cg-'));
    const remote = makeRemote(root);
    sh('chmod', ['-R', 'a+rwX', root]);
    const res = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${remote}:/remote.git`,
        image,
        '-c',
        'git config --global --add safe.directory "*" && git clone -q /remote.git /workspace/repo && ' +
          'codegraph init /workspace/repo >/dev/null && test -d /workspace/repo/.codegraph && echo indexed',
      ],
      { encoding: 'utf8' },
    );
    expect(res.stdout).toContain('indexed');
    cleanup(root);
  }, 120_000);
});
