import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { DispatchRunRepair, DispatchRunView, WorkItemDelivery } from '../src/client.js';
import type { RunAgentOptions } from '../src/agentRun.js';
import { CliError } from '../src/errors.js';

// `motir fix <KEY>` IN A HOSTED CONTAINER (Story MOTIR-1626 · MOTIR-6929;
// `hosted-agent-run.md` §8.6). The session, the agent, git and the wait are injected;
// what is under test is that the container ADOPTS the `fix` run the server's repair
// claim opened (never claims), clones every repository and checks each pull request
// out on its OWN branch, runs the agent on the review-fix prompt with the recorded
// findings, and closes the run on every exit — and, against real git, that the push
// lock admits those branches and nothing else.

const { sessionRef, adoptedRef } = vi.hoisted(() => ({
  sessionRef: { current: null as unknown },
  adoptedRef: { current: null as unknown },
}));

vi.mock('../src/session.js', () => ({
  withHostedProjectSession: async (
    _runId: string,
    fn: (s: unknown, run: unknown) => Promise<unknown>,
  ) => fn(sessionRef.current, adoptedRef.current),
  withProjectSession: async () => {
    throw new Error('a hosted repair never opens a local session');
  },
}));

const { fixCommand, claimFromRun, hostedRepairAddendum } = await import('../src/commands/fix.js');
const { lockHostedRunToBranches, REPAIR_GH_REFUSAL } = await import('../src/hostedGit.js');
const { hostedAgentEnv } = await import('../src/hostedAgent.js');

const RUN = 'run_fix_hosted_1';
const KEY = 'PROD-7';
const FINDINGS = [
  '- `src/a.ts:12` — the refusal is not named (AC2).',
  '- `src/b.ts:40` — the second repository never closes the run.',
].join('\n');
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

const HOSTED_ENV = {
  MOTIR_DISPATCH_RUN_ID: RUN,
  MOTIR_MODEL: 'anthropic/claude-test-1',
  MOTIR_GATEWAY_URL: 'https://gateway.example',
  MOTIR_RUN_KEY: 'sk-run',
  PATH: process.env.PATH ?? '',
};

function decision(twoRepos = false): DispatchRunRepair {
  return {
    repairClass: 'review',
    title: 'Add the thing',
    pullRequests: [
      {
        repo: 'acme/app-a',
        number: 3,
        url: 'https://github.com/acme/app-a/pull/3',
        branch: 'feat/PROD-7-a',
        baseRef: 'main',
        headSha: 'a'.repeat(40),
      },
      ...(twoRepos
        ? [
            {
              repo: 'acme/app-b',
              number: 4,
              url: 'https://github.com/acme/app-b/pull/4',
              branch: 'feat/PROD-7-b',
              baseRef: 'main',
              headSha: 'b'.repeat(40),
            },
          ]
        : []),
    ],
    findings: {
      gate: 'agent_review',
      gateId: 'gate_1',
      subjectVersion: 'acme/app-a#3@aaa',
      findingsMd: FINDINGS,
      reviewerName: 'Review agent',
      decidedByLabel: 'Review agent',
      decidedUnderAuthority: 'review_agent',
      decidedAt: '2026-09-29T10:00:00.000Z',
    },
  };
}

interface Harness {
  root: string;
  calls: { tool: string; args: unknown }[];
  git: { args: string[]; cwd: string }[];
  events: { kind: string; disposition?: string; data?: unknown }[];
  closed: string[];
  agentRuns: RunAgentOptions[];
  locked: { repository: string; branch: string }[][];
  interrupt: ((signal?: 'SIGINT' | 'SIGTERM') => void) | null;
  exits: number[];
}
let h: Harness;

/**
 * A git whose clone makes the directory, whose worktrees answer the branch they were
 * added on, and whose remote branch heads MOVE once the agent has pushed (`pushed`).
 */
function fakeGit(state: { pushed: boolean }): CommandRunner {
  const worktrees = new Map<string, string>();
  return (_bin, args, cwd) => {
    h.git.push({ args, cwd });
    if (args[0] === 'clone') {
      mkdirSync(args[args.length - 1]!, { recursive: true });
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args[2] === '--track' ? args[5]! : args[2]!;
      const branch = args[2] === '--track' ? args[4]! : args[3]!;
      worktrees.set(path, branch);
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return ok(worktrees.get(cwd) ?? 'HEAD');
    }
    if (args[0] === 'rev-parse' && args[1]!.startsWith('refs/remotes/origin/')) {
      return ok(`${state.pushed ? 'new' : 'old'}-${args[1]}\n`);
    }
    return ok();
  };
}

