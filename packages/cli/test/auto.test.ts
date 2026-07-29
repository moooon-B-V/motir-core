import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOutRepos,
  parseMax,
  runAutoLoop,
  type AutoOptions,
  type LoopInput,
} from '../src/commands/auto.js';
import {
  autoExitCode,
  classifyReadyItem,
  formatDuration,
  planReviewUrl,
  renderAutoSummary,
  renderSessionPrBody,
  sessionPrTitle,
  type AutoSummary,
} from '../src/autoLoop.js';
import { runIdFromDate, sessionBranchName, type CommandResult } from '../src/git.js';
import { CliError } from '../src/errors.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { DispatchPrompt, MotirClient } from '../src/mcpClient.js';
import type { ProjectSession } from '../src/session.js';

// `motir auto` — the sequential WHILE loop (Subtask 7.9.4 · MOTIR-882).
//
// The loop is driven end-to-end here against a SCRIPTED server + agent + git,
// because its load-bearing properties are not visible in any single function:
// that it re-queries the server every iteration (rather than draining a list),
// that an integrated item unlocks its dependents mid-run, that main is never
// advanced, and that the end-of-run pull request opens even when the run ended
// badly. The fake server therefore models the real readiness rule (a dependency
// counts as satisfied once it is integrated on a session branch) rather than
// replaying a fixed sequence.

// ── the fake server ─────────────────────────────────────────────────────────

interface FakeItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  type: string | null;
  executor: string | null;
  targetRepo: string | null;
  deps: string[];
  status: string;
  sessionBranch: string | null;
  /** When set, this item only ENTERS the plan once `appearsAfter` is integrated
   *  — it is absent from every listing before that, which is what makes "the
   *  ready set changes underneath the loop" real rather than rearranged. */
  appearsAfter?: string;
}

function leaf(id: string, key: string, over: Partial<FakeItem> = {}): FakeItem {
  return {
    id,
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    type: 'code',
    executor: 'coding_agent',
    targetRepo: 'motir-core',
    deps: [],
    status: 'todo',
    sessionBranch: null,
    ...over,
  };
}

function story(id: string, key: string): FakeItem {
  return { ...leaf(id, key), kind: 'story', type: null, executor: null };
}

class FakeServer {
  readonly transitions: { key: string; status: string }[] = [];
  readonly integrated: { key: string; sessionBranch: string }[] = [];
  readonly promptCalls: { key: string; sessionBranch: string | null }[] = [];
  readonly nextReadyCalls: number[] = [];
  readonly expandCalls: string[] = [];
  /** Return a message to make `expand_item` reject for that key. */
  expandFailure: ((key: string) => string | null) | null = null;

  constructor(private readonly items: FakeItem[]) {}

  byKey(key: string): FakeItem {
    const item = this.items.find((i) => i.key === key);
    if (!item) throw new Error(`no such item ${key}`);
    return item;
  }

  private present(item: FakeItem): boolean {
    if (!item.appearsAfter) return true;
    return this.integrated.some((r) => r.key === item.appearsAfter);
  }

  /** A dependency is satisfied when it is done OR integrated on a session branch
   *  awaiting review — the 7.8.11 integrated-dep readiness rule. */
  private satisfied(depId: string): boolean {
    const dep = this.items.find((i) => i.id === depId);
    return !!dep && (dep.status === 'done' || dep.status === 'in_review');
  }

  /** The single lineage an item inherits from its integrated dependencies. */
  private inherited(item: FakeItem): string | null {
    for (const depId of item.deps) {
      const dep = this.items.find((i) => i.id === depId);
      if (dep?.sessionBranch) return dep.sessionBranch;
    }
    return null;
  }

