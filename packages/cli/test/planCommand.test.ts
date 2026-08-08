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
import { CliError, ScopeError } from '../src/errors.js';
import { WATCH_TIMEOUT_MS } from '../src/plan.js';
import {
  startTestServer,
  v1JobHandle,
  v1Plan,
  v1PlanOutcome,
  v1PlanSession,
  v1PlanTurn,
  v1Proposal,
  type TestServer,
  type V1Script,
} from './helpers/testServer.js';

// `motir plan` as the COMMAND (Subtask 7.9.9 · MOTIR-887).
//
// `plan.test.ts` pins the pure layer. This file drives the command the way the
// binary does — through the real project session, the real MCP client and a real
// MCP server — because what has to be proven here is the CONVERSATION's
// behaviour against the substrate: that a resumed thread is shown before
// anything is asked, that appending is not submitting, that leaving loses
// nothing, and that the un-onboarded guard fires BEFORE a single turn is
// appended. The reader and the watch clock are injected; nothing else is.

let server: TestServer;
let root: string;
let cwd: string;

const TOKEN = 'pat_plan_token';

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
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
  server.v1Calls.length = 0;
  server.resetV1();
  // Every test but the un-onboarded guard needs a non-empty tree: the guard
  // asks the COUNT whether there is a plan here to change.
  server.scriptV1({
    'GET /api/v1/projects/{projectKey}/work-items/count': { body: { count: 12 } },
  });
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const OUT = (): string => stdout.join('');
const ERR = (): string => stderr.join('');

/**
 * WHICH `/api/v1` request each planning call is, by verb and path.
 *
 * The five methods moved off MCP in MOTIR-2341, so what the assertions below
 * name is an operation rather than a tool. Kept as a map so a test still reads
 * `callsTo('append_plan_turn')` — the question a test asks ("was the turn
 * appended, and with what?") did not change when the transport did.
 */
const V1_ROUTE: Record<string, { method: string; matches: (path: string) => boolean }> = {
  open_plan_session: { method: 'POST', matches: (p) => p.endsWith('/plan-session') },
  append_plan_turn: { method: 'POST', matches: (p) => p.endsWith('/plan-session/turns') },
  submit_plan_session: {
    method: 'POST',
    matches: (p) => p.endsWith('/plan-session/submissions'),
  },
  get_plan_status: { method: 'GET', matches: (p) => p.endsWith('/status') },
  get_plan: { method: 'GET', matches: (p) => /^\/api\/v1\/plans\/[^/]+$/.test(p) },
};

/**
 * The arguments one operation received, in order.
 *
 * Path parameters and request body MERGED, because that is where the MCP tool's
 * one `arguments` object went: `projectKey` became a path segment and
 * `body` / `targetKeys` became a JSON body. Merging keeps every assertion below
 * asking about the ARGUMENT rather than about where v1 chose to carry it.
 */
function callsTo(name: string): Record<string, unknown>[] {
  const route = V1_ROUTE[name];
  if (!route) throw new Error(`no v1 route mapped for ${name}`);
  return server.v1Calls
    .filter((c) => c.method === route.method && route.matches(c.path))
    .map((c) => ({ ...c.params, ...((c.body ?? {}) as Record<string, unknown>) }));
}

function sessionPayload(
  turns: {
    body: string;
    role?: 'user' | 'system' | 'assistant';
    jobId?: string;
    /** The ONE clarifying question an `assistant` turn asked (MOTIR-2397). */
    question?: string;
    /** A `user` turn sent in REPLY to that question, rather than one that
     *  changed the subject. */
    isAnswer?: boolean;
  }[] = [],
  over: Record<string, unknown> = {},
) {
  return v1PlanSession(
    turns.map((t, i) =>
      v1PlanTurn(i, {
        id: `t${i}`,
        role: t.role ?? 'user',
        body: t.body,
        jobId: t.jobId ?? null,
        question: t.question ?? null,
        isAnswer: t.isAnswer ?? false,
        authorId: 'u1',
        createdAt: '2026-07-29T10:00:00.000Z',
      }),
    ),
    {
      id: 's1',
      createdAt: '2026-07-29T10:00:00.000Z',
      updatedAt: '2026-07-29T10:00:00.000Z',
      ...over,
    },
  );
}