function setup(
  over: {
    command?: string;
    repair?: DispatchRunRepair | null;
    twoRepos?: boolean;
    legs?: string[];
    verdicts?: WorkItemDelivery[][];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'motir-fix-hosted-'));
  h = {
    root,
    calls: [],
    git: [],
    events: [],
    closed: [],
    agentRuns: [],
    locked: [],
    interrupt: null,
    exits: [],
  };
  const verdicts = [...(over.verdicts ?? [])];
  const client = {
    getDispatchRun: async (id: string): Promise<DispatchRunView> => {
      h.calls.push({ tool: 'get_run', args: id });
      return {
        runId: id,
        status: 'running',
        command: over.command ?? 'fix',
        origin: 'hosted',
        model: null,
        endedAt: null,
        cards: [{ key: KEY, position: 0, disposition: 'queued' }],
        continues: null,
        repair: over.repair === undefined ? decision(over.twoRepos) : over.repair,
      };
    },
    claimWorkItemRepair: async (key: string) => {
      h.calls.push({ tool: 'claim_repair', args: key });
      throw new Error('a hosted repair never claims');
    },
    getWorkItem: async (key: string) => {
      h.calls.push({ tool: 'get_work_item', args: key });
      const deliveries = verdicts.length > 1 ? verdicts.shift()! : (verdicts[0] ?? []);
      return { deliveries };
    },
    appendDispatchRunEvents: async (args: { events: Harness['events'] }) => {
      h.events.push(...args.events);
      return { runId: RUN, appended: args.events.length, seq: h.events.length };
    },
    closeDispatchRun: async (args: { stopReason: string }) => {
      h.closed.push(args.stopReason);
    },
    heartbeatDispatchRun: async () => 'ok' as const,
    openDispatchRun: async () => {
      h.calls.push({ tool: 'open_run', args: null });
      return { runId: 'never', created: true };
    },
    transitionStatus: async (args: unknown) => {
      h.calls.push({ tool: 'transition_status', args });
    },
    linkPullRequest: async (args: unknown) => {
      h.calls.push({ tool: 'link_pull_request', args });
    },
  };
  sessionRef.current = {
    client,
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'x', workspace: '', project: 'PROD' },
    },
    projectKey: 'PROD',
    serverUrl: 'x',
  };
  adoptedRef.current = { runId: RUN, projectKey: 'PROD', legs: over.legs ?? [KEY] };
}

function deps(
  over: { agentExit?: number; pushes?: boolean; onAgent?: () => void } = {},
): Parameters<typeof fixCommand>[2] {
  const state = { pushed: false };
  return {
    env: { ...HOSTED_ENV },
    run: fakeGit(state),
    runAgentFn: async (opts: RunAgentOptions) => {
      h.agentRuns.push(opts);
      over.onAgent?.();
      if (over.pushes !== false && (over.agentExit ?? 0) === 0) state.pushed = true;
      return { exitCode: over.agentExit ?? 0, signal: null, model: null };
    },
    wait: async () => {},
    lockPushes: (allowed) => {
      h.locked.push([...allowed]);
    },
    prepareHostedCheckouts: () => {},
    onInterrupt: (handler) => {
      h.interrupt = handler;
      return () => {
        h.interrupt = null;
      };
    },
    exit: (code: number) => {
      h.exits.push(code);
    },
  };
}

const green = (): WorkItemDelivery[] => [
  {
    repo: 'acme/app-a',
    number: 3,
    title: 'Add the thing',
    url: 'https://github.com/acme/app-a/pull/3',
    state: 'open',
    ci: 'passing',
    baseRef: 'main',
    defaultBranch: 'main',
  },
];

const tools = () => h.calls.map((c) => c.tool);
const settled = () => h.events.filter((e) => e.kind === 'card_settled');

