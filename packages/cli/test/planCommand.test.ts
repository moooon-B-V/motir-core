import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `prompts.ts` is a readline against a real TTY — no seam, and no TTY under a
// runner — so the READER is mocked here, exactly as `commands.interactive.test.ts`
// does. Every test below injects its own reader through `PlanDeps`; the mock
// exists so the ONE test that omits the injection still exercises the command's
// real defaults rather than opening a prompt nobody can answer.
const prompts = vi.hoisted(() => ({
  isInteractive: vi.fn(() => true),
  promptLine: vi.fn(async () => ''),
  promptLineOrNull: vi.fn(async (): Promise<string | null> => null),
  promptSecret: vi.fn(async () => ''),
}));
vi.mock('../src/prompts.js', () => prompts);

import { delay, planCommand, type PlanDeps } from '../src/commands/plan.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import { WATCH_TIMEOUT_MS } from '../src/plan.js';
import {
  startTestMcpServer,
  type TestMcpServer,
  type ToolScript,
} from './helpers/mcpTestServer.js';

// `motir plan` as the COMMAND (Subtask 7.9.9 · MOTIR-887).
//
// `plan.test.ts` pins the pure layer. This file drives the command the way the
// binary does — through the real project session, the real MCP client and a real
// MCP server — because what has to be proven here is the CONVERSATION's
// behaviour against the substrate: that a resumed thread is shown before
// anything is asked, that appending is not submitting, that leaving loses
// nothing, and that the un-onboarded guard fires BEFORE a single turn is
// appended. The reader and the watch clock are injected; nothing else is.

let server: TestMcpServer;
let root: string;
let cwd: string;

const TOKEN = 'pat_plan_token';

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-plan-'));
  root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  server.calls.length = 0;
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const OUT = (): string => stdout.join('');
const ERR = (): string => stderr.join('');

/** Calls the server received for one tool, in order. */
function callsTo(name: string): Record<string, unknown>[] {
  return server.calls.filter((c) => c.name === name).map((c) => c.args);
}

function sessionPayload(turns: { body: string; role?: 'user' | 'system'; jobId?: string }[] = []) {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [] as string[],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    turns: turns.map((t, i) => ({
      id: `t${i}`,
      seq: i,
      role: t.role ?? 'user',
      body: t.body,
      jobId: t.jobId ?? null,
      authorId: 'u1',
      createdAt: '2026-07-29T10:00:00.000Z',
    })),
  };
}

/**
 * A project with a plan, an accumulating thread, and a planner that lands.
 * `overrides` replaces individual tools per test.
 */
function tools(overrides: ToolScript = {}): ToolScript {
  const appended: string[] = [];
  return {
    // A non-empty tree: the un-onboarded guard's happy path.
    search_work_items: { structured: { items: [], total: 12, nextCursor: null } },
    open_plan_session: () => ({ structured: sessionPayload(appended.map((body) => ({ body }))) }),
    append_plan_turn: (args) => {
      appended.push(String(args.body));
      return { structured: sessionPayload(appended.map((body) => ({ body }))) };
    },
    submit_plan_session: () => ({
      structured: {
        jobId: 'job_1',
        planId: 'plan_1',
        session: sessionPayload(appended.map((body) => ({ body }))),
      },
    }),
    get_plan_status: {
      structured: {
        planId: 'plan_1',
        projectId: 'p1',
        status: 'planned',
        origin: 'user',
        jobId: 'job_1',
        itemCount: 2,
        job: null,
      },
    },
    get_plan: {
      structured: {
        id: 'plan_1',
        projectId: 'p1',
        status: 'planned',
        title: 'Billing split',
        summary: null,
        sourceJobId: 'job_1',
        origin: 'user',
        itemCount: 2,
        items: [
          {
            id: 'a',
            op: 'add',
            workItemId: null,
            proposedFields: { title: 'Billing epic', kind: 'story' },
            patch: null,
            parentRef: null,
            blockedByRefs: [],
          },
          {
            id: 'b',
            op: 'add',
            workItemId: null,
            proposedFields: {
              title: 'Invoice list',
              kind: 'subtask',
              type: 'code',
              storyPoints: 3,
            },
            patch: null,
            parentRef: 'planItem:a',
            blockedByRefs: [],
          },
        ],
      },
    },
    ...overrides,
  };
}