  asClient(): MotirClient {
    // Arrow properties, so the fake's methods close over the fixture instance
    // without aliasing `this`.
    const fake = {
      listReady: (): never => {
        throw new Error(
          '`motir auto` must never materialize the ready list — it asks for ONE item per iteration.',
        );
      },
      getPlanStatus: (): never => {
        throw new Error(
          '`motir auto` must never POLL a planning job: its output is a plan awaiting a human ' +
            'approval, so waiting on it in an unattended run is an unbounded wait on nobody.',
        );
      },
      expandItem: async (key: string) => {
        this.expandCalls.push(key);
        const failure = this.expandFailure?.(key);
        if (failure) throw new CliError(failure);
        const n = this.expandCalls.length;
        // A submit returns the ids and nothing else — no children, because none
        // exist: the job writes PROPOSALS into the plan, and approval is what
        // materializes them.
        return { jobId: `job-${n}`, planId: `plan-${n}` };
      },
      nextReady: async (args: { excludeIds?: string[] }) => {
        this.nextReadyCalls.push(args.excludeIds?.length ?? 0);
        const excluded = new Set(args.excludeIds ?? []);
        const item = this.items.find(
          (i) =>
            this.present(i) &&
            i.status === 'todo' &&
            !excluded.has(i.id) &&
            i.deps.every((d) => this.satisfied(d)),
        );
        if (!item) return { item: null };
        return {
          item: {
            id: item.id,
            key: item.key,
            kind: item.kind,
            title: item.title,
            priority: 'medium',
            status: { key: item.status, category: 'todo' },
            type: item.type,
            executor: item.executor,
            targetRepo: item.targetRepo,
            sessionBranch: item.sessionBranch,
          },
        };
      },
      dispatchPrompt: async (
        key: string,
        opts: { sessionBranch?: string | null } = {},
      ): Promise<DispatchPrompt> => {
        const item = this.byKey(key);
        // The server rule: real lineage wins, the caller's seed is a fallback.
        const branch = this.inherited(item) ?? item.sessionBranch ?? opts.sessionBranch ?? null;
        this.promptCalls.push({ key, sessionBranch: branch });
        return {
          key,
          prompt: `PROMPT ${key}`,
          targetRepo: item.targetRepo,
          workflowMode: branch ? 'session_lineage' : 'per_item_pr',
          sessionBranch: branch,
        };
      },
      transitionStatus: async (args: { key: string; status: string }) => {
        this.transitions.push(args);
        this.byKey(args.key).status = args.status;
        return {};
      },
      markIntegrated: async (args: { key: string; sessionBranch: string }) => {
        this.integrated.push({ key: args.key, sessionBranch: args.sessionBranch });
        const item = this.byKey(args.key);
        item.status = 'in_review';
        item.sessionBranch = args.sessionBranch;
        return {};
      },
    };
    return fake as unknown as MotirClient;
  }
}

// ── the fake git / gh ───────────────────────────────────────────────────────

class FakeGit {
  readonly log: string[] = [];
  private readonly remoteBranches = new Set<string>();
  prCreated = 0;
  ghAvailable = true;
  commitsOnBranch = 3;

  runner = (bin: string, args: string[], cwd: string): CommandResult => {
    this.log.push(`${bin} ${args.join(' ')} @${cwd}`);
    const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
    const fail = (stderr = 'boom'): CommandResult => ({ exitCode: 1, stdout: '', stderr });

    if (bin === 'git') {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse') {
        const ref = args[args.length - 1] ?? '';
        if (ref.startsWith('refs/remotes/origin/')) {
          return this.remoteBranches.has(ref.slice('refs/remotes/origin/'.length)) ? ok() : fail();
        }
        return fail(); // no local branch — the agent worked in a worktree
      }
      if (args[0] === 'push') {
        const spec = args[2] ?? '';
        const created = spec.split(':refs/heads/')[1];
        if (created) this.remoteBranches.add(created);
        return ok();
      }
      if (args[0] === 'rev-list') return ok(String(this.commitsOnBranch));
    }
    if (bin === 'gh') {
      if (!this.ghAvailable) return { exitCode: 127, stdout: '', stderr: 'gh: not found' };
      if (args[1] === 'list') return ok('');
      if (args[1] === 'create') {
        this.prCreated += 1;
        return ok('https://github.com/moooon/motir-core/pull/9001');
      }
    }
    return ok();
  };
}

// ── harness ─────────────────────────────────────────────────────────────────

