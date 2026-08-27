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
  startTestServer,
  v1Detail,
  v1Page,
  v1ReadyRow,
  v1DispatchPrompt,
  v1Integration,
  type TestServer,
  type V1Request,
  type V1Script,
} from './helpers/testServer.js';

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

let server: TestServer;
let root: string;
let configHome: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_auto_token';

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
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
  configHome = join(base, 'config');
  vi.stubEnv('MOTIR_CONFIG_HOME', configHome);
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  server.v1Calls.length = 0;
  server.resetV1();
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

/**
 * A two-item plan where the second only becomes ready once the first is
 * integrated — the cascade, served over the real protocol.
 *
 * ⚠️ ONE state machine, ONE transport now (MOTIR-2398). Every call the loop
 * makes speaks `/api/v1`, and the cascade only works if they read the same
 * `integrated` set — so they share this closure rather than being scripted
 * independently. Splitting them would let the run "drain a chain" that no
 * longer exists.
 *
 * The READY SET is the cascade's source: PROD-2 appears in it only once PROD-1
 * has been integrated, which is what the real server's edge-derived readiness
 * does. The loop picks `items[0]`; nothing here decides what is "next".
 */
function planScripts(): { v1: V1Script } {
  const integrated = new Set<string>();
  const statuses = new Map<string, string>();
  const v1: V1Script = {
    // Ready = not yet integrated, and (for PROD-2) its dependency integrated.
    'GET /api/v1/projects/{projectKey}/ready': () => {
      const ready = ['PROD-1', 'PROD-2'].filter(
        (key) =>
          !integrated.has(key) &&
          statuses.get(key) !== 'in_review' &&
          (key === 'PROD-1' || integrated.has('PROD-1')),
      );
      return {
        body: v1Page(
          ready.map((key) =>
            v1ReadyRow(key, {
              title: `Item ${key}`,
              status: { key: statuses.get(key) ?? 'todo', category: 'todo' },
            }),
          ),
        ),
      };
    },
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => {
      const key = String(req.params['key']);
      const seed = req.query.get('sessionBranch');
      return {
        body: v1DispatchPrompt(key, {
          prompt: `PROMPT ${key}`,
          targetRepo: 'motir-core',
          workflowMode: seed ? 'session_lineage' : 'per_item_pr',
          sessionBranch: seed,
        }),
      };
    },
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const status = String((req.body as { status: string }).status);
      statuses.set(key, status);
      return { body: v1Detail(key, { status }) };
    },
    'POST /api/v1/work-items/{key}/integration': (req) => {
      const key = String(req.params['key']);
      integrated.add(key);
      const sent = req.body as { sessionBranch: string };
      return { body: v1Integration(key, { sessionBranch: sent.sessionBranch }) };
    },
  };
  return { v1 };
}

/** Script both halves of the plan onto the server. */
function scriptPlan(): void {
  server.scriptV1(planScripts().v1);
}