/** Scripted terminal input; exhausted input reads as end-of-stream (Ctrl-D). */
function reader(lines: (string | null)[]): PlanDeps {
  const queue = [...lines];
  return {
    interactive: () => true,
    readLine: async () => (queue.length > 0 ? (queue.shift() ?? null) : null),
    sleep: async () => {},
  };
}

describe('motir plan — the interactive conversation', () => {
  it('RESUMES the thread and renders its existing turns before prompting', async () => {
    server.script(
      tools({
        open_plan_session: {
          structured: {
            ...sessionPayload([
              { body: 'add auth to billing' },
              { body: 'Submitted.', role: 'system', jobId: 'job_0' },
            ]),
            lastJobId: 'job_0',
            lastSubmittedAt: '2026-07-29T11:00:00.000Z',
          },
        },
      }),
    );

    await planCommand([], {}, reader(['/exit']));

    expect(ERR()).toContain('Resumed the planning conversation (project-wide) — 2 turns.');
    expect(ERR()).toContain('[you] add auth to billing');
    expect(ERR()).toContain('[submitted → job job_0]');
    expect(ERR()).toContain('Last submitted 2026-07-29T11:00:00.000Z');
  });

  it('ACCUMULATES turns and sends them as ONE job on /submit', async () => {
    server.script(tools());

    await planCommand(
      [],
      {},
      reader(['add auth to the billing epic', 'keep them under 3 points', '/submit']),
    );

    const appends = callsTo('append_plan_turn');
    expect(appends.map((a) => a.body)).toEqual([
      'add auth to the billing epic',
      'keep them under 3 points',
    ]);
    // Two turns, ONE submit — the whole point of the accumulate/submit split.
    expect(callsTo('submit_plan_session')).toHaveLength(1);
    expect(ERR()).toContain('Turn 1 added — NOT submitted.');
    expect(ERR()).toContain('Turn 2 added — NOT submitted.');
  });

  it('leaves the thread intact on /exit — appended, never submitted', async () => {
    server.script(tools());

    await planCommand([], {}, reader(['add auth', '/exit']));

    expect(callsTo('append_plan_turn')).toHaveLength(1);
    expect(callsTo('submit_plan_session')).toHaveLength(0);
    expect(ERR()).toContain('1 turn saved and nothing submitted');
  });

  it('reads end of input (Ctrl-D) as leaving, never as submitting', async () => {
    server.script(tools());

    await planCommand([], {}, reader([]));

    expect(callsTo('submit_plan_session')).toHaveLength(0);
    expect(ERR()).toContain('nothing submitted');
  });

  it('ignores an empty line, prints /help, and refuses an unknown command without appending', async () => {
    server.script(tools());

    await planCommand([], {}, reader(['   ', '/help', '/sumbit', '/exit']));

    expect(callsTo('append_plan_turn')).toHaveLength(0);
    expect(ERR()).toContain('Unknown command /sumbit');
  });

  it('opens the ANCHORED thread when leading keys are given', async () => {
    server.script(tools());

    await planCommand(['motir-42', 'MOTIR-9'], {}, reader(['/exit']));

    expect(callsTo('open_plan_session')[0]).toEqual({
      projectKey: 'PROD',
      targetKeys: ['MOTIR-42', 'MOTIR-9'],
    });
  });

  it('omits targetKeys entirely for the project-wide thread', async () => {
    server.script(tools());

    await planCommand([], {}, reader(['/exit']));

    expect(callsTo('open_plan_session')[0]).toEqual({ projectKey: 'PROD' });
  });
});

