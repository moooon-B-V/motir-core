import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { batchCommand } from '../src/commands/batch.js';
import { nextCommand, runCommand } from '../src/commands/dispatch.js';
import { setCredential } from '../src/config/userConfig.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import {
  startTestServer,
  v1Detail,
  v1DispatchPrompt,
  v1Integration,
  v1Page,
  v1ReadyRow,
  type TestServer,
  type V1Request,
  type V1Script,
} from './helpers/testServer.js';

// THE RE-PLAN SIGNAL, end to end (MOTIR-3018).
//
// The dispatch prompt's THE-CARD-IS-WRONG branch tells an agent whose card is
// unbuildable to revert, comment, move the card to `planning`, submit a detached
// plan, and STOP — then exit 0. This file drives exactly that agent through all
// four entry points, over the REAL `/api/v1` protocol, against a server that
// enforces the SAME workflow edges `lib/workflows/defaultWorkflow.ts` seeds.
//
// ⚠️ THE SERVER HERE REFUSES WHAT THE REAL ONE REFUSES. `planning`'s outgoing
// edges are `in_progress`, `todo` and `cancelled` — there is no edge to
// `implemented` and none to `in_review`. A test server that accepted the
// close-out transition would let every assertion below pass against a CLI that
// still drags a parked card back into the pickable set, which is the whole
// defect. So the transitions route answers an illegal move with the real 422
// envelope (`{ code, error, allowedTransitions }`), and the integration route —
// whose service calls the same `updateStatus(implemented)` — refuses it too.

let server: TestServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_replan_token';

/**
 * The default workflow's outgoing edges, keyed by source status — transcribed
 * from `lib/workflows/defaultWorkflow.ts` so the fake server refuses exactly
 * what the real one refuses. Only the statuses this file moves through are
 * needed; an unlisted source is treated as permissive, so a test that starts
 * somewhere unmodelled fails on its own assertion rather than on this table.
 */
const LEGAL_TARGETS: Record<string, string[]> = {
  todo: ['in_progress', 'blocked', 'cancelled', 'planning'],
  in_progress: ['in_review', 'blocked', 'todo', 'cancelled', 'done', 'planning', 'implemented'],
  planning: ['in_progress', 'todo', 'cancelled'],
  implemented: ['in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
};

const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  implemented: 'Implemented',
  planning: 'Planning',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-replan-'));
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
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  server.v1Calls.length = 0;
  server.resetV1();
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The tenant the four entry points are driven against. */
interface Tenant {
  /** Every status write the server accepted, in order — the state of record. */
  statuses: Map<string, string>;
  /** Every transition the server REFUSED, so a test can say the CLI asked. */
  refused: { key: string; from: string; to: string }[];
  v1: V1Script;
}

/**
 * A server that keeps real status state and enforces the real edges.
 *
 * `mode` decides the workflow variant: `per_item_pr` closes out through
 * `POST …/transitions`, `session_lineage` through `POST …/integration`. Both
 * land on `implemented` (`workItemsService.markIntegrated` writes that key), so
 * both are refused from `planning` — which is why the reproduction has to drive
 * each of them rather than assuming one stands for the other.
 */
function tenant(mode: 'per_item_pr' | 'session_lineage', keys: string[] = ['PROD-7']): Tenant {
  const statuses = new Map<string, string>(keys.map((k) => [k, 'todo']));
  const refused: Tenant['refused'] = [];

  const move = (key: string, to: string): { ok: true } | { ok: false; from: string } => {
    const from = statuses.get(key) ?? 'todo';
    if (from === to) return { ok: true };
    const legal = LEGAL_TARGETS[from];
    if (legal && !legal.includes(to)) {
      refused.push({ key, from, to });
      return { ok: false, from };
    }
    statuses.set(key, to);
    return { ok: true };
  };

  const illegal = (key: string, from: string, to: string) => ({
    status: 422,
    body: {
      code: 'ILLEGAL_TRANSITION',
      error: `Illegal status transition: "${from}" → "${to}".`,
      allowedTransitions: (LEGAL_TARGETS[from] ?? []).map((k) => ({
        key: k,
        label: STATUS_LABEL[k] ?? k,
      })),
    },
  });

  const v1: V1Script = {
    'GET /api/v1/projects/{projectKey}/ready': () => ({
      body: v1Page(
        keys
          .filter((k) => (statuses.get(k) ?? 'todo') === 'todo')
          .map((k) =>
            v1ReadyRow(k, { title: `Item ${k}`, status: { key: 'todo', category: 'todo' } }),
          ),
      ),
    }),
    'GET /api/v1/work-items/{key}': (req) => {
      const key = String(req.params['key']);
      return { body: v1Detail(key, { status: statuses.get(key) ?? 'todo' }) };
    },
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => {
      const key = String(req.params['key']);
      const seed = req.query.get('sessionBranch');
      return {
        body: v1DispatchPrompt(key, {
          prompt: `PROMPT ${key}`,
          targetRepo: 'motir-core',
          workflowMode: mode,
          sessionBranch: mode === 'session_lineage' ? (seed ?? 'motir/auto-run') : null,
        }),
      };
    },
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const to = String((req.body as { status: string }).status);
      const result = move(key, to);
      if (!result.ok) return illegal(key, result.from, to);
      return { body: v1Detail(key, { status: statuses.get(key) ?? to }) };
    },
    'POST /api/v1/work-items/{key}/integration': (req) => {
      // `markIntegrated` transitions to `implemented` and stamps the branch —
      // the transition is part of the SAME service call, so a card at
      // `planning` is refused here exactly as it is on the transitions route.
      const key = String(req.params['key']);
      const result = move(key, 'implemented');
      if (!result.ok) return illegal(key, result.from, 'implemented');
      const sent = req.body as { sessionBranch: string };
      return {
        body: v1Integration(key, { sessionBranch: sent.sessionBranch, status: 'implemented' }),
      };
    },
  };

  return { statuses, refused, v1 };
}

