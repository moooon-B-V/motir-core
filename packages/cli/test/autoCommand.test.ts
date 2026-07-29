import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { buildProgram } from '../src/program.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import {
  startTestMcpServer,
  type TestMcpServer,
  type ToolScript,
} from './helpers/mcpTestServer.js';

// `motir auto` as the COMMAND (Subtask 7.9.5 · MOTIR-883).
//
// `auto.test.ts` drives the WHILE loop directly with a scripted client. This
// file drives the command the way the binary does — through the real project
// session, the real MCP client and a real MCP server — so the parts the loop
// test cannot see are covered: that the run refuses to start without an agent,
// that the session is opened and closed around it, that the close-out runs on
// every exit path, and that the process exit code reports the outcome.
//
// git is injected (a recorded runner), because what is asserted about it is
// which commands the CLI issues — not git's own behaviour, which
// `tests/cli/cli-story.test.ts` proves against real repositories.

let server: TestMcpServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_auto_token';

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-autocmd-'));
  root = join(base, 'workspace');
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  server.calls.length = 0;
  // `autoCommand` reports the run through `process.exitCode`; restoring it in
  // afterEach keeps a failing scripted run from failing the test PROCESS.
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const AGENT = { agent: `${process.execPath} -e ""` };

/** A two-item plan where the second only becomes ready once the first is
 *  integrated — the cascade, served over the real protocol. */
function planTools(): ToolScript {
  const integrated = new Set<string>();
  const statuses = new Map<string, string>();
  const dispatched = new Set<string>();
  return {
    next_ready: () => {
      const key = !dispatched.has('PROD-1')
        ? 'PROD-1'
        : integrated.has('PROD-1') && !dispatched.has('PROD-2')
          ? 'PROD-2'
          : null;
      if (!key) return { structured: { item: null } };
      dispatched.add(key);
      return {
        structured: {
          item: {
            id: `row-${key}`,
            key,
            kind: 'subtask',
            title: `Item ${key}`,
            priority: 'medium',
            status: { key: statuses.get(key) ?? 'todo', category: 'todo' },
            type: 'code',
            executor: 'coding_agent',
            targetRepo: 'motir-core',
            sessionBranch: null,
          },
        },
      };
    },
    dispatch_prompt: (args) => {
      const key = String(args['key']);
      const seed = (args['sessionBranch'] as string | undefined) ?? null;
      return {
        structured: {
          key,
          prompt: `PROMPT ${key}`,
          targetRepo: 'motir-core',
          workflowMode: seed ? 'session_lineage' : 'per_item_pr',
          sessionBranch: seed,
        },
      };
    },
    transition_status: (args) => {
      statuses.set(String(args['key']), String(args['status']));
      return { structured: { ok: true } };
    },
    mark_integrated: (args) => {
      integrated.add(String(args['key']));
      return { structured: { ok: true } };
    },
  };
}