describe('motir plan "<text>" — the non-interactive shorthand', () => {
  it('appends ONE turn, submits it, and prints the proposals it got back', async () => {
    server.script(tools());

    await planCommand(
      ['split', 'the', 'billing', 'epic'],
      {},
      { ...reader([]), interactive: () => false },
    );

    expect(callsTo('append_plan_turn')[0]).toMatchObject({ body: 'split the billing epic' });
    expect(callsTo('submit_plan_session')).toHaveLength(1);
    // Never opened a prompt: the shorthand is the unattended path.
    expect(OUT()).toContain('Plan plan_1 — planned, 2 proposals.');
    expect(OUT()).toContain('+ [story] Billing epic');
    expect(OUT()).toContain('    + [subtask/code] Invoice list (3 pts)');
    expect(OUT()).toContain('These are PROPOSALS, not work items.');
    expect(OUT()).toContain('refine');
    expect(OUT()).toContain('/plans/plan_1');
  });

  it('anchors the shorthand when it is given a key too', async () => {
    server.script(tools());

    await planCommand(['MOTIR-42', 'size', 'these'], {}, reader([]));

    expect(callsTo('append_plan_turn')[0]).toEqual({
      projectKey: 'PROD',
      targetKeys: ['MOTIR-42'],
      body: 'size these',
    });
  });

  it('ERRORS with guidance — never hangs — on a non-TTY invocation with no text', async () => {
    server.script(tools());

    await expect(planCommand([], {}, { interactive: () => false })).rejects.toMatchObject({
      message: expect.stringContaining('needs a terminal'),
      hint: expect.stringContaining('motir plan "<what to change>"'),
    });
    // Refused BEFORE anything was opened or appended.
    expect(server.calls).toHaveLength(0);
  });

  it('--detach returns the ids + review URL without watching', async () => {
    server.script(tools());

    await planCommand(['split the epic'], { detach: true }, reader([]));

    expect(OUT()).toContain('Job: job_1 · Plan: plan_1');
    expect(OUT()).toContain('Review: ');
    expect(OUT()).toContain('/plans/plan_1');
    expect(OUT()).toContain('These are PROPOSALS, not work items.');
    expect(callsTo('get_plan_status')).toHaveLength(0);
    expect(callsTo('get_plan')).toHaveLength(0);
  });
});

describe('motir plan — the un-onboarded guard', () => {
  it('refuses an EMPTY project with the onboarding URL, appending and submitting nothing', async () => {
    server.script(
      tools({ search_work_items: { structured: { items: [], total: 0, nextCursor: null } } }),
    );

    await expect(planCommand(['plan my thing'], {}, reader([]))).rejects.toMatchObject({
      message: expect.stringContaining('PROD has no work items yet'),
      hint: expect.stringContaining('/onboarding'),
    });

    // The AC that matters: the guard fires BEFORE a single turn is appended, so
    // nothing conversed its way into an augmentation of nothing.
    expect(callsTo('open_plan_session')).toHaveLength(0);
    expect(callsTo('append_plan_turn')).toHaveLength(0);
    expect(callsTo('submit_plan_session')).toHaveLength(0);
  });
});