/**
 * A scripted agent that performs the prompt's DEFECT PROTOCOL: it moves the card
 * to `planning` over the real API — the way a real agent would, with its own
 * credential — and exits 0. Nothing else; the revert, the comment and the plan
 * submission are the agent's business and change nothing about what the CLI
 * does next.
 */
function refusingAgent(key: string): { agent: string } {
  // ⚠️ A SCRIPT FILE, NOT `-e`. `parseAgentCommand` splits the agent command on
  // WHITESPACE, so an inline program is torn into argv words no quoting
  // survives. The file lives beside the workspace the test just made, so its
  // path never contains a space either.
  const path = join(root, `refusing-agent-${key}.mjs`);
  writeFileSync(
    path,
    [
      `const res = await fetch(${JSON.stringify(`${server.url}/api/v1/work-items/${key}/transitions`)}, {`,
      `  method: 'POST',`,
      `  headers: { authorization: ${JSON.stringify(`Bearer ${TOKEN}`)}, 'content-type': 'application/json' },`,
      `  body: JSON.stringify({ status: 'planning' }),`,
      `});`,
      // A refusal HERE would mean the agent could not park the card at all,
      // which is a different defect from the one under test — fail loudly
      // rather than exiting 0 and letting the CLI assertions explain it.
      `if (!res.ok) { console.error('agent could not park the card: ' + res.status); process.exit(9); }`,
      `process.exit(0);`,
    ].join('\n'),
  );
  return { agent: `${process.execPath} ${path}` };
}

/** A git runner that answers like a healthy repo whose work reached the remote. */
function gitRunner(): { run: CommandRunner; log: string[] } {
  const log: string[] = [];
  const run: CommandRunner = (bin, args) => {
    log.push(`${bin} ${args.join(' ')}`);
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
    if (bin === 'git' && args[0] === 'ls-remote') return ok('abc123\trefs/heads/subtask/PROD-7');
    if (bin === 'git' && args[0] === 'log') return ok('abc123');
    if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
    if (bin === 'git' && args[0] === 'rev-list') return ok('1');
    if (bin === 'gh' && args[1] === 'create') return ok('https://github.test/pull/1');
    return ok('');
  };
  return { run, log };
}