let root: string;
let configHome: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const BRANCH = sessionBranchName('20260729-010203');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-auto-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), 'motir-auto-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = configHome;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(root, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function session(server: FakeServer): ProjectSession {
  return {
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    client: server.asClient(),
  };
}

interface DriveOptions {
  opts?: AutoOptions;
  agentResults?: (key: string, index: number) => AgentRunResult;
  onDispatch?: (key: string, index: number) => void;
}

async function drive(
  server: FakeServer,
  git: FakeGit,
  drives: DriveOptions = {},
): Promise<{ summary: AutoSummary; dispatched: string[] }> {
  const dispatched: string[] = [];
  let tick = 0;
  const input: LoopInput = {
    session: session(server),
    opts: drives.opts ?? {},
    kinds: undefined,
    max: drives.opts?.max ? parseMax(drives.opts.max) : null,
    agent: { parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] }, source: 'flag' },
    runId: '20260729-010203',
    branch: BRANCH,
    run: git.runner,
    clock: () => (tick += 1000),
    runAgentFn: async ({ prompt }) => {
      const key = prompt.replace('PROMPT ', '');
      const index = dispatched.length;
      dispatched.push(key);
      drives.onDispatch?.(key, index);
      return drives.agentResults?.(key, index) ?? { exitCode: 0, signal: null };
    },
  };
  const summary = await runAutoLoop(input);
  closeOutRepos(summary, git.runner);
  return { summary, dispatched };
}

// ── the pure decisions ──────────────────────────────────────────────────────

describe('classifyReadyItem', () => {
  it('dispatches an ordinary coding leaf', () => {
    expect(classifyReadyItem({ kind: 'subtask', type: 'code', executor: 'coding_agent' })).toBe(
      'dispatch',
    );
    // The 7.0.10 exclusion asserted as a CONTROL: a container that reached the
    // ready set is childless by construction, so kind alone decides. A leaf of
    // any kind is never mistaken for a planning item.
    expect(classifyReadyItem({ kind: 'task', type: 'test', executor: 'coding_agent' })).toBe(
      'dispatch',
    );
    expect(classifyReadyItem({ kind: 'bug', type: null, executor: null })).toBe('dispatch');
  });
  it('classifies an unexpanded epic/story as a planning item', () => {
    expect(classifyReadyItem({ kind: 'story' })).toBe('needs_planning');
    expect(classifyReadyItem({ kind: 'Epic' })).toBe('needs_planning');
  });
  it('classifies human work as needing a human', () => {
    expect(classifyReadyItem({ kind: 'subtask', type: 'manual', executor: 'coding_agent' })).toBe(
      'needs_human',
    );
    expect(classifyReadyItem({ kind: 'subtask', type: 'code', executor: 'human' })).toBe(
      'needs_human',
    );
  });
});

describe('parseMax', () => {
  it('accepts a positive whole number and defaults to no cap', () => {
    expect(parseMax(undefined)).toBeNull();
    expect(parseMax('3')).toBe(3);
  });
  it('refuses a value that would silently mean "no cap"', () => {
    for (const bad of ['0', '-1', 'lots', '2.5', '']) {
      expect(() => parseMax(bad)).toThrow(CliError);
    }
  });
});

describe('run id + session branch', () => {
  it('names a branch with no MOTIR key in it', () => {
    const branch = sessionBranchName(runIdFromDate(new Date(2026, 6, 29, 1, 2, 3)));
    expect(branch).toBe('motir/auto-20260729-010203');
    // Load-bearing: the status webhook parses a PR's branch AND title, so a key
    // here would link the whole multi-item run to one card.
    expect(branch).not.toMatch(/[A-Z]+-\d+/);
  });
});

describe('formatDuration', () => {
  it('renders seconds and minutes', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(64_000)).toBe('1m 04s');
  });
});

// ── the loop ────────────────────────────────────────────────────────────────