/**
 * A project with a plan, an accumulating thread, and a planner that lands.
 * `overrides` replaces individual routes per test.
 *
 * ⚠️ The thread ACCUMULATES in a closure shared by open / append / submit,
 * because that is the property the command's whole grammar rests on: appending
 * is not submitting, and a `/submit` sends every turn typed so far as one
 * change. Three independent fixtures could not express it.
 */
function planScript(overrides: V1Script = {}): V1Script {
  const appended: string[] = [];
  return {
    'POST /api/v1/projects/{projectKey}/plan-session': () => ({
      body: sessionPayload(appended.map((body) => ({ body }))),
    }),
    'POST /api/v1/projects/{projectKey}/plan-session/turns': (req) => {
      appended.push(String((req.body as { body: string }).body));
      return { body: sessionPayload(appended.map((body) => ({ body }))) };
    },
    // 202: the job is ACCEPTED, and the handle is all that comes back — the
    // thread is not re-sent, because nothing reads it after a submit.
    'POST /api/v1/projects/{projectKey}/plan-session/submissions': {
      status: 202,
      body: v1JobHandle({ jobId: 'job_1', planId: 'plan_1' }),
    },
    'GET /api/v1/plans/{planId}/status': {
      body: v1PlanOutcome({ planId: 'plan_1', jobId: 'job_1', proposalCount: 2 }),
    },
    'GET /api/v1/plans/{planId}': {
      body: v1Plan(
        [
          v1Proposal('a', {
            proposedFields: {
              title: 'Billing epic',
              kind: 'story',
              type: null,
              priority: null,
              executor: null,
              storyPoints: null,
              estimateMinutes: null,
              descriptionMd: null,
              targetRepo: null,
            },
          }),
          v1Proposal('b', {
            proposedFields: {
              title: 'Invoice list',
              kind: 'subtask',
              type: 'code',
              priority: null,
              executor: null,
              storyPoints: 3,
              estimateMinutes: null,
              descriptionMd: null,
              targetRepo: null,
            },
            parentRef: 'planItem:a',
          }),
        ],
        { id: 'plan_1', title: 'Billing split', sourceJobId: 'job_1' },
      ),
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
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session': {
          body: sessionPayload(
            [
              { body: 'add auth to billing' },
              { body: 'Submitted.', role: 'system', jobId: 'job_0' },
            ],
            { lastJobId: 'job_0', lastSubmittedAt: '2026-07-29T11:00:00.000Z' },
          ),
        },
      }),
    );

    await planCommand([], {}, reader(['/exit']));

    expect(ERR()).toContain('Resumed the planning conversation (project-wide) — 2 turns.');
    expect(ERR()).toContain('[you] add auth to billing');
    expect(ERR()).toContain('[submitted → job job_0]');
    expect(ERR()).toContain('Last submitted 2026-07-29T11:00:00.000Z');
  });

  // MOTIR-2397 end to end: a thread carrying ALL THREE roles, resumed through
  // the real server → transport → adapter → renderer path. The regression this
  // holds is that the planner's own words reached the terminal under the user's
  // name, which in a conversation is the one thing a reader relies on.
  it('attributes each of the THREE roles to its own author on a resumed thread', async () => {
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session': {
          body: sessionPayload([
            { body: 'add auth to billing' },
            { body: 'Submitted.', role: 'system', jobId: 'job_0' },
            { body: 'I searched the tree — MOTIR-812 already covers this.', role: 'assistant' },
          ]),
        },
      }),
    );

    await planCommand([], {}, reader(['/exit']));

    expect(ERR()).toContain('[you] add auth to billing');
    expect(ERR()).toContain('[submitted → job job_0] Submitted.');
    expect(ERR()).toContain('[Motir AI] I searched the tree — MOTIR-812 already covers this.');
    // A report wants nothing: it changes only the transcript.
    expect(ERR()).not.toContain('Waiting for your answer');
  });

  it('resumes a thread BLOCKED on a question saying what it waits for', async () => {
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session': {
          body: sessionPayload([
            { body: 'add billing' },
            {
              body: 'Two readings here, and I cannot rank them.',
              role: 'assistant',
              question: 'Should billing cover refunds too?',
            },
          ]),
        },
      }),
    );

    await planCommand([], {}, reader(['/exit']));

    expect(ERR()).toContain('[Motir AI · asking] Two readings here');
    expect(ERR()).toContain('[?] Waiting for your answer');
    expect(ERR()).toContain('Should billing cover refunds too?');
    expect(ERR()).toContain('Type your answer as the next turn');
  });

  it('marks how a question was disposed of — answered, and superseded', async () => {
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session': {
          body: sessionPayload([
            { body: 'Refunds?', role: 'assistant', question: 'Refunds too?' },
            { body: 'yes, refunds', isAnswer: true },
            { body: 'And credits?', role: 'assistant', question: 'Credits as well?' },
            { body: 'actually, drop billing entirely' },
          ]),
        },
      }),
    );

    await planCommand([], {}, reader(['/exit']));

    expect(ERR()).toContain('[you · answer] yes, refunds');
    expect(ERR()).toContain('↳ Answered — planning resumed.');
    expect(ERR()).toContain('↳ Not answered — Motir AI carried on with what you asked.');
    // The superseded question is MARKED, never dropped — and the thread is no
    // longer blocked, so nothing claims it is waiting.
    expect(ERR()).toContain('[Motir AI · asking] And credits?');
    expect(ERR()).not.toContain('Waiting for your answer');
  });

  it('ACCUMULATES turns and sends them as ONE job on /submit', async () => {
    server.scriptV1(planScript());

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
    server.scriptV1(planScript());

    await planCommand([], {}, reader(['add auth', '/exit']));

    expect(callsTo('append_plan_turn')).toHaveLength(1);
    expect(callsTo('submit_plan_session')).toHaveLength(0);
    expect(ERR()).toContain('1 turn saved and nothing submitted');
  });

  it('reads end of input (Ctrl-D) as leaving, never as submitting', async () => {
    server.scriptV1(planScript());

    await planCommand([], {}, reader([]));

    expect(callsTo('submit_plan_session')).toHaveLength(0);
    expect(ERR()).toContain('nothing submitted');
  });

  it('ignores an empty line, prints /help, and refuses an unknown command without appending', async () => {
    server.scriptV1(planScript());

    await planCommand([], {}, reader(['   ', '/help', '/sumbit', '/exit']));

    expect(callsTo('append_plan_turn')).toHaveLength(0);
    expect(ERR()).toContain('Unknown command /sumbit');
  });

  it('opens the ANCHORED thread when leading keys are given', async () => {
    server.scriptV1(planScript());

    await planCommand(['motir-42', 'MOTIR-9'], {}, reader(['/exit']));

    expect(callsTo('open_plan_session')[0]).toEqual({
      projectKey: 'PROD',
      targetKeys: ['MOTIR-42', 'MOTIR-9'],
    });
  });

  it('omits targetKeys entirely for the project-wide thread', async () => {
    server.scriptV1(planScript());

    await planCommand([], {}, reader(['/exit']));

    expect(callsTo('open_plan_session')[0]).toEqual({ projectKey: 'PROD' });
  });
});