describe('motir plan — the watch', () => {
  it('polls while the plan is generating, then prints the proposals', async () => {
    let reads = 0;
    server.script(
      tools({
        get_plan_status: () => {
          reads += 1;
          return {
            structured: {
              planId: 'plan_1',
              projectId: 'p1',
              status: reads < 3 ? 'generating' : 'planned',
              origin: 'user',
              jobId: 'job_1',
              itemCount: 2,
              job: reads < 3 ? { status: 'running', reachable: true, failure: null } : null,
            },
          };
        },
      }),
    );

    await planCommand(['do it'], {}, reader([]));

    expect(callsTo('get_plan_status')).toHaveLength(3);
    expect(OUT()).toContain('Plan plan_1 — planned, 2 proposals.');
  });

  it('surfaces a FAILED job with the server’s own code + message, and fails', async () => {
    server.script(
      tools({
        get_plan_status: {
          structured: {
            planId: 'plan_1',
            projectId: 'p1',
            status: 'generating',
            origin: 'user',
            jobId: 'job_1',
            itemCount: 0,
            job: {
              status: 'failed',
              reachable: true,
              failure: { code: 'AI_TIMEOUT', message: 'upstream model timed out' },
            },
          },
        },
      }),
    );

    const error = await planCommand(['do it'], {}, reader([])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('AI_TIMEOUT: upstream model timed out');
    expect((error as CliError).exitCode).toBe(1);
    // The turns survive a failed job — the thread is the durable thing.
    expect((error as CliError).hint).toContain('Your turns are intact');
  });

  it('reports an UNREACHABLE planner as such, not as a job failure', async () => {
    server.script(
      tools({
        get_plan_status: {
          structured: {
            planId: 'plan_1',
            projectId: 'p1',
            status: 'generating',
            origin: 'user',
            jobId: 'job_1',
            itemCount: 0,
            job: {
              status: null,
              reachable: false,
              failure: { code: 'AI_DOWN', message: 'no route' },
            },
          },
        },
      }),
    );

    await expect(planCommand(['do it'], {}, reader([]))).rejects.toMatchObject({
      message: expect.stringContaining('could not reach the AI planner — AI_DOWN: no route'),
    });
  });

  it('gives up on the WAIT, not on the plan, when the bounded watch times out', async () => {
    server.script(
      tools({
        get_plan_status: {
          structured: {
            planId: 'plan_1',
            projectId: 'p1',
            status: 'generating',
            origin: 'user',
            jobId: 'job_1',
            itemCount: 0,
            job: { status: 'running', reachable: true, failure: null },
          },
        },
      }),
    );

    // A clock that jumps past the bound on the second reading.
    let clock = 0;
    const deps: PlanDeps = {
      ...reader([]),
      now: () => {
        const value = clock;
        clock += WATCH_TIMEOUT_MS;
        return value;
      },
    };

    await expect(planCommand(['do it'], {}, deps)).rejects.toMatchObject({
      message: expect.stringContaining('still generating'),
      hint: expect.stringContaining('--detach'),
    });
  });
});

describe('motir plan — the production seams', () => {
  it('reads the terminal through the real prompt path when nothing is injected', async () => {
    server.script(tools());
    prompts.isInteractive.mockReturnValue(true);
    prompts.promptLineOrNull.mockResolvedValueOnce('add auth').mockResolvedValueOnce('/exit');

    // No deps at all: the command's own `isInteractive` / `promptLineOrNull`
    // defaults are what run here.
    await planCommand([], {});

    expect(prompts.isInteractive).toHaveBeenCalled();
    expect(callsTo('append_plan_turn')).toHaveLength(1);
    expect(callsTo('submit_plan_session')).toHaveLength(0);
  });

  it('watches on the real clock when no clock is injected', async () => {
    server.script(tools());

    await planCommand(['do it'], {}, { interactive: () => false });

    expect(callsTo('get_plan_status')).toHaveLength(1);
    expect(OUT()).toContain('Plan plan_1 — planned, 2 proposals.');
  });

  it('delay() resolves after its timeout — the real poll gap', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});

describe('motir plan — server refusals are reported verbatim', () => {
  it('surfaces an append refusal (a read-only token) as the server worded it', async () => {
    server.script(
      tools({ append_plan_turn: { error: 'FORBIDDEN: this token cannot change the plan.' } }),
    );

    await expect(planCommand([], {}, reader(['add auth', '/exit']))).rejects.toMatchObject({
      message: expect.stringContaining('FORBIDDEN: this token cannot change the plan.'),
    });
    // The thread still OPENED — a read-only token can read the conversation.
    expect(callsTo('open_plan_session')).toHaveLength(1);
  });

  it('surfaces the typed refusal of an EMPTY-thread submit', async () => {
    server.script(
      tools({
        submit_plan_session: {
          error: 'PLAN_CHANGE_SESSION_EMPTY: add a turn before submitting.',
        },
      }),
    );

    await expect(planCommand([], {}, reader(['/submit']))).rejects.toMatchObject({
      message: expect.stringContaining('PLAN_CHANGE_SESSION_EMPTY'),
    });
  });
});