describe('motir auto — the WHILE loop', () => {
  it('re-queries every iteration, so an item created MID-RUN is picked up next', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      // PROD-9 is absent from every listing until PROD-1 is integrated — it
      // could not have been in a pre-computed plan of the run.
      leaf('idNew', 'PROD-9', { appearsAfter: 'PROD-1' }),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    expect(dispatched).toEqual(['PROD-1', 'PROD-9']);
    expect(summary.stopReason).toBe('drained');
    // One `next_ready` per iteration plus the final empty one — never a list.
    expect(server.nextReadyCalls.length).toBe(3);
  });

  it('cascades a dependency CHAIN: each item unlocks on its dep being integrated', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2', { deps: ['idA'] }),
      leaf('idC', 'PROD-3', { deps: ['idB'] }),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    // Strictly one at a time, in dependency order.
    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    // Every one integrated on the SAME session branch, none of them done.
    expect(server.integrated).toEqual([
      { key: 'PROD-1', sessionBranch: BRANCH },
      { key: 'PROD-2', sessionBranch: BRANCH },
      { key: 'PROD-3', sessionBranch: BRANCH },
    ]);
    expect(server.transitions.every((t) => t.status !== 'done')).toBe(true);
    // The FIRST item needed the loop's seed; the later ones INHERITED the branch
    // from the dependency the run had already integrated.
    expect(server.promptCalls.map((c) => c.sessionBranch)).toEqual([BRANCH, BRANCH, BRANCH]);
    expect(summary.records.map((r) => r.outcome)).toEqual([
      'integrated',
      'integrated',
      'integrated',
    ]);
    expect(autoExitCode(summary)).toBe(0);

    // ONE pull request for the one touched repo, and main is UNTOUCHED: nothing
    // in the whole run merged, checked out, or pushed to main.
    expect(git.prCreated).toBe(1);
    expect(summary.prs).toHaveLength(1);
    expect(summary.prs[0]?.outcome).toBe('opened');
    expect(git.log.some((c) => /\bmerge\b|\bcheckout\b|\bswitch\b|\breset\b/.test(c))).toBe(false);
    expect(git.log.some((c) => /push .*:refs\/heads\/main\b|push origin main\b/.test(c))).toBe(
      false,
    );
  });

  it('skips an unexpanded story and a human item without dispatching or transitioning them', async () => {
    const server = new FakeServer([
      { ...leaf('idS', 'PROD-5'), kind: 'story', type: null, executor: null },
      leaf('idH', 'PROD-6', { type: 'manual' }),
      leaf('idA', 'PROD-7'),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    expect(dispatched).toEqual(['PROD-7']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
      { key: 'PROD-6', title: 'Item PROD-6', reason: 'needs_human' },
    ]);
    // Skipped means UNTOUCHED — no status flip, no prompt fetched.
    expect(server.transitions.map((t) => t.key)).toEqual(['PROD-7']);
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-7']);

    const text = renderAutoSummary(summary);
    expect(text).toContain('Skipped — needs planning (1)');
    expect(text).toContain('Skipped — needs a human (1)');
  });

  it('honours --max and stops with the cap named', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, { opts: { max: '1' } });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('max');
    // The cap ends the run, but the completed work still gets its pull request.
    expect(git.prCreated).toBe(1);
  });
});

// ── --include-planning (MOTIR-886) ──────────────────────────────────────────