beforeEach(() => {
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rmSync(h?.root ?? join(tmpdir(), 'none'), { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// ── Adopt, never claim ─────────────────────────────────────────────────────

describe('hosted `motir fix` — adopts the fix run, never claims (MOTIR-6929)', () => {
  it('reads the decision from the run, makes ZERO repair-claim calls, and writes no second run_opened', async () => {
    setup({ verdicts: [green()] });
    await fixCommand(KEY, {}, deps());

    expect(tools()).toContain('get_run');
    expect(tools()).not.toContain('claim_repair');
    expect(tools()).not.toContain('open_run');
    expect(h.events.map((e) => e.kind)).not.toContain('run_opened');
    expect(h.closed).toEqual(['completed']);
    expect(process.exitCode).toBeUndefined();
  });

  it('a run whose command is not `fix` is refused, naming it — nothing adopted, closed, locked or pushed', async () => {
    setup({ command: 'run' });
    const err = await fixCommand(KEY, {}, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/is a `run` run, not a repair/);
    expect((err as CliError).exitCode).toBe(20);
    expect(h.closed).toEqual([]);
    expect(h.locked).toEqual([]);
    expect(h.git).toEqual([]);
    expect(h.agentRuns).toEqual([]);
  });

  it('a card that is not the run’s is refused before anything is adopted', async () => {
    setup({ legs: ['PROD-9'] });
    await expect(fixCommand(KEY, {}, deps())).rejects.toThrow(/PROD-7 is not a card of run/);
    expect(h.closed).toEqual([]);
    expect(h.agentRuns).toEqual([]);
  });

  it('a fix run with no recorded decision closes halted and pushes nothing — never a guessed branch', async () => {
    setup({ repair: null });
    await expect(fixCommand(KEY, {}, deps())).rejects.toThrow(/records no repair decision/);
    expect(h.closed).toEqual(['halted']);
    expect(settled()).toMatchObject([{ disposition: 'failed' }]);
    expect(h.locked).toEqual([]);
    expect(h.agentRuns).toEqual([]);
    expect(tools()).not.toContain('claim_repair');
  });

  it('a non-review repair class is refused the same way', async () => {
    setup({ repair: { ...decision(), repairClass: 'ci' } });
    await expect(fixCommand(KEY, {}, deps())).rejects.toThrow(/a `ci` repair/);
    expect(h.closed).toEqual(['halted']);
  });
});

// ── The checkout and the lock ──────────────────────────────────────────────

describe('hosted `motir fix` — every repository, each pull request on its OWN branch', () => {
  it('two repositories: both cloned, each checked out on its own branch, pushes locked to exactly those', async () => {
    setup({ twoRepos: true, verdicts: [green()] });
    await fixCommand(KEY, {}, deps());

    expect(h.locked).toEqual([
      [
        { repository: 'acme/app-a', branch: 'feat/PROD-7-a' },
        { repository: 'acme/app-b', branch: 'feat/PROD-7-b' },
      ],
    ]);
    const clones = h.git.filter((g) => g.args[0] === 'clone').map((g) => g.args.at(-1));
    expect(clones).toEqual([join(h.root, 'app-a'), join(h.root, 'app-b')]);
    const worktrees = h.git
      .filter((g) => g.args[0] === 'worktree')
      .map((g) => `${g.cwd} ${g.args.join(' ')}`);
    expect(worktrees).toEqual([
      `${join(h.root, 'app-a')} worktree add --track -b feat/PROD-7-a ${join(h.root, 'app-a-fix-prod-7-3')} origin/feat/PROD-7-a`,
      `${join(h.root, 'app-b')} worktree add --track -b feat/PROD-7-b ${join(h.root, 'app-b-fix-prod-7-4')} origin/feat/PROD-7-b`,
    ]);
    // Never a NEW branch, never detached, and nothing pushed by the CLI itself.
    for (const g of h.git) {
      expect(g.args).not.toContain('switch');
      expect(g.args).not.toContain('--detach');
      expect(g.args[0]).not.toBe('push');
    }
    const ready = h.events.find((e) => e.kind === 'checkout_ready');
    expect(ready?.data).toMatchObject({
      checkouts: [
        { repo: 'acme/app-a', branch: 'feat/PROD-7-a' },
        { repo: 'acme/app-b', branch: 'feat/PROD-7-b' },
      ],
    });
  });

  it('the lock is in place BEFORE the agent runs', async () => {
    setup({ verdicts: [green()] });
    let lockedWhenAgentRan = -1;
    await fixCommand(KEY, {}, deps({ onAgent: () => (lockedWhenAgentRan = h.locked.length) }));
    expect(lockedWhenAgentRan).toBe(1);
  });
});

// ── The prompt ─────────────────────────────────────────────────────────────

describe('hosted `motir fix` — the agent works the review-fix prompt with the recorded findings', () => {
  it('OpenCode on the run model, the findings in full, and the repair addendum — not the build one', async () => {
    setup({ twoRepos: true, verdicts: [green()] });
    await fixCommand(KEY, {}, deps());

    const [turn] = h.agentRuns;
    expect(turn!.command.binary).toBe('opencode');
    expect(turn!.command.args).toContain('anthropic/claude-test-1');
    expect(turn!.prompt).toMatch(/^# Answer the code review — PROD-7 \(Add the thing\)/);
    for (const line of FINDINGS.split('\n')) expect(turn!.prompt).toContain(line);
    expect(turn!.prompt).toContain('Review agent sent it back on 2026-09-29T10:00:00.000Z');
    expect(turn!.prompt).toContain(
      `\`feat/PROD-7-b\` at \`${join(h.root, 'app-b-fix-prod-7-4')}\``,
    );
    expect(turn!.cwd).toBe(join(h.root, 'app-a-fix-prod-7-3'));

    const argv = turn!.command.promptArgs!(turn!.prompt, '/tmp/prompt.md');
    expect(argv.at(-1)).toContain('## HOSTED REPAIR RUN — git');
    expect(argv.at(-1)).not.toMatch(/Every pull request you open or edit/);
    expect(hostedRepairAddendum()).toMatch(/`gh` is disabled/);
  });
});

// ── Every exit closes the run, and none writes a status ────────────────────

describe('hosted `motir fix` — how it ends', () => {
  it('pushed, CI green: the run closes completed, the leg implemented', async () => {
    setup({ verdicts: [green()] });
    await fixCommand(KEY, {}, deps());
    expect(h.closed).toEqual(['completed']);
    expect(settled()).toMatchObject([{ disposition: 'implemented' }]);
    expect(tools()).toContain('get_work_item');
  });

  it('NO CHANGE: the agent pushed nothing — no CI watch, the run closes, the card stays To fix', async () => {
    setup({ verdicts: [green()] });
    await fixCommand(KEY, {}, deps({ pushes: false }));
    expect(h.closed).toEqual(['completed']);
    expect(settled()).toMatchObject([
      { disposition: 'failed', data: { reason: 'nothing_pushed' } },
    ]);
    expect(tools()).not.toContain('get_work_item');
    expect(process.exitCode).toBeUndefined();
  });

  it('a failed agent: closed halted, exit non-zero, nothing watched', async () => {
    setup({ verdicts: [green()] });
    await fixCommand(KEY, {}, deps({ agentExit: 3 }));
    expect(h.closed).toEqual(['halted']);
    expect(process.exitCode).toBe(1);
    expect(tools()).not.toContain('get_work_item');
  });

  it('a SIGTERM mid-repair closes the run interrupted and exits 143', async () => {
    setup({ verdicts: [green()] });
    await fixCommand(KEY, {}, deps({ onAgent: () => h.interrupt!('SIGTERM') }));
    await vi.waitFor(() => expect(h.exits).toEqual([143]));
    expect(h.closed[0]).toBe('interrupted');
  });

  it('gave up on a red build: names the pull requests it started with, and still claims nothing', async () => {
    const red: WorkItemDelivery[] = [{ ...green()[0]!, ci: 'failing' }];
    setup({ verdicts: [red] });
    await fixCommand(KEY, {}, deps());
    expect(h.closed).toEqual(['halted']);
    expect(process.exitCode).toBe(1);
    expect(tools()).not.toContain('claim_repair');
  });

  it('no exit writes a card status, links or opens anything', async () => {
    for (const d of [deps(), deps({ pushes: false }), deps({ agentExit: 2 })]) {
      setup({ verdicts: [green()] });
      await fixCommand(KEY, {}, d);
      expect(tools()).not.toContain('transition_status');
      expect(tools()).not.toContain('link_pull_request');
      expect(tools()).not.toContain('open_run');
      process.exitCode = undefined;
    }
  });
});

describe('claimFromRun — the terminal claim, rebuilt from what the run recorded', () => {
  it('each pull request on its own branch, the findings as the review refusal', () => {
    const claim = claimFromRun({ key: KEY, runId: RUN, repair: decision(true) });
    expect(claim).toMatchObject({
      key: KEY,
      title: 'Add the thing',
      outcome: 'claimed',
      runId: RUN,
      repairClass: 'review',
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: FINDINGS,
        reviewerName: 'Review agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
    });
    expect(claim.pullRequests.map((p) => [p.repo, p.headRef])).toEqual([
      ['acme/app-a', 'feat/PROD-7-a'],
      ['acme/app-b', 'feat/PROD-7-b'],
    ]);
  });
});

// ── The push lock, against real git ────────────────────────────────────────

describe('lockHostedRunToBranches — a repair pushes to its pull requests’ own branches only', () => {
  let state: string;
  let bare: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let git: (...args: string[]) => ReturnType<typeof spawnSync>;

  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'motir-repair-lock-'));
    bare = join(state, 'app-a.git');
    repo = join(state, 'repo');
    mkdirSync(join(state, 'bin'));
    writeFileSync(join(state, 'bin', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // GitHub, redirected to a local bare remote — the checkout's remote stays the GitHub URL.
    writeFileSync(
      join(state, 'gitconfig'),
      `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/app-a.git\n`,
    );
    env = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: join(state, 'gitconfig') };
    const run = (cwd: string, e: NodeJS.ProcessEnv, ...args: string[]) =>
      spawnSync('git', args, {
        cwd,
        env: { ...process.env, ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    run(state, env, 'init', '-q', '--bare', '-b', 'main', bare);
    mkdirSync(repo);
    run(repo, env, 'init', '-q', '-b', 'feat/a');
    run(repo, env, 'remote', 'add', 'origin', 'https://github.com/acme/app-a.git');
    const commit = (m: string) =>
      run(
        repo,
        env,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@e',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        m,
      );
    commit('one');
    run(repo, env, 'push', '-q', 'origin', 'feat/a');
    commit('two');
    lockHostedRunToBranches(state, [{ repository: 'acme/app-a', branch: 'feat/a' }], env);
    git = (...args: string[]) => run(repo, env, ...args);
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const remoteRefs = () =>
    spawnSync('git', ['show-ref'], { cwd: bare, encoding: 'utf8' }).stdout.trim().split('\n');

  it('the pull request’s own branch is pushed; any other ref, a delete and a force push are refused', () => {
    const pushed = git('push', 'origin', 'HEAD:refs/heads/feat/a');
    expect(pushed.status, String(pushed.stderr)).toBe(0);

    const sneaky = git('push', 'origin', 'HEAD:refs/heads/sneaky');
    expect(sneaky.status).not.toBe(0);
    expect(String(sneaky.stderr)).toMatch(/pushes only to its pull requests' own branches/);

    const deleted = git('push', 'origin', ':refs/heads/feat/a');
    expect(deleted.status).not.toBe(0);
    expect(String(deleted.stderr)).toMatch(/never deletes a branch/);

    const forced = git('push', '--force', 'origin', 'HEAD~1:refs/heads/feat/a');
    expect(forced.status).not.toBe(0);
    expect(String(forced.stderr)).toMatch(/never rewrites/);

    expect(remoteRefs().map((l) => l.split(' ')[1])).toEqual(['refs/heads/feat/a']);
  });

  it('a checkout’s OWN core.hooksPath (husky) cannot move the lock aside — and its hooks still run', () => {
    const own = join(repo, '.husky');
    mkdirSync(own);
    writeFileSync(
      join(own, 'pre-push'),
      `#!/bin/sh\necho ran >> "${join(state, 'own-pre-push')}"\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    git('config', '--local', 'core.hooksPath', '.husky');

    expect(git('push', 'origin', 'HEAD:refs/heads/sneaky').status).not.toBe(0);
    expect(existsSync(join(state, 'own-pre-push'))).toBe(false);
    expect(git('push', 'origin', 'HEAD:refs/heads/feat/a').status).toBe(0);
    expect(readFileSync(join(state, 'own-pre-push'), 'utf8')).toBe('ran\n');
  });

  it('gh refuses every call; the agent’s allow-listed environment carries the lock', () => {
    const gh = spawnSync(join(state, 'bin', 'gh'), ['pr', 'create'], { encoding: 'utf8' });
    expect(gh.status).toBe(1);
    expect(gh.stderr.trim()).toBe(REPAIR_GH_REFUSAL);
    expect(env.PATH!.split(':')[0]).toBe(join(state, 'bin'));

    const agentEnv = hostedAgentEnv(env);
    expect(agentEnv.GIT_CONFIG_COUNT).toBe('1');
    expect(agentEnv.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(agentEnv.GIT_CONFIG_VALUE_0).toBe(join(state, 'repair-hooks'));
  });

  it('refuses to lock a run that already carries command-scope git config', () => {
    expect(() => lockHostedRunToBranches(state, [], { PATH: '', GIT_CONFIG_COUNT: '1' })).toThrow(
      /already carries command-scope git config/,
    );
  });
});
