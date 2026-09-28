import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, readLaunch, REQUIRED_INPUTS, SETUP_FAILED } from './entrypoint.js';

// The hosted-agent image's smoke test (Story MOTIR-683 · MOTIR-687, rewritten
// for the CLI-running image by MOTIR-6560).
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1: the image runs the
// Motir CLI's own `motir run` on the run the server opened. So this drives the
// REAL chain — `node entrypoint.ts` → the real CLI (from source, through tsx) →
// a fake OpenCode — for the three run shapes the decision names, and checks
// each ends in one pull request per repository with the event sequence a local
// run records:
//
//   1. a one-repository LEAF;
//   2. a LEAF that spans two repositories;
//   3. a PARENT with two children in two repositories (a scope run: one session
//      branch per repository, a DRAFT pull request per repository opened at the
//      first child that lands, marked READY at the close-out).
//
// What stands in for what:
//   - a stub MOTIR answering every route the hosted CLI calls, with bodies the
//     CLI's own response validators accept, and recording every request;
//   - LOCAL BARE REMOTES for GitHub. The CLI's hosted git setup keys everything
//     on `https://github.com/<owner>/<name>` — the credential helper and each
//     repository's App-bot identity (`includeIf hasconfig:remote.*.url:…`) —
//     so the clone URLs the stub hands out ARE those URLs, and git's own
//     `url.<bare>.insteadOf https://github.com/<owner>/<name>` redirects the
//     transport to the bare remote. The CLI reads the redirect from
//     `GIT_CONFIG_SYSTEM`; the agent's environment is allow-listed without it,
//     so the fake agent passes the same file with `-c include.path=…` on its
//     push. The remote URL recorded in every checkout stays the GitHub one, so
//     the identity `includeIf` is exercised for real. (A file transport asks
//     no credential; the helper itself is proved by `test/hostedGit.test.ts`.)
//   - a fake `gh` behind the CLI's REAL `gh` shim, which keeps the pull
//     requests in a JSON file and records the token each call was given;
//   - a fake `opencode` that makes one model call exactly as OpenCode would
//     from the egress document it was handed, then commits and pushes in every
//     checkout its prompt names and — on a leaf — opens the pull request;
//   - a fake `codegraph` that makes the index directory the real one makes.
//
// Two layers:
//   1. PROCESS — everything above as processes on the host. Runs everywhere.
//   2. IMAGE — the built image's own contents (the CLI, `gh`, git ≥ 2.36, the
//      pinned OpenCode, codegraph, a non-root user), and the launcher refusing
//      a boot with no inputs. Runs when `MOTIR_HOSTED_AGENT_IMAGE` names a built
//      image (`hosted-agent-image.yml` sets it); skipped otherwise.

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'entrypoint.ts');
const CLI_ROOT = join(HERE, '..', '..');
const CLI_SRC_INDEX = join(CLI_ROOT, 'src', 'index.ts');
const TSX = join(CLI_ROOT, '..', '..', 'node_modules', '.bin', 'tsx');
const IMAGE = process.env.MOTIR_HOSTED_AGENT_IMAGE?.trim() || null;

const RUN_TOKEN = 'mrt_smoke_run_credential';
const RUN_KEY = 'sk-smoke-run-key';
const OWNER = 'usr_dispatcher';
const DISPATCHER = 'Dana Dispatcher';
const MODEL = 'anthropic/claude-smoke-1';

const BOTS: Record<string, { name: string; email: string }> = {
  'acme/app-a': {
    name: 'motir-studio[bot]',
    email: '101+motir-studio[bot]@users.noreply.github.com',
  },
  'acme/app-b': {
    name: 'motir-integration[bot]',
    email: '202+motir-integration[bot]@users.noreply.github.com',
  },
};

// ── The fakes ──────────────────────────────────────────────────────────────