describe('motir auto --include-planning', () => {
  /** The acceptance fixture: one ready unexpanded story, two ready leaves. */
  const fixture = (): FakeServer =>
    new FakeServer([story('idS', 'PROD-5'), leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);

  it('triggers the story ONCE, dispatches both leaves, and drains without ever polling', async () => {
    const server = fixture();
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    expect(server.expandCalls).toEqual(['PROD-5']);
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('drained');
    // The story is a PLANNING item, never an agent's work: no prompt was
    // fetched for it and its status was never touched.
    expect(dispatched).not.toContain('PROD-5');
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-1', 'PROD-2']);
    expect(server.transitions.some((t) => t.key === 'PROD-5')).toBe(false);
    expect(server.byKey('PROD-5').status).toBe('todo');
    // Triggered, not expanded — the record carries the plan to review and no
    // claim about children.
    expect(summary.planning).toEqual([
      {
        key: 'PROD-5',
        title: 'Item PROD-5',
        outcome: 'triggered',
        planId: 'plan-1',
        reviewUrl: 'https://app.motir.co/plans/plan-1',
      },
    ]);
    // It is no longer reported as skipped — the flag is the whole difference.
    expect(summary.skipped).toEqual([]);
  });

  it('never re-fires for an item already triggered, even though it stays childless', async () => {
    // The story is the ONLY item and remains unexpanded, so without the exclude
    // list `next_ready` would hand it back forever and this test would hang.
    const server = new FakeServer([story('idS', 'PROD-5')]);
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    expect(server.expandCalls).toEqual(['PROD-5']);
    expect(dispatched).toEqual([]);
    // Trigger, then ONE more ask that comes back empty. No backoff, no wait.
    expect(server.nextReadyCalls.length).toBe(2);
    expect(summary.stopReason).toBe('drained');
    // A pending expansion does not redden a run whose dispatches all succeeded.
    expect(autoExitCode(summary)).toBe(0);

    const text = renderAutoSummary(summary);
    expect(text).toContain('Planning triggered — awaiting your approval (1)');
    expect(text).toContain('plan plan-1 — https://app.motir.co/plans/plan-1');
    expect(text).toContain('These are PROPOSALS.');
  });

  it('a failed expansion is NON-halting: named, skipped over, and irrelevant to the exit code', async () => {
    const server = fixture();
    server.expandFailure = (key) => (key === 'PROD-5' ? 'FORBIDDEN: out of AI credits' : null);
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    // The loop kept going — unlike an agent failure, which halts by default.
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('drained');
    expect(summary.planning).toEqual([
      {
        key: 'PROD-5',
        title: 'Item PROD-5',
        outcome: 'failed',
        planId: null,
        reviewUrl: null,
        detail: 'FORBIDDEN: out of AI credits',
      },
    ]);
    expect(autoExitCode(summary)).toBe(0);
    expect(renderAutoSummary(summary)).toContain('Planning failed — still unexpanded (1)');
  });

  it('leaves the exit code a function of DISPATCH outcomes alone', async () => {
    const server = fixture();
    server.expandFailure = () => 'BAD_REQUEST: nope';
    const { summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true, keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 4, signal: null } : { exitCode: 0, signal: null },
    });

    // Non-zero because a DISPATCH failed, not because the expansion did.
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-2',
    ]);
    expect(autoExitCode(summary)).toBe(1);
  });

  it('WITHOUT the flag reproduces the MOTIR-882 skip behaviour verbatim (the control)', async () => {
    const server = fixture();
    const { dispatched, summary } = await drive(server, new FakeGit());

    // No expansion is submitted at all — the flag is opt-in, and an expansion
    // spends the token owner's AI credits.
    expect(server.expandCalls).toEqual([]);
    expect(summary.planning).toEqual([]);
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
    ]);
    expect(renderAutoSummary(summary)).toContain('Skipped — needs planning (1)');
  });

  it('renders all three planning outcomes, and links a plan only when it has one', () => {
    expect(planReviewUrl('https://app.motir.co', 'plan-7')).toBe(
      'https://app.motir.co/plans/plan-7',
    );
    expect(planReviewUrl('not a url', 'plan-7')).toBeNull();

    const text = renderAutoSummary({
      runId: '20260729-010203',
      records: [],
      skipped: [{ key: 'PROD-8', title: 'Skipped one', reason: 'needs_planning' }],
      planning: [
        {
          key: 'PROD-5',
          title: 'Triggered one',
          outcome: 'triggered',
          planId: 'plan-1',
          reviewUrl: 'https://app.motir.co/plans/plan-1',
        },
        {
          key: 'PROD-6',
          title: 'Failed one',
          outcome: 'failed',
          planId: null,
          reviewUrl: null,
          detail: 'RATE_LIMITED',
        },
      ],
      repos: [],
      prs: [],
      stopReason: 'drained',
    });

    expect(text).toContain('Planning triggered — awaiting your approval (1)');
    expect(text).toContain('PROD-5 — Triggered one');
    expect(text).toContain('Planning failed — still unexpanded (1)');
    expect(text).toContain('PROD-6 — RATE_LIMITED');
    expect(text).toContain('Skipped — needs planning (1)');
  });
});