/** Every `/api/v1` request to one operation, in order. */
function v1CallsTo(method: string, suffix: string): V1Request[] {
  return server.v1Calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

/** A git runner that answers like a healthy repo, recording every command. */
function gitRunner(
  over: (bin: string, args: string[]) => CommandResult | undefined = () => undefined,
): {
  run: CommandRunner;
  log: string[];
  cwds: string[];
} {
  const log: string[] = [];
  /** The working directory each command ran in — the only evidence that says
   *  WHICH repository a git command touched (MOTIR-3135). */
  const cwds: string[] = [];
  /**
   * The pull requests this fake `gh` has been asked to create, keyed by
   * `cwd + --head` — so `gh pr list` ANSWERS WITH THEM, the way the real one does.
   *
   * ⚠️ Modelling that is load-bearing rather than fidelity for its own sake
   * (MOTIR-3681). `openSessionPr` lists before it creates, and `motir auto` now
   * calls it after every card that lands so the pull request exists from the
   * first implemented one. A stub whose `pr list` always answers EMPTY makes the
   * second call create a second pull request — which the real `gh` would never
   * do — and every assertion counting `gh pr create` would then be measuring the
   * stub's amnesia rather than the CLI's behaviour.
   *
   * ⚠️ AND THE KEY IS `cwd + head`, NOT head — a multi-repository run uses ONE
   * branch name in EVERY checkout, and the real `gh` answers per repository
   * because it runs in one. Keyed by branch name alone, the second repository's
   * `pr list` finds the FIRST repository's pull request and the CLI is wrongly
   * told it already has one. That is the same mistake the delivery link's own ADR
   * rejects one layer down: a branch name is not an identifier.
   */
  const opened = new Map<string, string>();
  const run: CommandRunner = (bin, args, cwd) => {
    log.push(`${bin} ${args.join(' ')}`);
    cwds.push(cwd);
    const custom = over(bin, args);
    if (custom) return custom;
    if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
    if (bin === 'git' && args[0] === 'rev-list') return { exitCode: 0, stdout: '2', stderr: '' };
    if (bin === 'gh' && (args[1] === 'list' || args[1] === 'create')) {
      const key = `${cwd}\u0000${args[args.indexOf('--head') + 1] ?? ''}`;
      if (args[1] === 'list') return { exitCode: 0, stdout: opened.get(key) ?? '', stderr: '' };
      const url = `https://github.test/pull/${opened.size + 1}`;
      opened.set(key, url);
      return { exitCode: 0, stdout: url, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, log, cwds };
}

describe('motir auto refuses to start without an agent', () => {
  it('rejects --print: an unattended loop has nobody to paste a prompt', async () => {
    await expect(autoCommand({ print: true, ...AGENT })).rejects.toMatchObject({
      message: expect.stringContaining('cannot run in --print mode'),
      hint: expect.stringContaining('motir next --print'),
    });
    // It failed BEFORE opening a session — nothing was claimed.
    expect(server.v1Calls).toHaveLength(0);
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
    expect(server.v1Calls).toHaveLength(0);
  });

  it('rejects a run with no agent configured anywhere, naming the three sources', async () => {
    vi.stubEnv('MOTIR_AGENT', '');
    await expect(autoCommand({})).rejects.toMatchObject({
      hint: expect.stringMatching(/MOTIR_AGENT.*agentCommand|--agent/),
    });
    expect(server.v1Calls).toHaveLength(0);
  });

  it('rejects a malformed --max before any work is dispatched', async () => {
    await expect(autoCommand({ ...AGENT, max: '0' })).rejects.toThrow(CliError);
    expect(server.v1Calls).toHaveLength(0);
  });
});

describe('motir auto — a whole run through the real session', () => {
  it('drains the chain onto one branch, opens one pull request, and exits 0', async () => {
    scriptPlan();
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
          return { exitCode: 0, signal: null, model: 'claude-opus-5' };
        },
      },
    );

    expect(prompts).toEqual(['PROMPT PROD-1', 'PROMPT PROD-2']);
    // Both items were reported as integrated on the run's ONE branch…
    const branch = 'motir/auto-20260729-010203';
    const integrated = v1CallsTo('POST', '/integration');
    expect(integrated.map((c) => c.params['key'])).toEqual(['PROD-1', 'PROD-2']);
    const bodies = integrated.map((c) => c.body as Record<string, unknown>);
    expect(new Set(bodies.map((b) => b['sessionBranch']))).toEqual(new Set([branch]));
    // …the provenance names the AGENT and its model, on the wire (MOTIR-1685
    // provenance, corrected by MOTIR-2419). The fixture's agent command is
    // `node -e ""`, so `node` IS the honest answer here — what matters is that
    // it is derived from the command the loop launched, and that the CLI never
    // reports itself as the thing that built the work.
    expect(bodies[0]?.['implementationHarness']).toBe('node');
    expect(bodies[0]?.['implementationModel']).toBe('claude-opus-5');
    for (const body of bodies) {
      expect(String(body['implementationHarness'])).not.toMatch(/^motir-cli\//);
    }
    // …and the close-out opened exactly one pull request, never a merge.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
    expect(git.log.some((cmd) => cmd.includes('pr merge'))).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  // ── MOTIR-3681 — THE PULL REQUEST OPENS AT THE FIRST IMPLEMENTED CARD ─────
  //
  // It used to open at the close-out, after every card. That makes CI's verdict
  // arrive only once the run is over, which is too late for anything to act on:
  // MOTIR-3685's watch-and-fix loop needs a verdict while there is still a run to
  // change. What these pin is the ORDER, not the count — a test that only counted
  // `gh pr create` would pass just as happily with the old end-of-run open.
  it('opens the pull request AFTER THE FIRST card, not after the last', async () => {
    scriptPlan();
    /** One ordered log of both kinds of event, which is the only way to see WHEN. */
    const events: string[] = [];
    const git = gitRunner((bin, args) => {
      if (bin === 'gh' && args[1] === 'create') events.push('pr-create');
      return undefined;
    });

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          events.push(`agent:${prompt}`);
          return { exitCode: 0, signal: null, model: 'claude-opus-5' };
        },
      },
    );

    // The create sits BETWEEN the two agents — after the first card landed and
    // before the second one started.
    expect(events).toEqual(['agent:PROMPT PROD-1', 'pr-create', 'agent:PROMPT PROD-2']);
    // And still exactly ONE pull request: `openSessionPr` lists before it
    // creates, so the second card finds the same one. The idempotence is the
    // helper's, and the fake `gh` above models it.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
  });

  it('the trigger is IMPLEMENTED, not ATTEMPTED — a failed first card opens nothing', async () => {
    scriptPlan();
    const events: string[] = [];
    const git = gitRunner((bin, args) => {
      if (bin === 'gh' && args[1] === 'create') events.push('pr-create');
      return undefined;
    });

    // The first agent dies; the second succeeds. `--keep-going` so the loop
    // reaches the second at all.
    let runs = 0;
    await autoCommand(
      { ...AGENT, keepGoing: true },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          events.push(`agent:${prompt}`);
          return { exitCode: (runs += 1) === 1 ? 9 : 0, signal: null, model: null };
        },
      },
    );

    // Nothing opened after the FAILED card — it left nothing to review. The
    // distinction is the one most likely to be got wrong, because "the first
    // card" reads as "the first attempt".
    expect(events.indexOf('pr-create')).toBeGreaterThan(events.indexOf('agent:PROMPT PROD-2'));
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
  });

  it('runs on its OWN clock and its OWN agent launcher when nothing is injected', async () => {
    scriptPlan();
    const git = gitRunner();

    // Only git is injected: the run id comes from the real clock, and the agent
    // is launched by the real `runAgent` (node itself, exiting 0). This is the
    // shape the binary actually runs in.
    await autoCommand(
      { agent: `${process.execPath} -e ""`, kinds: 'subtask', max: '1' },
      { run: git.run },
    );

    expect(v1CallsTo('POST', '/integration')).toHaveLength(1);
    // `--kinds` reached the server's own filter rather than being dropped —
    // as the ready collection's own REPEATED `kind` parameter (MOTIR-2398).
    expect(v1CallsTo('GET', '/ready')[0]?.query.getAll('kind')).toEqual(['subtask']);
    expect(
      git.log.some((cmd) =>
        /push origin refs\/remotes\/origin\/main:refs\/heads\/motir\/auto-\d{8}-\d{6}/.test(cmd),
      ),
    ).toBe(true);
  });

  it('--reset clears the persisted exclude list before the run starts', async () => {
    scriptPlan();
    const { addExclude, readExcludes } = await import('../src/sessionExcludes.js');
    addExclude(server.url, 'PROD', { key: 'PROD-99' });

    await autoCommand(
      { ...AGENT, reset: true, max: '1' },
      {
        run: gitRunner().run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    expect(readExcludes(server.url, 'PROD')).toEqual([]);
  });

  // MOTIR-2338 made the persisted list key-based; MOTIR-2398 made the PICK
  // key-based too, so the hold-out is applied inside the client's page walk and
  // the learn-the-id round trip is gone. ONE ask, and the excluded row is
  // skipped without the server ever being told about it.
  it('holds out an item a PREVIOUS run failed on, in ONE ask', async () => {
    scriptPlan();
    const { addExclude } = await import('../src/sessionExcludes.js');
    addExclude(server.url, 'PROD', { key: 'PROD-1' });

    await autoCommand(
      { ...AGENT, max: '1' },
      {
        run: gitRunner().run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    // ONE ready read: the exclusion is applied client-side over the ranked page,
    // so there is no second ask and no row id anywhere on the wire.
    const asks = v1CallsTo('GET', '/ready');
    expect(asks).toHaveLength(1);
    expect(JSON.stringify(asks[0]?.query ? [...asks[0].query] : [])).not.toContain('row-');
    // And PROD-1 was never dispatched.
    expect(v1CallsTo('GET', '/dispatch-prompt')).toEqual([]);
  });

  // ⚠️ SEED FIRST (MOTIR-2398). `targetRepo` lives on the PROMPT, and the seed
  // names a branch `repos.ensure` has not created yet — so the prompt is read
  // WITH the seed before the checkout is resolved. Asserted on the request
  // COUNT, because a seedless-then-seeded implementation produces identical
  // output and doubles the calls.
  it('reads the prompt ONCE per item when the repo has a checkout', async () => {
    scriptPlan();

    await autoCommand(
      { ...AGENT, max: '1' },
      {
        run: gitRunner().run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    const prompts = v1CallsTo('GET', '/dispatch-prompt');
    expect(prompts).toHaveLength(1);
    // And it carried the run's branch as the seed, before any checkout existed.
    expect(prompts[0]?.query.get('sessionBranch')).toBe('motir/auto-20260729-010203');
  });

  it('exits non-zero when an agent failed, and still opens the pull request', async () => {
    scriptPlan();
    const git = gitRunner();

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 7, signal: null, model: null }),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
    // The failed item was NOT reported as integrated.
    expect(v1CallsTo('POST', '/integration')).toEqual([]);
  });

  // MOTIR-1836. The exclude store used to live in the credential dir, which the
  // sandbox mounts READ-ONLY by design — so `addExclude`, called on EVERY failed
  // agent run, threw. The throw escaped `runAutoLoop` before `closeOutRepos()`
  // ran, and an unattended run that had already integrated work pushed nothing
  // and opened NO pull request: the exact case `closeOutRepos` exists to prevent.
  // The item that failed is a footnote; the run's whole output was the damage.
  it('closes out even when the store is UNWRITABLE and an agent fails (MOTIR-1836)', async () => {
    scriptPlan();
    const git = gitRunner();

    // The sandbox's own shape — an exclude store that cannot be written while
    // the credential beside it stays readable. Reproduced by making the store
    // path a DIRECTORY: `writeFileSync` then fails with EISDIR for EVERY uid,
    // including root, so this asserts the same thing on any runner (a `chmod`
    // fixture would quietly stop asserting anything as uid 0). The path is the
    // one the CONFIG home resolves to, which is where the store lived before
    // this fix and where `stateDir()` still falls back to — so the test bites
    // on the old code and the new alike.
    mkdirSync(join(configHome, 'motir', 'session-excludes.json'), { recursive: true });

    // The first item integrates; the second one's agent dies. Without
    // --keep-going the loop halts there — and must still close out item one.
    let runs = 0;
    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({
          exitCode: (runs += 1) === 1 ? 0 : 9,
          signal: null,
          model: null,
        }),
      },
    );

    expect(runs).toBe(2);
    expect(process.exitCode).toBe(1);
    // THE regression assertion: the pull request still opened.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
    // …carrying the work that landed before the failure, and only that.
    expect(v1CallsTo('POST', '/integration').map((c) => c.params['key'])).toEqual(['PROD-1']);
  });

  it('halts when git fails in a REAL checkout — before the item is touched', async () => {
    scriptPlan();
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
          return { exitCode: 0, signal: null, model: null };
        },
      },
    );

    expect(dispatches).toBe(0);
    // Nothing was claimed or transitioned — the failure precedes the status flip.
    expect(v1CallsTo('POST', '/transitions')).toEqual([]);
    expect(git.log.some((cmd) => cmd.includes('pr create'))).toBe(false);
  });

  it('runs an item whose repo has NO checkout with no lineage rather than failing the run', async () => {
    // `motir-ai` has no checkout under the root, so there is no repository to
    // open a session branch in: the item ships as its own pull request instead.
    let served = false;
    server.scriptV1({
      ...planScripts().v1,
      'GET /api/v1/projects/{projectKey}/ready': () => {
        if (served) return { body: v1Page([]) };
        served = true;
        return {
          body: v1Page([v1ReadyRow('PROD-9', { title: 'An item for an unchecked-out repo' })]),
        };
      },
      // The prompt is what says WHERE it ships — `motir-ai`, which has no
      // checkout under the root (MOTIR-2398: the repo comes from the prompt).
      'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => ({
        body: v1DispatchPrompt(String(req.params['key']), {
          prompt: `PROMPT ${String(req.params['key'])}`,
          targetRepo: 'motir-ai',
        }),
      }),
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
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    // The card was CLAIMED — the dispatch flip lives inside that one call now
    // (MOTIR-3048) — and nothing moved it afterwards: a bootstrap dispatch that
    // produced no checkout is a FAILED dispatch, so it earns no `implemented`.
    expect(v1CallsTo('POST', '/claim').length).toBeGreaterThan(0);
    expect(v1CallsTo('POST', '/transitions')).toEqual([]);
    expect(v1CallsTo('POST', '/integration')).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A MULTI-REPOSITORY card in an unattended run (Story MOTIR-2731 · MOTIR-3135)
// ─────────────────────────────────────────────────────────────────────────────
//
// `RepoSessions` was keyed by ONE resolved target, built from the primary — so a
// two-repository card got the run's session branch in the primary's checkout
// only. The prompt then instructed the agent to integrate into that branch in
// EVERY repository, and in the second one no such branch existed: the agent
// either invented one locally (which the close-out never pushes or opens a pull
// request for, because that repository was never `touched()`) or failed outright.
//
// The rule this pins is ALL-OR-NOTHING per card. A lineage in some of a card's
// repositories and not others is the one outcome that cannot be closed out, so
// a card whose set includes a repository that cannot carry the branch is
// dispatched with NO seed and ships as its own pull requests everywhere.

/** The plan, with both cards carrying `repos` (primary first). */
function multiRepoScripts(repos: string[]): { v1: V1Script } {
  const base = planScripts();
  return {
    v1: {
      ...base.v1,
      'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => {
        const key = String(req.params['key']);
        const seed = req.query.get('sessionBranch');
        return {
          body: v1DispatchPrompt(key, {
            prompt: `PROMPT ${key}`,
            targetRepo: repos[0],
            targetRepos: repos.map((name) => ({
              name,
              cloneUrl: null,
              defaultBranch: 'main',
              delivery: 'awaiting',
            })),
            workflowMode: seed ? 'session_lineage' : 'per_item_pr',
            sessionBranch: seed,
          }),
        };
      },
    },
  };
}

describe('motir auto — a card that ships in more than one repository (MOTIR-3135)', () => {
  it('creates the run’s session branch on origin in EVERY checkout the card carries', async () => {
    mkdirSync(join(root, 'motir-ai'), { recursive: true });
    server.scriptV1(multiRepoScripts(['motir-core', 'motir-ai']).v1);
    const git = gitRunner();

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    const branch = 'motir/auto-20260729-010203';
    // ONE branch NAME, created on origin in BOTH checkouts — asserted by the
    // CWD each git ran in, which is the only thing that distinguishes "branched
    // in two repositories" from "branched twice in one".
    expect(new Set(git.cwds.filter((c) => c.includes('motir-')))).toEqual(
      new Set([join(root, 'motir-core'), join(root, 'motir-ai')]),
    );
    expect(
      git.log.filter((cmd) => cmd.includes('push origin') && cmd.includes(branch)),
    ).toHaveLength(2);
    // …and the close-out opened one session pull request PER repository.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(2);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('branches a shared repository ONCE across two cards — the path-keyed cache holds', async () => {
    mkdirSync(join(root, 'motir-ai'), { recursive: true });
    server.scriptV1(multiRepoScripts(['motir-core', 'motir-ai']).v1);
    const git = gitRunner();

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    // Two cards, two repositories each — FOUR (card, repository) pairs, and
    // still exactly TWO branch creations and TWO pull requests, because the
    // second card reused both branches rather than re-creating them.
    const branch = 'motir/auto-20260729-010203';
    expect(
      git.log.filter((cmd) => cmd.includes('push origin') && cmd.includes(branch)),
    ).toHaveLength(2);
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(2);
    // Both cards were integrated, so the reuse is not "the second card was
    // skipped" wearing this assertion's clothes.
    expect(v1CallsTo('POST', '/integration').map((c) => c.params['key'])).toEqual([
      'PROD-1',
      'PROD-2',
    ]);
  });

  it('falls back to NO seed when one repository cannot carry the lineage, and says which', async () => {
    // `motir-ai` is never created, so its target is a bootstrap dispatch with no
    // checkout to branch in. All-or-nothing: the card ships as its own pull
    // requests in BOTH repositories rather than a lineage in one of them.
    server.scriptV1(multiRepoScripts(['motir-core', 'motir-ai']).v1);
    const git = gitRunner();
    const stderr: string[] = [];
    (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (chunk: string) => {
        stderr.push(String(chunk));
        return true;
      },
    );

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    const text = stderr.join('');
    expect(text).toContain('No session branch possible in');
    expect(text).toContain('motir-ai');
    expect(text).toContain('ships as its own pull requests in all of them');
    // No lineage was claimed for the card: the integration route was never called.
    expect(v1CallsTo('POST', '/integration')).toEqual([]);
    // …and no branch was left behind in the repository that COULD have carried
    // one — the un-carryable case is settled before anything is created.
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(0);
  });

  it('leaves a SINGLE-repository card’s lineage exactly as it was', async () => {
    // The back-compatibility claim: every card in the tenant today pins one
    // repository, and none of them can tell that this shipped.
    server.scriptV1(multiRepoScripts(['motir-core']).v1);
    const git = gitRunner();

    await autoCommand(
      { ...AGENT },
      {
        run: git.run,
        now: () => new Date(2026, 6, 29, 1, 2, 3),
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    const branch = 'motir/auto-20260729-010203';
    expect(v1CallsTo('POST', '/integration').map((c) => c.params['key'])).toEqual([
      'PROD-1',
      'PROD-2',
    ]);
    expect(
      new Set(
        v1CallsTo('POST', '/integration').map(
          (c) => (c.body as Record<string, unknown>)['sessionBranch'],
        ),
      ),
    ).toEqual(new Set([branch]));
    expect(git.log.filter((cmd) => cmd.includes('pr create'))).toHaveLength(1);
  });
});