/**
 * The fake OpenCode. Its instructions come from the PROMPT (the one channel the
 * CLI forwards unchanged): `FAKE:closeout` is the close-out's How-to-test agent,
 * which does nothing; otherwise `FAKE:key=`, `FAKE:mode=pr|session` and
 * `FAKE:repos=` say what to change and how to deliver it.
 */
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const fileAt = args.indexOf('--file');
const prompt = fileAt >= 0 ? fs.readFileSync(args[fileAt + 1], 'utf8') : args[args.length - 1];
const configText = process.env.OPENCODE_CONFIG_CONTENT || '';
fs.appendFileSync(path.join(process.env.HOME, 'agent-records.jsonl'), JSON.stringify({
  cwd: process.cwd(),
  model,
  envKeys: Object.keys(process.env).sort(),
  leaksRunToken: Object.values(process.env).some((v) => String(v).includes(${JSON.stringify(RUN_TOKEN)})),
  closeout: prompt.includes('FAKE:closeout'),
}) + '\\n');
if (prompt.includes('FAKE:closeout')) process.exit(0);
const marker = (name) => (new RegExp('FAKE:' + name + '=([^\\\\s]+)').exec(prompt) || [])[1];
const key = marker('key');
const mode = marker('mode');
const repos = (marker('repos') || '').split(',').filter(Boolean);
const redirect = ['-c', 'include.path=' + path.join(process.env.HOME, 'smoke-redirect.gitconfig')];
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sub = (s) => s.replace(/\\{env:([A-Z_]+)\\}/g, (_, n) => process.env[n] || '');
const options = JSON.parse(configText).provider.anthropic.options;
(async () => {
  const res = await fetch(sub(options.baseURL) + '/messages', {
    method: 'POST',
    headers: { 'x-api-key': sub(options.apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.split('/')[1], max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log('model call answered ' + res.status);
  if (prompt.includes('FAKE:fail')) { console.error('boom: the fake agent failed on purpose'); process.exit(3); }
  const root = path.dirname(process.cwd());
  for (const repo of repos) {
    const dir = path.join(root, repo);
    fs.writeFileSync(path.join(dir, key + '.txt'), 'work for ' + key + ' in ' + repo + '\\n');
    if (mode === 'pr') git(dir, 'switch', '-c', 'hosted/' + key);
    // A session run integrates on the run's session branch, as its prompt says.
    if (mode === 'session') {
      const branch = marker('branch');
      git(dir, ...redirect, 'fetch', 'origin', '+refs/heads/' + branch + ':refs/remotes/origin/' + branch);
      git(dir, 'switch', '-C', branch, 'origin/' + branch);
    }
    git(dir, 'add', key + '.txt');
    git(dir, 'commit', '-m', key + ': the change in ' + repo);
    git(dir, ...redirect, 'push', '-u', 'origin', 'HEAD');
    if (mode === 'session') git(dir, ...redirect, 'fetch', 'origin');
    if (mode === 'pr') {
      execFileSync('gh', ['pr', 'create', '--base', 'main', '--title', key + ' in ' + repo, '--body', 'Delivers ' + key + '.'], { cwd: dir, stdio: 'inherit' });
    }
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(4); });
`;

/** The fake `gh`: pull requests kept in $HOME/fake-gh.json, per repository and head. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const store = path.join(process.env.HOME, 'fake-gh.json');
const state = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : { prs: [], calls: [] };
// The RAW remote URL — \`git remote get-url\` would apply the test's insteadOf rewrite.
const origin = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
const repo = origin.replace(/^https:\\/\\/github\\.com\\//, '').replace(/\\.git$/, '');
const branch = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
state.calls.push({ args, repo, token: process.env.GH_TOKEN || null });
const find = (head) => state.prs.find((p) => p.repo === repo && p.head === head && p.state === 'open');
let out = '';
if (args[0] === 'pr' && args[1] === 'list') {
  const pr = find(flag('--head'));
  if (pr) out = flag('--json') === 'isDraft' ? String(pr.draft) : pr.url;
} else if (args[0] === 'pr' && args[1] === 'create') {
  const head = flag('--head') || branch();
  const number = state.prs.length + 1;
  const pr = { repo, head, number, url: 'https://github.com/' + repo + '/pull/' + number, draft: args.includes('--draft'), title: flag('--title'), body: flag('--body'), state: 'open' };
  state.prs.push(pr);
  out = pr.url;
} else if (args[0] === 'pr' && args[1] === 'edit') {
  const pr = find(args[2]);
  if (pr) { pr.title = flag('--title') || pr.title; pr.body = flag('--body') || pr.body; }
} else if (args[0] === 'pr' && args[1] === 'ready') {
  const pr = find(args[2]);
  if (pr) pr.draft = false;
}
fs.writeFileSync(store, JSON.stringify(state));
if (out) console.log(out);
`;

const FAKE_CODEGRAPH = `#!/bin/sh
case "$1" in
  init) mkdir -p "$2/.codegraph" && echo db > "$2/.codegraph/codegraph.db" ;;
  --version) echo fake ;;
esac
exit 0
`;

// ── Scenarios ──────────────────────────────────────────────────────────────

type Card = {
  key: string;
  kind: 'story' | 'subtask';
  repos: string[];
  parentKey: string | null;
  children: string[];
  status: string;
};

type Scenario = {
  name: string;
  runId: string;
  /** The card the launcher is booted with — the leaf, or the parent. */
  key: string;
  command: 'run' | 'run_scope';
  /** The run's legs, in the run's own order. */
  legs: string[];
  cards: Record<string, Card>;
};

const leafCard = (key: string, repos: string[], parentKey: string | null = null): Card => ({
  key,
  kind: 'subtask',
  repos,
  parentKey,
  children: [],
  status: 'in_progress',
});

const SCENARIOS: Scenario[] = [
  {
    name: 'a one-repository leaf',
    runId: 'run_smoke_leaf1',
    key: 'ACME-7',
    command: 'run',
    legs: ['ACME-7'],
    cards: { 'ACME-7': leafCard('ACME-7', ['app-a']) },
  },
  {
    name: 'a leaf that spans two repositories',
    runId: 'run_smoke_leaf2',
    key: 'ACME-8',
    command: 'run',
    legs: ['ACME-8'],
    cards: { 'ACME-8': leafCard('ACME-8', ['app-a', 'app-b']) },
  },
  {
    name: 'a parent with two children in two repositories',
    runId: 'run_smoke_parent',
    key: 'ACME-10',
    command: 'run_scope',
    legs: ['ACME-11', 'ACME-12'],
    cards: {
      'ACME-10': {
        key: 'ACME-10',
        kind: 'story',
        repos: ['app-a', 'app-b'],
        parentKey: null,
        children: ['ACME-11', 'ACME-12'],
        status: 'in_progress',
      },
      'ACME-11': leafCard('ACME-11', ['app-a'], 'ACME-10'),
      'ACME-12': leafCard('ACME-12', ['app-b'], 'ACME-10'),
    },
  },
];

// ── The stub Motir (and gateway) ───────────────────────────────────────────

const NOW = '2026-09-27T00:00:00Z';
const cloneUrl = (repo: string) => `https://github.com/acme/${repo}.git`;

type Recorded = { method: string; path: string; auth: string | undefined; body: unknown };

type Stub = {
  server: Server;
  url: string;
  requests: Recorded[];
  events: { kind: string; workItemKey?: string }[];
  closed: unknown[];
  scenario: Scenario | null;
  modelCalls: { apiKey: string | undefined }[];
  /** Every request the stub could not answer — a route the CLI called that it lacks. */
  misses: string[];
};

function workItemDetail(s: Scenario, key: string) {
  const card = s.cards[key]!;
  return {
    key,
    kind: card.kind,
    type: card.kind === 'story' ? null : 'code',
    title: `Card ${key}`,
    status: card.status,
    priority: 'high',
    assigneeId: OWNER,
    reporterId: OWNER,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    createdAt: NOW,
    updatedAt: NOW,
    descriptionMd: null,
    parentKey: card.parentKey,
    folderId: null,
    folderPath: null,
    ancestorKeys: card.parentKey ? [card.parentKey] : [],
    children: card.children.map((child) => ({
      key: child,
      kind: 'subtask',
      title: `Card ${child}`,
      status: s.cards[child]!.status,
      priority: 'high',
      assigneeId: OWNER,
      estimateMinutes: null,
      storyPoints: null,
      parentKey: key,
      archived: false,
      // ACME-12 waits on ACME-11, so the drain's order is the run's order.
      dependencies: {
        blockedBy:
          child === 'ACME-12'
            ? [{ key: 'ACME-11', title: 'Card ACME-11', status: 'in_progress' }]
            : [],
        blocks: [],
      },
    })),
    links: {
      blockedBy: [],
      blocks: [],
      relatesTo: [],
      duplicates: [],
      clones: [],
      supersedes: [],
      supersededBy: [],
    },
    readiness: {
      ready: true,
      openBlockers: [],
      blockedByAncestorKey: null,
      blockedByAncestorTitle: null,
    },
    labels: [],
    components: [],
    commentCount: 0,
    sprintId: null,
    targetRepo: card.repos[0] ?? null,
    targetRepos: card.repos,
    targetRepositories: [],
    executor: card.kind === 'story' ? null : 'coding_agent',
    difficulty: null,
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
    deliveries: [],
  };
}

function dispatchRun(s: Scenario, status: 'running' | 'succeeded') {
  return {
    id: s.runId,
    projectId: 'prj_acme',
    command: s.command,
    origin: 'hosted',
    scopeWorkItemId: s.command === 'run_scope' ? 'wi_acme_10' : null,
    scopeLabel: s.command === 'run_scope' ? s.key : null,
    status,
    stopReason: null,
    lastHeartbeatAt: null,
    agent: 'opencode',
    model: MODEL.split('/')[1],
    startedAt: NOW,
    endedAt: status === 'running' ? null : NOW,
    createdById: OWNER,
    cards: s.legs.map((leg, position) => ({
      id: `card_${leg}`,
      key: leg,
      workItemId: `wi_${leg}`,
      position,
      disposition: 'queued',
      skipReason: null,
      sessionBranch: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
    })),
    seq: 0,
  };
}

function prompt(s: Scenario, key: string, sessionBranch: string | null) {
  const card = s.cards[key]!;
  const mode = sessionBranch ? 'session' : 'pr';
  return {
    key,
    prompt:
      `Build ${key}. FAKE:key=${key} FAKE:mode=${mode} FAKE:repos=${card.repos.join(',')}` +
      (sessionBranch ? ` FAKE:branch=${sessionBranch}` : ''),
    parentKey: card.parentKey,
    targetRepo: card.repos[0] ?? null,
    targetRepoCloneUrl: card.repos[0] ? cloneUrl(card.repos[0]) : null,
    targetRepoDefaultBranch: 'main',
    targetRepos: card.repos.map((repo) => ({
      name: repo,
      cloneUrl: cloneUrl(repo),
      defaultBranch: 'main',
      delivery: 'awaiting',
    })),
    workflowMode: sessionBranch ? 'session_lineage' : 'per_item_pr',
    sessionBranch,
    advisories: [],
  };
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    url: '',
    requests: [],
    events: [],
    closed: [],
    scenario: null,
    modelCalls: [],
    misses: [],
  };
  stub.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const path = url.pathname;
      const method = req.method ?? '';
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      stub.requests.push({ method, path, auth: req.headers.authorization, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // The gateway: the fake agent's one model call, keyed on the run key.
      if (method === 'POST' && path === '/v1/messages') {
        stub.modelCalls.push({ apiKey: req.headers['x-api-key'] as string | undefined });
        return json(200, { id: 'msg_smoke', type: 'message', content: [] });
      }
      const s = stub.scenario;
      if (!s) return json(500, { message: 'no scenario' });
      if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`)
        return json(401, { code: 'unauthenticated' });
      const m = (re: RegExp) => re.exec(path);
      let hit: RegExpExecArray | null;
      if (method === 'GET' && path === '/api/v1/me') {
        return json(200, {
          user: { id: OWNER, name: DISPATCHER, email: 'dana@example.com' },
          workspaceId: 'ws_acme',
          permissions: [],
        });
      }
      if (method === 'GET' && path === `/api/v1/dispatch-runs/${s.runId}`) {
        return json(200, dispatchRun(s, 'running'));
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/events`) {
        const events =
          (body as { events?: { kind: string; workItemKey?: string }[] })?.events ?? [];
        stub.events.push(...events);
        return json(200, {
          runId: s.runId,
          appended: events.length,
          seq: stub.events.length,
          cards: [],
        });
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/close`) {
        stub.closed.push(body);
        return json(200, dispatchRun(s, 'succeeded'));
      }
      if (method === 'GET' && path === `/api/v1/dispatch-runs/${s.runId}/close-out-prompt`) {
        return json(200, {
          runId: s.runId,
          targetKey: s.key,
          prompt: 'Write How to test. FAKE:closeout',
          landedKeys: s.legs,
        });
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/git-credential`) {
        const repos = [...new Set(Object.values(s.cards).flatMap((c) => c.repos))];
        return json(200, {
          credentials: repos.map((repo) => ({
            repository: `acme/${repo}`,
            token: `ghs_token_for_${repo}`,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            authorName: BOTS[`acme/${repo}`]!.name,
            authorEmail: BOTS[`acme/${repo}`]!.email,
          })),
          dispatchedBy: DISPATCHER,
        });
      }
      if (method === 'POST' && path === '/api/v1/sessions/complete') {
        const b = body as { sessionBranch: string; keys?: string[] };
        return json(200, {
          sessionBranch: b.sessionBranch,
          results: (b.keys ?? []).map((key) => ({ key, outcome: 'completed' })),
        });
      }
      if ((hit = m(/^\/api\/v1\/work-items\/([A-Z0-9-]+)(\/[a-z-]+)?$/))) {
        const key = hit[1]!;
        const sub = hit[2] ?? '';
        const card = s.cards[key];
        if (!card) return json(404, { code: 'not_found' });
        if (method === 'GET' && sub === '') return json(200, workItemDetail(s, key));
        if (method === 'GET' && sub === '/designs') return json(200, { designs: [] });
        if (method === 'GET' && sub === '/how-to-test') return json(200, { key, record: null });
        if (method === 'GET' && sub === '/dispatch-prompt') {
          return json(200, prompt(s, key, url.searchParams.get('sessionBranch')));
        }
        if (method === 'POST' && sub === '/claim') {
          card.status = 'in_progress';
          return json(200, {
            key,
            title: `Card ${key}`,
            outcome: 'mine',
            claimed: true,
            status: { key: 'in_progress', category: 'in_progress' },
            assignee: { id: OWNER, name: DISPATCHER },
            transitionedBy: null,
            transitionedAt: null,
          });
        }
        if (method === 'POST' && sub === '/transitions') {
          card.status = (body as { status?: string })?.status ?? card.status;
          return json(200, workItemDetail(s, key));
        }
        if (method === 'POST' && sub === '/integration') {
          card.status = 'implemented';
          return json(200, {
            key,
            status: 'implemented',
            sessionBranch: (body as { sessionBranch?: string })?.sessionBranch ?? null,
            updatedAt: NOW,
            implementationSource: null,
            implementationHarness: 'opencode',
            implementationModel: null,
          });
        }
        if (method === 'POST' && sub === '/pull-requests') {
          const b = body as { url?: string; repo?: string; number?: number; title?: string };
          return json(200, {
            key,
            created: true,
            pullRequest: {
              repo: b.repo ?? 'acme/app-a',
              number: b.number ?? 1,
              title: b.title ?? key,
              url: b.url ?? 'https://github.com/acme/app-a/pull/1',
              state: 'open',
              ci: null,
            },
          });
        }
      }
      if (method === 'GET' && path === '/api/v1/projects/ACME/work-items') {
        return json(200, { items: [], nextCursor: null });
      }
      stub.misses.push(`${method} ${path}`);
      return json(404, { code: 'not_found', message: `the stub has no ${method} ${path}` });
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, '127.0.0.1', () => r()));
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  return stub;
}

// ── The world a scenario runs in ───────────────────────────────────────────

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

type World = {
  env: NodeJS.ProcessEnv;
  home: string;
  workspace: string;
  remotes: Record<string, string>;
};

/** Bare remotes seeded with one commit on `main`, the fakes on PATH, and the redirect. */
function makeWorld(stub: Stub): World {
  const root = tempDir('hosted-smoke-');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  for (const dir of [home, workspace, bin]) mkdirSync(dir, { recursive: true });
  const remotes: Record<string, string> = {};
  const redirect: string[] = [];
  for (const repo of ['app-a', 'app-b']) {
    const seed = join(root, `seed-${repo}`);
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'README.md'), `# ${repo}\n`);
    git(seed, 'add', 'README.md');
    git(
      seed,
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.com',
      'commit',
      '-q',
      '-m',
      'seed',
    );
    const bare = join(root, `${repo}.git`);
    git(root, 'clone', '-q', '--bare', seed, bare);
    remotes[repo] = bare;
    redirect.push(`[url "${bare}"]`, `\tinsteadOf = https://github.com/acme/${repo}.git`);
    redirect.push(`[url "${bare}"]`, `\tinsteadOf = https://github.com/acme/${repo}`);
  }
  const redirectFile = join(home, 'smoke-redirect.gitconfig');
  writeFileSync(redirectFile, `${redirect.join('\n')}\n`);
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('opencode', FAKE_OPENCODE);
  write('gh', FAKE_GH);
  write('codegraph', FAKE_CODEGRAPH);
  // The launcher execs `MOTIR_CLI_BIN`: the CLI from source, as the image runs it built.
  write('motir', `#!/bin/sh\nexec "${TSX}" "${CLI_SRC_INDEX}" "$@"\n`);

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('MOTIR_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN')
      continue;
    env[k] = v;
  }
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    MOTIR_CONFIG_HOME: join(home, '.motir'),
    MOTIR_CLI_BIN: join(bin, 'motir'),
    MOTIR_WORKSPACE: workspace,
    MOTIR_API_URL: stub.url,
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_GATEWAY_URL: stub.url,
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_MODEL: MODEL,
    GIT_CONFIG_SYSTEM: redirectFile,
    GIT_TERMINAL_PROMPT: '0',
  });
  return { env, home, workspace, remotes };
}