describe('motir auto — failure policy', () => {
  const chain = (): FakeServer =>
    new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2'), leaf('idC', 'PROD-3')]);

  it('halts on the first agent failure by default, and still opens the PR', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 3, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('halted');
    // The failed item is left In Progress — nothing reverted, never integrated.
    expect(server.byKey('PROD-2').status).toBe('in_progress');
    expect(server.integrated.map((r) => r.key)).toEqual(['PROD-1']);
    expect(autoExitCode(summary)).toBe(1);
    // The completed item is NOT abandoned by the failure.
    expect(git.prCreated).toBe(1);
    expect(renderAutoSummary(summary)).toContain('motir run PROD-2');
  });

  it('--keep-going finishes the remainder and never re-dispatches the failure', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      opts: { keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    expect(dispatched.filter((k) => k === 'PROD-1')).toHaveLength(1);
    expect(summary.stopReason).toBe('drained');
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-1',
    ]);
    expect(autoExitCode(summary)).toBe(1);
  });

  it('a Ctrl-C between items exits cleanly and still lands the pull request', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      onDispatch: (_key, index) => {
        if (index === 0) process.emit('SIGINT');
      },
    });

    // The in-flight item completes; the loop stops before starting another.
    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    // Server state is consistent: the item that ran is fully recorded, and no
    // half-applied transition is left behind.
    expect(server.integrated).toEqual([{ key: 'PROD-1', sessionBranch: BRANCH }]);
    expect(server.byKey('PROD-2').status).toBe('todo');
    expect(git.prCreated).toBe(1);
    expect(autoExitCode(summary)).toBe(130);
  });
});

describe('motir auto — the close-out', () => {
  it('opens no pull request for a branch that carries no commits', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const git = new FakeGit();
    git.commitsOnBranch = 0;
    const { summary } = await drive(server, git);

    expect(git.prCreated).toBe(0);
    expect(summary.prs[0]?.outcome).toBe('empty');
  });

  it('reports a gh failure with the manual fallback instead of losing the work', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const git = new FakeGit();
    git.ghAvailable = false;
    const { summary } = await drive(server, git);

    // The work is integrated and recorded regardless of the tooling gap.
    expect(server.integrated).toEqual([{ key: 'PROD-1', sessionBranch: BRANCH }]);
    expect(summary.prs[0]?.outcome).toBe('failed');
    const text = renderAutoSummary(summary);
    expect(text).toContain('NOT opened');
    expect(text).toContain(`motir done --session ${BRANCH}`);
  });

  it('names every in-review item with its recorded branch', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { summary } = await drive(server, new FakeGit());
    const text = renderAutoSummary(summary);
    expect(text).toContain('In Review — awaiting your merge (2)');
    expect(text).toContain(`PROD-1 on ${BRANCH}`);
    expect(text).toContain(`PROD-2 on ${BRANCH}`);
  });
});

describe('the session pull request', () => {
  it('titles without a key and bodies with every key plus the close-out', () => {
    const title = sessionPrTitle('20260729-010203', 3);
    expect(title).toBe('Motir auto run 20260729-010203 — 3 work items');
    expect(title).not.toMatch(/[A-Z]+-\d+/);

    const body = renderSessionPrBody('20260729-010203', BRANCH, [
      {
        key: 'PROD-1',
        title: 'A',
        outcome: 'integrated',
        durationMs: 1,
        sessionBranch: BRANCH,
        repo: 'motir-core',
      },
      {
        key: 'PROD-2',
        title: 'B',
        outcome: 'failed',
        durationMs: 1,
        sessionBranch: null,
        repo: 'motir-core',
      },
    ]);
    expect(body).toContain('## Work items carried (1)');
    expect(body).toContain('- PROD-1 — A');
    expect(body).toContain('Attempted and failed (1)');
    expect(body).toContain(`motir done --session ${BRANCH}`);
  });
});