/** A git runner that answers like a healthy repo, recording every command. */
function gitRunner(
  over: (bin: string, args: string[]) => CommandResult | undefined = () => undefined,
): {
  run: CommandRunner;
  log: string[];
} {
  const log: string[] = [];
  const run: CommandRunner = (bin, args) => {
    log.push(`${bin} ${args.join(' ')}`);
    const custom = over(bin, args);
    if (custom) return custom;
    if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
    if (bin === 'git' && args[0] === 'rev-list') return { exitCode: 0, stdout: '2', stderr: '' };
    if (bin === 'gh' && args[1] === 'create') {
      return { exitCode: 0, stdout: 'https://github.test/pull/1', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, log };
}

describe('motir auto refuses to start without an agent', () => {
  it('rejects --print: an unattended loop has nobody to paste a prompt', async () => {
    await expect(autoCommand({ print: true, ...AGENT })).rejects.toMatchObject({
      message: expect.stringContaining('cannot run in --print mode'),
      hint: expect.stringContaining('motir next --print'),
    });
    // It failed BEFORE opening a session — nothing was claimed.
    expect(server.calls).toHaveLength(0);
  });

  // The guard above is only worth anything if the flag actually REACHES it.
  // MOTIR-1828: `--print` was never registered on `auto`, so commander rejected
  // it first with a bare `unknown option '--print'` and the guard — with the
  // hint that tells the user what to do instead — was dead code from the
  // command line. Drive the REAL program, the way the binary does, so a
  // regression that un-registers the option fails here rather than silently
  // downgrading the message.
  it('rejects --print through the REAL program, delivering the guard’s hint', async () => {
    const program = buildProgram();
    // Without this, an unregistered `--print` would take the test runner down
    // with commander's own `process.exit` instead of failing the assertion.
    const noExit = (command: Command): void => {
      command.exitOverride();
      command.commands.forEach(noExit);
    };
    noExit(program);

    await expect(
      program.parseAsync(['auto', '--print', '--agent', 'echo'], { from: 'user' }),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('cannot run in --print mode'),
      hint: expect.stringContaining('motir next --print'),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a run with no agent configured anywhere, naming the three sources', async () => {
    vi.stubEnv('MOTIR_AGENT', '');
    await expect(autoCommand({})).rejects.toMatchObject({
      hint: expect.stringMatching(/MOTIR_AGENT.*agentCommand|--agent/),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a malformed --max before any work is dispatched', async () => {
    await expect(autoCommand({ ...AGENT, max: '0' })).rejects.toThrow(CliError);
    expect(server.calls).toHaveLength(0);
  });
});

describe('motir auto — a whole run through the real session', () => {
  it('drains the chain onto one branch, opens one pull request, and exits 0', async () => {
    server.script(planTools());
    const git = gitRunner();
    const prompts: string[] = [];

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          prompts.push(prompt);
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(prompts).toEqual(['PROMPT PROD-1', 'PROMPT PROD-2']);
    // Both items were reported as integrated on the run's ONE branch…
    const branch = 'motir/auto-20260729-010203';
    const integrated = server.calls.filter((c) => c.name === 'mark_integrated');
    expect(integrated.map((c) => c.args['key'])).toEqual(['PROD-1', 'PROD-2']);
    expect(new Set(integrated.map((c) => c.args['sessionBranch']))).toEqual(new Set([branch]));
    // …the harness identified itself (MOTIR-1685 provenance)…
    expect(String(integrated[0]?.args['implementationHarness'])).toMatch(/^motir-cli\//);
    // …and the close-out opened exactly one pull request, never a merge.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
    expect(git.log.some((cmd) => cmd.includes('pr merge'))).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('runs on its OWN clock and its OWN agent launcher when nothing is injected', async () => {
    server.script(planTools());
    const git = gitRunner();

    // Only git is injected: the run id comes from the real clock, and the agent
    // is launched by the real `runAgent` (node itself, exiting 0). This is the
    // shape the binary actually runs in.
    await autoCommand(
      { agent: `${process.execPath} -e ""`, kinds: 'subtask', max: '1' },
      { run: git.run },
    );

    expect(server.calls.some((c) => c.name === 'mark_integrated')).toBe(true);
    // `--kinds` reached the server's own filter rather than being dropped.
    expect(server.calls.find((c) => c.name === 'next_ready')?.args).toMatchObject({
      kinds: ['subtask'],
    });
    expect(
      git.log.some((cmd) =>
        /push origin refs\/remotes\/origin\/main:refs\/heads\/motir\/auto-\d{8}-\d{6}/.test(cmd),
      ),
    ).toBe(true);
  });

  it('--reset clears the persisted exclude list before the run starts', async () => {
    server.script(planTools());
    const { addExclude, readExcludes } = await import('../src/sessionExcludes.js');
    addExclude(server.url, 'PROD', { id: 'row-old', key: 'PROD-99' });

    await autoCommand(
      { ...AGENT, reset: true, max: '1' },
      {
        run: gitRunner().run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null }),
      },
    );

    expect(readExcludes(server.url, 'PROD')).toEqual([]);
  });

  it('exits non-zero when an agent failed, and still opens the pull request', async () => {
    server.script(planTools());
    const git = gitRunner();

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 7, signal: null }),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
    // The failed item was NOT reported as integrated.
    expect(server.calls.some((c) => c.name === 'mark_integrated')).toBe(false);
  });

  it('halts when git fails in a REAL checkout — before the item is touched', async () => {
    server.script(planTools());
    const git = gitRunner((bin, args) =>
      bin === 'git' && args[0] === 'fetch'
        ? { exitCode: 1, stdout: '', stderr: 'origin unreachable' }
        : undefined,
    );
    let dispatches = 0;

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => {
          dispatches += 1;
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(dispatches).toBe(0);
    // Nothing was claimed or transitioned — the failure precedes the status flip.
    expect(server.calls.some((c) => c.name === 'transition_status')).toBe(false);
    expect(git.log.some((cmd) => cmd.includes('pr create'))).toBe(false);
  });

  it('runs an item whose repo has NO checkout with no lineage rather than failing the run', async () => {
    // `motir-ai` has no checkout under the root, so there is no repository to
    // open a session branch in: the item ships as its own pull request instead.
    server.script({
      ...planTools(),
      next_ready: (() => {
        let served = false;
        return () => {
          if (served) return { structured: { item: null } };
          served = true;
          return {
            structured: {
              item: {
                id: 'row-9',
                key: 'PROD-9',
                kind: 'subtask',
                title: 'An item for an unchecked-out repo',
                priority: 'medium',
                status: { key: 'todo', category: 'todo' },
                type: 'code',
                executor: 'coding_agent',
                targetRepo: 'motir-ai',
                sessionBranch: null,
              },
            },
          };
        };
      })(),
    });
    const git = gitRunner((bin) =>
      // The root is not a git repository at all.
      bin === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined,
    );

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        // The agent "creates" nothing, so the bootstrap post-condition fails —
        // which is a FAILED dispatch, and the run still completes cleanly.
        runAgentFn: async () => ({ exitCode: 0, signal: null }),
      },
    );

    expect(server.calls.some((c) => c.name === 'transition_status')).toBe(true);
    expect(server.calls.some((c) => c.name === 'mark_integrated')).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