function launch(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRYPOINT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

type Pr = { repo: string; head: string; draft: boolean; body: string; state: string };
const readPrs = (
  home: string,
): { prs: Pr[]; calls: { args: string[]; repo: string; token: string | null }[] } =>
  existsSync(join(home, 'fake-gh.json'))
    ? JSON.parse(readFileSync(join(home, 'fake-gh.json'), 'utf8'))
    : { prs: [], calls: [] };

const readAgents = (
  home: string,
): { envKeys: string[]; leaksRunToken: boolean; closeout: boolean; model: string }[] =>
  readFileSync(join(home, 'agent-records.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

// ── Layer 0: the launcher's own decisions ──────────────────────────────────

describe('the hosted launcher (MOTIR-6560)', () => {
  const full = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    MOTIR_DISPATCH_RUN_ID: 'run_1',
    MOTIR_WORK_ITEM_KEY: 'ACME-7',
    MOTIR_API_URL: 'https://motir.example',
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_GATEWAY_URL: 'https://gateway.example',
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_MODEL: MODEL,
    ...over,
  });

  it('runs `motir run <KEY>` by default and `motir continue <KEY>` in continue mode', () => {
    expect(cliArgs(readLaunch(full()))).toEqual(['run', 'ACME-7']);
    expect(cliArgs(readLaunch(full({ MOTIR_RUN_MODE: 'continue' })))).toEqual([
      'continue',
      'ACME-7',
    ]);
  });

  it('names EVERY missing input at once, and refuses a bad key or mode', () => {
    expect(() => readLaunch({})).toThrow(
      `missing required input(s): ${REQUIRED_INPUTS.join(', ')}`,
    );
    expect(() => readLaunch(full({ MOTIR_WORK_ITEM_KEY: 'not a key' }))).toThrow(/work item key/);
    expect(() => readLaunch(full({ MOTIR_RUN_MODE: 'retry' }))).toThrow(/"run" or "continue"/);
  });

  it('reads no repository, base ref, git token or git author', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    for (const retired of [
      'MOTIR_REPOSITORY',
      'MOTIR_BASE_REF',
      'MOTIR_GIT_TOKEN',
      'MOTIR_GIT_AUTHOR_NAME',
      'MOTIR_GIT_AUTHOR_EMAIL',
    ]) {
      expect(source.includes(`env.${retired}`) || source.includes(`'${retired}'`)).toBe(false);
    }
  });

  it('exits 20 and starts nothing when an input is missing', async () => {
    const res = await launch({ PATH: process.env.PATH ?? '', MOTIR_CLI_BIN: '/nonexistent/motir' });
    expect(res.code).toBe(SETUP_FAILED);
    expect(res.stderr).toContain('missing required input(s): MOTIR_DISPATCH_RUN_ID');
  });
});