describe('motir plan "<text>" — the non-interactive shorthand', () => {
  it('appends ONE turn, submits it, and prints the proposals it got back', async () => {
    server.scriptV1(planScript());

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
    server.scriptV1(planScript());

    await planCommand(['MOTIR-42', 'size', 'these'], {}, reader([]));

    expect(callsTo('append_plan_turn')[0]).toEqual({
      projectKey: 'PROD',
      targetKeys: ['MOTIR-42'],
      body: 'size these',
    });
  });

  it('ERRORS with guidance — never hangs — on a non-TTY invocation with no text', async () => {
    server.scriptV1(planScript());

    await expect(planCommand([], {}, { interactive: () => false })).rejects.toMatchObject({
      message: expect.stringContaining('needs a terminal'),
      hint: expect.stringContaining('motir plan "<what to change>"'),
    });
    // Refused BEFORE anything was opened or appended.
    expect(server.v1Calls).toHaveLength(0);
  });

  it('--detach returns the ids + review URL without watching', async () => {
    server.scriptV1(planScript());

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
    server.scriptV1(planScript());
    // A tree with NOTHING in it — the count is what the guard asks for now
    // (MOTIR-2319); it used to run a `limit: 1` search and read its total.
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/work-items/count': { body: { count: 0 } },
    });

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
    server.scriptV1(
      planScript({
        'GET /api/v1/plans/{planId}/status': () => {
          reads += 1;
          return {
            body: v1PlanOutcome({
              planId: 'plan_1',
              status: reads < 3 ? 'generating' : 'planned',
              jobId: 'job_1',
              proposalCount: 2,
              job: reads < 3 ? { status: 'running', reachable: true, failure: null } : null,
            }),
          };
        },
      }),
    );

    await planCommand(['do it'], {}, reader([]));

    expect(callsTo('get_plan_status')).toHaveLength(3);
    expect(OUT()).toContain('Plan plan_1 — planned, 2 proposals.');
  });

  it('surfaces a FAILED job with the server’s own code + message, and fails', async () => {
    server.scriptV1(
      planScript({
        'GET /api/v1/plans/{planId}/status': {
          body: v1PlanOutcome({
            planId: 'plan_1',
            status: 'generating',
            jobId: 'job_1',
            job: {
              status: 'failed',
              reachable: true,
              failure: { code: 'AI_TIMEOUT', message: 'upstream model timed out' },
            },
          }),
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
    server.scriptV1(
      planScript({
        'GET /api/v1/plans/{planId}/status': {
          body: v1PlanOutcome({
            planId: 'plan_1',
            status: 'generating',
            jobId: 'job_1',
            job: {
              status: null,
              reachable: false,
              failure: { code: 'AI_DOWN', message: 'no route' },
            },
          }),
        },
      }),
    );

    await expect(planCommand(['do it'], {}, reader([]))).rejects.toMatchObject({
      message: expect.stringContaining('could not reach the AI planner — AI_DOWN: no route'),
    });
  });

  it('gives up on the WAIT, not on the plan, when the bounded watch times out', async () => {
    server.scriptV1(
      planScript({
        'GET /api/v1/plans/{planId}/status': {
          body: v1PlanOutcome({
            planId: 'plan_1',
            status: 'generating',
            jobId: 'job_1',
            job: { status: 'running', reachable: true, failure: null },
          }),
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
    server.scriptV1(planScript());
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
    server.scriptV1(planScript());

    await planCommand(['do it'], {}, { interactive: () => false });

    expect(callsTo('get_plan_status')).toHaveLength(1);
    expect(OUT()).toContain('Plan plan_1 — planned, 2 proposals.');
  });

  it('delay() resolves after its timeout — the real poll gap', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});

describe('motir plan — server refusals are reported verbatim', () => {
  // ⚠️ A read-only token now gets a ScopeError NAMING the scope it lacks, where
  // the MCP tool sent back a sentence. That is the v1 error model rather than a
  // rewording: 403 means "valid token, wrong scope" by contract, so the client
  // can say WHICH scope and what to do about it — which "FORBIDDEN: this token
  // cannot change the plan" never could.
  it('names the SCOPE a read-only token is missing when an append is refused', async () => {
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session/turns': {
          status: 403,
          body: { code: 'FORBIDDEN', error: 'This token cannot change the plan.' },
        },
      }),
    );

    const failure = await planCommand([], {}, reader(['add auth', '/exit'])).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ScopeError);
    expect((failure as ScopeError).message).toContain('work_items:write');

    // The thread still OPENED — reading the conversation needs `read` alone,
    // which is why the two operations declare different scopes.
    expect(callsTo('open_plan_session')).toHaveLength(1);
  });

  it('surfaces the typed refusal of an EMPTY-thread submit', async () => {
    server.scriptV1(
      planScript({
        'POST /api/v1/projects/{projectKey}/plan-session/submissions': {
          status: 422,
          body: {
            code: 'PLAN_CHANGE_SESSION_EMPTY',
            error: 'PLAN_CHANGE_SESSION_EMPTY: add a turn before submitting.',
          },
        },
      }),
    );

    await expect(planCommand([], {}, reader(['/submit']))).rejects.toMatchObject({
      message: expect.stringContaining('PLAN_CHANGE_SESSION_EMPTY'),
    });
  });
});