/**
 * An agent that FINISHES its card: it does nothing at all and exits 0, which is
 * exactly what a successful BYOK agent looks like from the CLI's side — the git
 * runner is what says the work reached the remote.
 */
function finishingAgent(): string {
  const path = join(root, 'finishing-agent.mjs');
  writeFileSync(path, 'process.exit(0);\n');
  return path;
}

/** Every `/api/v1` call the run made to one operation, in order. */
function callsTo(method: string, suffix: string): V1Request[] {
  return server.v1Calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

/**
 * Every status the run asked for AFTER the agent parked the card — the direct
 * evidence that no close-out was attempted.
 *
 * ⚠️ ASSERTING THE FINAL STATUS IS NOT ENOUGH. A run that asks for `implemented`
 * and is refused leaves the card at `planning` too, so the end state alone
 * cannot tell a fixed CLI from the broken one plus a strict server. This reads
 * the REQUESTS: the agent's own `planning` write is the last transition on the
 * wire, and anything after it is the defect.
 */
function transitionsAfterPlanning(): string[] {
  const asked = callsTo('POST', '/transitions').map((c) =>
    String((c.body as { status: string }).status),
  );
  const parked = asked.lastIndexOf('planning');
  return parked === -1 ? asked : asked.slice(parked + 1);
}

const VARIANTS = ['per_item_pr', 'session_lineage'] as const;

describe.each(VARIANTS)('a submitted re-plan on %s', (mode) => {
  it('motir run leaves the card in Planning and reports it as a refusal, not a failure', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', refusingAgent('PROD-7'), { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    // The card is where the agent put it, and NOTHING was attempted against it:
    // an assertion on the final status alone would also pass if the run had
    // asked and been refused.
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    // A correctly-refused card is a correct outcome, not a failed run.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('motir next leaves the card in Planning and reports it as a refusal', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await nextCommand(refusingAgent('PROD-7'), { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('motir auto stops on the submitted re-plan and never drags the card onward', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '2' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('motir batch', () => {
  it('records a submitted re-plan as a skip, not an agent failure (per_item_pr)', async () => {
    const t = tenant('per_item_pr');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await batchCommand({ ...refusingAgent('PROD-7'), max: '1' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  // ⚠️ NOT the defect, and asserted so it is never mistaken for it. `batch`
  // refuses a session-lineage item BEFORE dispatching it (`dispatchOne`,
  // `commands/batch.ts`) — integrating onto a session branch is precisely what
  // this command guarantees it never does. So the card is never claimed, never
  // dispatched, and stays exactly where the snapshot found it; the re-plan path
  // is structurally out of reach here rather than working by accident.
  it('never dispatches a session-lineage item at all, so the card is untouched', async () => {
    const t = tenant('session_lineage');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await batchCommand({ ...refusingAgent('PROD-7'), max: '1' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('todo');
    expect(t.refused).toHaveLength(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('the run that FINISHES is unchanged', () => {
  // The read-back is a branch, and a branch nothing takes the other arm of is a
  // switch that could be stuck. A card the agent did NOT park must still close
  // out exactly as it did before this card existed.
  it('still records an ordinary card as implemented on per_item_pr', async () => {
    const t = tenant('per_item_pr');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', { agent: `${process.execPath} ${finishingAgent()}` }, { run });

    expect(t.statuses.get('PROD-7')).toBe('implemented');
    expect(t.refused).toHaveLength(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('still integrates an ordinary card on session_lineage', async () => {
    const t = tenant('session_lineage');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', { agent: `${process.execPath} ${finishingAgent()}` }, { run });

    expect(t.statuses.get('PROD-7')).toBe('implemented');
    expect(callsTo('POST', '/integration')).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