// ── Layer 1: the three run shapes, as processes ────────────────────────────

describe('the hosted image, as processes: the launcher runs the real CLI (MOTIR-6560)', () => {
  let stub: Stub;

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
  });
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function arm(s: Scenario): World {
    // Fresh card statuses per scenario — the stub mutates them as the run goes.
    for (const card of Object.values(s.cards)) card.status = 'in_progress';
    stub.scenario = s;
    stub.requests.length = 0;
    stub.events.length = 0;
    stub.closed.length = 0;
    stub.modelCalls.length = 0;
    stub.misses.length = 0;
    const world = makeWorld(stub);
    world.env.MOTIR_DISPATCH_RUN_ID = s.runId;
    world.env.MOTIR_WORK_ITEM_KEY = s.key;
    return world;
  }

  /** What every shape shares: adopted, never opened; closed once; nothing off-route. */
  function expectAdoptedAndClosed(s: Scenario) {
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET /api/v1/dispatch-runs/${s.runId}`);
    expect(paths).not.toContain('POST /api/v1/dispatch-runs');
    expect(stub.requests.filter((r) => r.path === '/api/v1/workspaces')).toEqual([]);
    // Every Motir call carried the run credential (the gateway call carries the run key).
    const motir = stub.requests.filter((r) => r.path.startsWith('/api/'));
    expect(motir.filter((r) => r.auth !== `Bearer ${RUN_TOKEN}`)).toEqual([]);
    expect(paths.filter((p) => p === `POST /api/v1/dispatch-runs/${s.runId}/close`)).toHaveLength(
      1,
    );
    // The stub answered everything the CLI asked — no route fell through.
    expect(stub.misses).toEqual([]);
  }

  /** Every agent the CLI spawned: OpenCode on the run model, never holding the run credential. */
  function expectAgentsConfined(home: string) {
    const agents = readAgents(home);
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.model).toBe(MODEL);
      expect(agent.leaksRunToken).toBe(false);
      expect(agent.envKeys).not.toContain('MOTIR_RUN_TOKEN');
      expect(agent.envKeys).not.toContain('GH_TOKEN');
    }
    // The model call went through the gateway on the run key, as the egress document says.
    expect(stub.modelCalls.length).toBeGreaterThan(0);
    expect(stub.modelCalls.every((c) => c.apiKey === RUN_KEY)).toBe(true);
  }

  /** The commit on a remote branch: its author is the repository's App bot. */
  function authorOn(bare: string, ref: string): string {
    return git(bare, 'log', '-1', '--format=%an <%ae>', ref).trim();
  }

  it('a one-repository leaf: one pull request, committed as the App, the shared event sequence', async () => {
    const s = SCENARIOS[0]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`)).toEqual(['acme/app-a hosted/ACME-7']);
    // `gh` got THAT repository's token, for that one call, through the CLI's shim.
    expect(calls.filter((c) => c.args[1] === 'create').map((c) => c.token)).toEqual([
      'ghs_token_for_app-a',
    ]);
    expect(authorOn(world.remotes['app-a']!, 'hosted/ACME-7')).toBe(
      `${BOTS['acme/app-a']!.name} <${BOTS['acme/app-a']!.email}>`,
    );
    // The checkout was indexed, and the index never reached the commit.
    expect(existsSync(join(world.workspace, 'app-a', '.codegraph'))).toBe(true);
    expect(
      git(world.remotes['app-a']!, 'ls-tree', '-r', '--name-only', 'hosted/ACME-7'),
    ).not.toContain('.codegraph');

    const kinds = stub.events.map((e) => e.kind);
    for (const kind of ['checkout_ready', 'agent_started', 'agent_exited'])
      expect(kinds).toContain(kind);
    expect(kinds.indexOf('checkout_ready')).toBeLessThan(kinds.indexOf('agent_started'));
    expect(kinds.indexOf('agent_started')).toBeLessThan(kinds.indexOf('agent_exited'));
    expect(kinds).not.toContain('run_opened');
    expect(s.cards['ACME-7']!.status).toBe('implemented');
  }, 120_000);

  it('a leaf across two repositories: both cloned as siblings, one pull request in each, each as its own App', async () => {
    const s = SCENARIOS[1]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    expect(existsSync(join(world.workspace, 'app-a', '.git'))).toBe(true);
    expect(existsSync(join(world.workspace, 'app-b', '.git'))).toBe(true);
    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => p.repo).sort()).toEqual(['acme/app-a', 'acme/app-b']);
    expect(
      calls
        .filter((c) => c.args[1] === 'create')
        .map((c) => `${c.repo} ${c.token}`)
        .sort(),
    ).toEqual(['acme/app-a ghs_token_for_app-a', 'acme/app-b ghs_token_for_app-b']);
    for (const repo of ['app-a', 'app-b']) {
      const bot = BOTS[`acme/${repo}`]!;
      expect(authorOn(world.remotes[repo]!, 'hosted/ACME-8')).toBe(`${bot.name} <${bot.email}>`);
    }
    expect(s.cards['ACME-8']!.status).toBe('implemented');
  }, 120_000);

  it('a parent: its children in order on one session branch per repository, a draft per repository made ready at close-out', async () => {
    const s = SCENARIOS[2]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    // No scope claim and no ready-set read: the legs are the run's.
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.some((p) => p.includes('scope-claims'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/ready'))).toBe(false);
    // Each child integrated, in the run's order.
    const integrated = stub.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/integration'))
      .map((r) => r.path.split('/')[4]);
    expect(integrated).toEqual(['ACME-11', 'ACME-12']);
    const branches = new Set(
      stub.requests
        .filter((r) => r.path.endsWith('/integration'))
        .map((r) => (r.body as { sessionBranch: string }).sessionBranch),
    );
    expect(branches.size).toBe(1);
    const [session] = [...branches] as [string];

    // One pull request per repository, opened as a DRAFT and READY at the end.
    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`).sort()).toEqual([
      `acme/app-a ${session}`,
      `acme/app-b ${session}`,
    ]);
    expect(
      calls.filter((c) => c.args[1] === 'create').every((c) => c.args.includes('--draft')),
    ).toBe(true);
    // The CLI's own `gh` calls went through its shim, each with its repository's token.
    expect(
      calls
        .filter((c) => c.args[1] === 'create')
        .map((c) => `${c.repo} ${c.token}`)
        .sort(),
    ).toEqual(['acme/app-a ghs_token_for_app-a', 'acme/app-b ghs_token_for_app-b']);
    expect(prs.every((p) => p.draft === false)).toBe(true);
    // Every pull request names the dispatcher (the CLI's hosted attribution).
    expect(prs.every((p) => p.body.includes(DISPATCHER))).toBe(true);
    for (const repo of ['app-a', 'app-b']) {
      const bot = BOTS[`acme/${repo}`]!;
      expect(authorOn(world.remotes[repo]!, session)).toBe(`${bot.name} <${bot.email}>`);
    }
    // The close-out's How-to-test agent ran, once, after the children.
    const agents = readAgents(world.home);
    expect(agents.filter((a) => a.closeout)).toHaveLength(1);
    expect(agents.at(-1)!.closeout).toBe(true);
    expect(s.cards['ACME-11']!.status).toBe('implemented');
    expect(s.cards['ACME-12']!.status).toBe('implemented');
  }, 180_000);

  it('continue mode reaches the CLI as `motir continue <KEY>`, and the CLI answers for it', async () => {
    const s = SCENARIOS[0]!;
    const world = arm(s);
    world.env.MOTIR_RUN_MODE = 'continue';
    const res = await launch(world.env);
    // `motir continue` is the run-dies story's; until it ships the CLI refuses
    // the command, non-zero, and nothing is pushed or opened.
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('motir continue ACME-7');
    expect(readPrs(world.home).prs).toEqual([]);
  }, 60_000);
});

// ── Layer 2: the image ─────────────────────────────────────────────────────

describe.skipIf(!IMAGE)('the hosted-agent IMAGE (MOTIR-6560)', () => {
  const image = IMAGE ?? '';
  const inImage = (cmd: string) =>
    spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', cmd], {
      encoding: 'utf8',
    });

  it('carries the Motir CLI, gh, git ≥ 2.36, OpenCode 1.18.32 and codegraph — and no other agent CLI', () => {
    const res = inImage(
      'motir --version && gh --version && git --version && opencode --version && codegraph --version; ' +
        'for a in claude codex aider goose cursor-agent kimi; do command -v "$a" && echo "UNEXPECTED $a"; done; true',
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/gh version/);
    expect(res.stdout).toMatch(/^1\.18\.32$/m);
    const gitVersion = /git version (\d+)\.(\d+)/.exec(res.stdout);
    expect(gitVersion).not.toBeNull();
    const [major, minor] = [Number(gitVersion![1]), Number(gitVersion![2])];
    expect(major > 2 || (major === 2 && minor >= 36)).toBe(true);
    expect(res.stdout).not.toContain('UNEXPECTED');
  });

  it('runs as a non-root user with /workspace as its workspace', () => {
    const res = inImage('id -u && echo "$MOTIR_WORKSPACE" && test -w /workspace && echo writable');
    expect(res.status, res.stderr).toBe(0);
    const [uid, workspace, writable] = res.stdout.trim().split('\n');
    expect(uid).not.toBe('0');
    expect(workspace).toBe('/workspace');
    expect(writable).toBe('writable');
  });

  it('its launcher refuses a boot with no inputs, naming them, with exit 20', () => {
    const res = spawnSync('docker', ['run', '--rm', image], { encoding: 'utf8' });
    expect(res.status).toBe(SETUP_FAILED);
    expect(res.stderr).toContain('missing required input(s): MOTIR_DISPATCH_RUN_ID');
  });
});
