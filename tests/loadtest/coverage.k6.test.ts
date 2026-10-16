import { describe, expect, it } from 'vitest';
import {
  TRANSITION_PAIR,
  pickAgent,
  pickArgs,
  projectOf,
  shareOf,
  weightedPick,
} from '@/loadtest/k6/lib/agents.js';
import { classifyMcpResponse, headerValue, parseRpcBody } from '@/loadtest/k6/lib/classify.js';
import { holdStream, isEventStream, isRefusal } from '@/loadtest/k6/lib/holdStream.js';
import {
  burstIteration,
  claimIteration,
  readIteration,
  writeIteration,
} from '@/loadtest/k6/lib/iterations.js';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  EMPTY,
  ERROR,
  LIMITED,
  OK,
  backoffSeconds,
  parseRetryAfter,
} from '@/loadtest/k6/lib/outcome.js';
import { readerScenarios, readerSplit } from '@/loadtest/k6/lib/readerProfile.js';
import {
  NO_REVIEW_VERSION,
  browseTarget,
  readerIndexForVu,
  readerReuseWarning,
  readersFromManifest,
} from '@/loadtest/k6/lib/readerUsers.js';
import {
  FLUSH_ON_ENQUEUE,
  REPORTER_BATCH_LIMIT,
  RUN_EVENTS,
  RUN_HEARTBEAT_INTERVAL_MS,
  batches,
  closeBody,
  idempotencyKey,
  iterationRequests,
  openBody,
  pathFor,
  planIteration,
  requestsPerIteration,
  runSlice,
} from '@/loadtest/k6/runs/sequence.js';
import { endpointHost, endpointHostList } from '@/loadtest/lib/endpointHost';
import {
  EXIT,
  evaluateKey,
  formatLine,
  parseMachineList,
  parsePrintenv,
  parseSecretNames,
  refuseConfiguration,
  runPreflight,
  sentryProjectId,
  type FlyRunner,
  type PreflightConfig,
} from '@/loadtest/preflight/sideEffects';
import { SWITCH_TABLE, templateSetNames } from '@/loadtest/staging/sideEffectSwitches';

// The edges of the pure load-test helpers (Story MOTIR-8538 · MOTIR-8681): the
// refusals, fallbacks and malformed inputs the scenario-level suites
// (agentScenarios, readers, streamTally, sideEffectPreflight, runLifecycle) do not
// reach. Every case asserts the value the branch produces.

// ─── a small hand-built manifest ────────────────────────────────────────────

const card = (key: string) => ({ key });

function manifest() {
  return {
    projects: [
      {
        id: 'p1',
        key: 'P1',
        workspaceId: 'w1',
        readPlanIds: ['rp1', 'rp2'],
        content: { stories: [card('P1-1')], subtasks: [card('P1-2')] },
        pools: {
          write: [card('P1-W1')],
          claim: [card('P1-C1'), card('P1-C2')],
          run: [card('P1-R1'), card('P1-R2'), card('P1-R3')],
        },
      },
    ],
    agents: [
      { tokenId: 't1', role: 'write', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
      { tokenId: 't2', role: 'write', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
      { tokenId: 't3', role: 'read', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
      { tokenId: 't4', role: 'run', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
      { tokenId: 't5', role: 'run', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
      { tokenId: 't6', role: 'claim', projectId: 'p1', projectKey: 'P1', workspaceId: 'w1' },
    ],
  };
}

// ─── agents.js ──────────────────────────────────────────────────────────────

describe('agents — refusals and fallbacks', () => {
  it('pickAgent refuses a role the manifest has none of', () => {
    expect(() => pickAgent(manifest(), 'burst', 0)).toThrow('the manifest has no burst agents');
  });

  it('pickAgent walks negative VU ids onto a real agent with no slot', () => {
    const m = manifest();
    expect(pickAgent(m, 'write', -1)).toEqual({ agent: m.agents[1], slot: null });
  });

  it('projectOf refuses an agent whose project is not in the manifest', () => {
    const m = manifest();
    const stray = { ...m.agents[0], projectId: 'gone', projectKey: 'GONE' };
    expect(() => projectOf(m, stray)).toThrow("agent's project GONE is not in the manifest");
  });

  it('shareOf falls back to the whole pool when the agent is dealt no card', () => {
    const m = manifest();
    const pool = m.projects[0]!.pools.write;
    // Two write agents over a one-card pool: the second gets nothing of its own.
    expect(shareOf(m, m.agents[0], pool)).toEqual(pool);
    expect(shareOf(m, m.agents[1], pool)).toEqual(pool);
  });

  it('update_work_item sends a title on even iterations and a priority on odd ones', () => {
    const m = manifest();
    expect(pickArgs(m, m.agents[0], 'update_work_item', 2)).toEqual({
      key: 'P1-W1',
      title: '[loadtest] write-pool card, revision 2',
    });
    expect(pickArgs(m, m.agents[0], 'update_work_item', 1)).toEqual({
      key: 'P1-W1',
      priority: 'medium',
    });
  });

  it('pickArgs defaults the iteration counter to 0', () => {
    const m = manifest();
    expect(pickArgs(m, m.agents[2], 'get_work_item')).toEqual({ key: 'P1-1' });
  });

  it('move_to_parent refuses an agent with no burst slot', () => {
    const m = manifest();
    expect(() => pickArgs(m, m.agents[0], 'move_to_parent', 0)).toThrow(
      'agent t1 has no burst slot',
    );
  });

  it('pickArgs refuses a tool it has no picker for', () => {
    const m = manifest();
    expect(() => pickArgs(m, m.agents[0], 'delete_work_item', 0)).toThrow(
      'no argument picker for delete_work_item',
    );
  });

  it('weightedPick lands on the last tool when r reaches the total', () => {
    expect(weightedPick({ a: 1, b: 2, c: 0 }, 1)).toBe('b');
    expect(weightedPick({ a: 1, b: 2 }, 0)).toBe('a');
  });

  it('weightedPick refuses a mix with no positive weight', () => {
    expect(() => weightedPick({ a: 0, b: -1 }, 0.5)).toThrow('no tool has a positive weight');
  });
});

// ─── iterations.js ──────────────────────────────────────────────────────────

describe('iterations — call sequences', () => {
  function recorder(outcome: string = OK) {
    const calls: Array<[string, unknown]> = [];
    const call = (tool: string, args: unknown) => {
      calls.push([tool, args]);
      return { outcome, structured: null };
    };
    return { call, calls };
  }

  it('readIteration makes exactly one call to the weighted read tool', () => {
    const m = manifest();
    const { call, calls } = recorder();
    const out = readIteration(call, m, m.agents[2], 1, { get_plan: 1 }, 0.3);
    expect(out).toEqual([{ outcome: OK, structured: null }]);
    expect(calls).toEqual([['get_plan', { planId: 'rp2' }]]);
  });

  it('writeIteration sends a transition as the declared pair, other tools once', () => {
    const m = manifest();
    const pair = recorder();
    writeIteration(pair.call, m, m.agents[0], 0, { transition_status: 1 }, 0);
    expect(pair.calls).toEqual([
      ['transition_status', { key: 'P1-W1', status: TRANSITION_PAIR[0] }],
      ['transition_status', { key: 'P1-W1', status: TRANSITION_PAIR[1] }],
    ]);
    const one = recorder();
    writeIteration(one.call, m, m.agents[0], 3, { add_comment: 1 }, 0);
    expect(one.calls).toEqual([['add_comment', { key: 'P1-W1', body: 'load-test comment 3' }]]);
  });

  it('claimIteration releases nothing when the claim did no work', () => {
    const m = manifest();
    const { call, calls } = recorder(EMPTY);
    const out = claimIteration(call, m, m.agents[5], 1);
    expect(out).toHaveLength(1);
    expect(calls).toEqual([['claim_work_item', { key: 'P1-C2' }]]);
  });

  it('claimIteration releases a card it took', () => {
    const m = manifest();
    const { call, calls } = recorder(OK);
    claimIteration(call, m, m.agents[5], 0);
    expect(calls.map(([t]) => t)).toEqual([
      'claim_work_item',
      'update_work_item',
      'transition_status',
    ]);
    expect(calls[2]![1]).toEqual({ key: 'P1-C1', status: 'todo' });
  });

  it('burstIteration moves each slot card once, to the parent it is not under', () => {
    const m = manifest();
    const agent = {
      ...m.agents[0],
      burst: { cards: [card('B-1'), card('B-2')], parents: [card('PA'), card('PB')] },
    };
    const { call, calls } = recorder();
    burstIteration(call, m, agent, 1);
    expect(calls).toEqual([
      ['move_to_parent', { key: 'B-1', parentKey: 'PA' }],
      ['move_to_parent', { key: 'B-2', parentKey: 'PA' }],
    ]);
  });
});

// ─── classify.js ────────────────────────────────────────────────────────────

describe('classify — header and body edges', () => {
  it('headerValue reads a Headers-like object, a plain object in any case, and arrays', () => {
    expect(headerValue(undefined, 'retry-after')).toBeUndefined();
    expect(headerValue(new Headers({ 'Retry-After': '7' }), 'retry-after')).toBe('7');
    expect(headerValue(new Headers(), 'retry-after')).toBeUndefined();
    expect(headerValue({ 'Retry-After': '4' }, 'retry-after')).toBe('4');
    expect(headerValue({ 'retry-after': ['9', '10'] }, 'Retry-After')).toBe('9');
    expect(headerValue({ other: 'x' }, 'retry-after')).toBeUndefined();
  });

  it('parseRpcBody returns null for a body that parses to something not an object', () => {
    expect(parseRpcBody('data: null\n\n')).toBeNull();
    expect(parseRpcBody('data: 5\n')).toBeNull();
    expect(parseRpcBody('   ')).toBeNull();
    expect(parseRpcBody(undefined)).toBeNull();
    expect(parseRpcBody('event: message\ndata: {"result":{}}\n')).toEqual({ result: {} });
  });

  it('a 429 with no parseable body takes Retry-After from the plain-object headers', () => {
    const r = classifyMcpResponse({ status: 429, headers: { 'Retry-After': '3' }, body: '' });
    expect(r).toEqual({ outcome: LIMITED, retryAfterSeconds: 3, structured: null, result: null });
  });

  it('a per-tool RATE_LIMITED result with no retryAfterSeconds falls back to the header', () => {
    const body = JSON.stringify({
      result: { isError: true, structuredContent: { code: 'RATE_LIMITED' } },
    });
    const r = classifyMcpResponse({ status: 200, headers: { 'retry-after': '5' }, body });
    expect(r.outcome).toBe(LIMITED);
    expect(r.retryAfterSeconds).toBe(5);
    const none = classifyMcpResponse({ status: 200, body });
    expect(none.retryAfterSeconds).toBeNull();
  });

  it('a non-object structuredContent reads as no structured content', () => {
    const body = JSON.stringify({ result: { structuredContent: 'text' } });
    const r = classifyMcpResponse({ status: 200, body, tool: 'claim_work_item' });
    expect(r).toMatchObject({ outcome: OK, structured: null });
  });

  it('an isError result that is not a rate limit is an error carrying its content', () => {
    const body = JSON.stringify({ result: { isError: true, structuredContent: { code: 'X' } } });
    expect(classifyMcpResponse({ status: 200, body })).toMatchObject({
      outcome: ERROR,
      structured: { code: 'X' },
    });
  });
});

// ─── outcome.js ─────────────────────────────────────────────────────────────

describe('outcome — back-off arithmetic', () => {
  it('backoffSeconds uses the default for a missing or non-positive told value', () => {
    expect(backoffSeconds(undefined, 10)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(backoffSeconds(Number.POSITIVE_INFINITY, 10)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(backoffSeconds(-2, 10)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it('backoffSeconds caps at the maximum only when one is given', () => {
    expect(backoffSeconds(30, 5)).toBe(5);
    expect(backoffSeconds(30, undefined)).toBe(30);
    expect(backoffSeconds(30, 0)).toBe(30);
  });

  it('parseRetryAfter reads a positive number, else null', () => {
    expect(parseRetryAfter('2.5')).toBe(2.5);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(0)).toBeNull();
  });
});

// ─── holdStream.js ──────────────────────────────────────────────────────────

describe('holdStream — transport edges', () => {
  it('ignores events that are not watermark frames and holds without an onFrame', () => {
    let clock = 0;
    const r = holdStream({
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
      },
      holdMs: 1000,
      path: '/s',
      openStream: (
        _url: string,
        timeoutMs: number,
        onEvent: (e: { name: string; data: string }) => void,
      ) => {
        onEvent({ name: 'ping', data: '{}' });
        onEvent({ name: 'watermark', data: JSON.stringify({ cursor: 'c1', moved: [] }) });
        clock += timeoutMs;
        return { status: 200, contentType: 'text/event-stream' };
      },
    });
    expect(r).toMatchObject({ frames: 1, attempts: 1, drops: 0 });
  });

  it('hands each watermark frame to onFrame, skipping the non-frames', () => {
    let clock = 0;
    const seen: Array<{ cursor: string }> = [];
    holdStream({
      now: () => clock,
      sleep: () => {},
      holdMs: 1000,
      path: '/s',
      onFrame: (f: { cursor: string }) => seen.push(f),
      openStream: (
        _url: string,
        timeoutMs: number,
        onEvent: (e: { name: string; data: string }) => void,
      ) => {
        onEvent({ name: 'watermark', data: 'not json' });
        onEvent({ name: 'watermark', data: JSON.stringify({ cursor: 'c9', moved: ['x'] }) });
        clock += timeoutMs;
        return { status: 200, contentType: 'text/event-stream' };
      },
    });
    expect(seen).toEqual([{ cursor: 'c9', moved: ['x'] }]);
  });

  it('a transport that answers nothing and outlives the hold ends without a back-off', () => {
    let clock = 0;
    const slept: number[] = [];
    const attempts: Array<{ status: number; contentType: string | null; refused: boolean }> = [];
    const r = holdStream({
      now: () => clock,
      sleep: (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      holdMs: 1000,
      path: '/s',
      onAttempt: (a: { status: number; contentType: string | null; refused: boolean }) =>
        attempts.push(a),
      openStream: () => {
        clock += 5000;
        return null;
      },
    });
    expect(r.attempts).toBe(1);
    expect(r.opened).toBe(false);
    expect(slept).toEqual([]);
    expect(attempts).toEqual([
      expect.objectContaining({ status: 0, contentType: null, refused: false }),
    ]);
  });

  it('isEventStream and isRefusal read the content type, not just the status', () => {
    expect(isEventStream(undefined)).toBe(false);
    expect(isEventStream(' TEXT/EVENT-STREAM;charset=utf-8')).toBe(true);
    expect(isRefusal(200, 'text/html')).toBe(true);
    expect(isRefusal(408, null)).toBe(false);
  });
});

// ─── readerProfile.js ───────────────────────────────────────────────────────

describe('readerProfile — validation and empty sides', () => {
  const base = { readers: 4, rampSeconds: 10, durationSeconds: 20, holdSeconds: 5 };

  it('refuses a negative or non-numeric profile number', () => {
    expect(() => readerScenarios({ ...base, rampSeconds: -1 })).toThrow(
      'readerScenarios: rampSeconds must be a non-negative number',
    );
    expect(() => readerScenarios({ ...base, readers: Number.NaN })).toThrow(
      'readerScenarios: readers must be a non-negative number',
    );
  });

  it('leaves out an empty side and honours custom exec names', () => {
    const allTabs = readerScenarios({ ...base, tabShare: 1, exec: { tab: 'tabFn' } });
    expect(Object.keys(allTabs)).toEqual(['readerTab']);
    expect(allTabs.readerTab!.exec).toBe('tabFn');
    expect(allTabs.readerTab!.gracefulStop).toBe('35s');
    const allBrowse = readerScenarios({ ...base, tabShare: 0, exec: { browse: 'browseFn' } });
    expect(Object.keys(allBrowse)).toEqual(['readerBrowse']);
    expect(allBrowse.readerBrowse!.exec).toBe('browseFn');
    expect(readerScenarios({ ...base, readers: 0 })).toEqual({});
  });

  it('readerSplit floors the total and defaults the share', () => {
    expect(readerSplit(4.9)).toEqual({ tabs: 3, browsers: 1 });
    expect(readerSplit(-3)).toEqual({ tabs: 0, browsers: 0 });
  });
});

// ─── readerUsers.js ─────────────────────────────────────────────────────────

describe('readerUsers — manifests and browse targets', () => {
  it('readersFromManifest tolerates missing arrays and a project with no read plans', () => {
    expect(readersFromManifest({})).toEqual([]);
    const readers = readersFromManifest({
      projects: [{ id: 'p1' }],
      users: [
        { id: 'u1', readerWorkspaceId: 'w', readerProjectId: 'p1', cookieHeader: 'c=1' },
        { id: 'u2', readerWorkspaceId: 'w', readerProjectId: 'p9', cookieHeader: 'c=2' },
      ],
    });
    expect(readers.map((r: { readPlanIds: string[] }) => r.readPlanIds)).toEqual([[], []]);
  });

  it('readerIndexForVu refuses an empty manifest and wraps a VU id', () => {
    expect(() => readerIndexForVu(1, 0)).toThrow('the manifest holds no users to read as');
    expect(readerIndexForVu(0, 3)).toBe(2);
    expect(readerIndexForVu(5, 3)).toBe(1);
  });

  it('readerReuseWarning names the reuse only when VUs outnumber users', () => {
    expect(readerReuseWarning(2, 2)).toBeNull();
    expect(readerReuseWarning(3, 2)).toContain('3 reader VUs share 2 seeded users');
  });

  it('a plan step for a reader with no plans falls back to /items', () => {
    const reader = {};
    expect(browseTarget('plan_get', reader, {}, 0.5)).toEqual({ route: 'items', path: '/items' });
    expect(browseTarget('plan_poll', reader, {}, 0.5)).toEqual({ route: 'items', path: '/items' });
    expect(browseTarget('unknown', reader, {}, 0.5)).toEqual({ route: 'items', path: '/items' });
    expect(browseTarget('items', reader, {}, 0.5)).toEqual({ route: 'items', path: '/items' });
  });

  it('a poll sends the held reviewVersion, else the no-version sentinel', () => {
    const reader = { readPlanIds: ['a', 'b'] };
    expect(browseTarget('plan_poll', reader, { b: 'v 2' }, 0.99)).toEqual({
      route: 'plan_poll',
      path: '/api/plans/b?since=v%202',
      planId: 'b',
    });
    expect(browseTarget('plan_poll', reader, {}, 0)).toMatchObject({
      path: `/api/plans/a?since=${NO_REVIEW_VERSION}`,
    });
    expect(browseTarget('plan_get', reader, {}, 1)).toEqual({
      route: 'plan_get',
      path: '/api/plans/b',
      planId: 'b',
    });
  });

  it('items_page stays within page 2..itemsPages, and a tiny itemsPages still means page 2', () => {
    expect(browseTarget('items_page', {}, {}, 0.999, 4).path).toBe('/items?page=4');
    expect(browseTarget('items_page', {}, {}, 0)).toMatchObject({ path: '/items?page=2' });
    expect(browseTarget('items_page', {}, {}, 0.9, 1).path).toBe('/items?page=2');
    expect(browseTarget('boards', {}, {}, 0)).toEqual({ route: 'boards', path: '/boards' });
  });
});

// ─── runs/sequence.js ───────────────────────────────────────────────────────

/** One planned request, as the assertions below read it (sequence.js is untyped JS). */
interface PlannedRequest {
  op: string;
  atMs: number;
  body: { events: Array<{ kind: string }> };
}

function typedPlan(options: Parameters<typeof planIteration>[0]) {
  const plan = planIteration(options);
  return {
    before: plan.before as unknown as PlannedRequest[],
    after: plan.after as unknown as PlannedRequest[],
  };
}

describe('sequence — the run request plan', () => {
  it('pathFor substitutes and encodes params, and refuses unknown ops or missing params', () => {
    expect(pathFor('getWorkItem', { key: 'A 1' })).toBe('/api/v1/work-items/A%201');
    expect(pathFor('getMe')).toBe('/api/v1/me');
    expect(() => pathFor('nope')).toThrow('unknown run operation: nope');
    expect(() => pathFor('closeDispatchRun', { id: null })).toThrow(
      'closeDispatchRun: missing path param id',
    );
  });

  it('builds the idempotency key, open and close bodies', () => {
    expect(idempotencyKey(3, 7, 1000)).toBe('lt-3-7-1000');
    expect(openBody({ projectKey: 'P', key: 'P-1', idempotencyKey: 'k' })).toEqual({
      projectKey: 'P',
      command: 'run',
      origin: 'local',
      idempotencyKey: 'k',
      cards: [{ key: 'P-1', disposition: 'queued' }],
      agent: 'loadtest',
    });
    expect(closeBody()).toEqual({ stopReason: 'completed' });
  });

  it('checkout_ready names the repository only when one is given', () => {
    expect(RUN_EVENTS.checkoutReady('K', 'org/repo').data.repositories).toEqual(['org/repo']);
    expect(RUN_EVENTS.checkoutReady('K', null).data.repositories).toEqual([]);
    expect(FLUSH_ON_ENQUEUE).toEqual(['run_opened', 'checkout_ready']);
  });

  it('batches splits a queue at the reporter batch limit', () => {
    const events = Array.from({ length: REPORTER_BATCH_LIMIT + 1 }, (_, i) => i);
    const out = batches(events);
    expect(out.map((b: { events: unknown[] }) => b.events.length)).toEqual([
      REPORTER_BATCH_LIMIT,
      1,
    ]);
    expect(batches([])).toEqual([]);
  });

  it('a zero-length agent sends no mid-run beat; the close flushes the exit and verdict', () => {
    const plan = typedPlan({ key: 'K-1', projectKey: 'K', idempotencyKey: 'i' });
    expect(plan.before.map((r: { op: string }) => r.op)).toEqual([
      'getMe',
      'listWorkspaces',
      'getWorkItem',
      'claimWorkItem',
      'getWorkItemDispatchPrompt',
    ]);
    expect(plan.after.map((r: { op: string }) => r.op)).toEqual([
      'heartbeatDispatchRun',
      'appendDispatchRunEvents',
      'appendDispatchRunEvents',
      'listWorkItemDesigns',
      'getWorkItem',
      'appendDispatchRunEvents',
      'closeDispatchRun',
      'updateWorkItem',
      'transitionWorkItem',
    ]);
    const lastAppend = plan.after[5] as { body: { events: Array<{ kind: string }> } };
    expect(lastAppend.body.events.map((e) => e.kind)).toEqual([
      'prompt_issued',
      'agent_started',
      'agent_exited',
      'leg_verdict',
    ]);
  });

  it('a long agent beats each interval, adds stripped log events, and can skip the recycle', () => {
    const plan = typedPlan({
      key: 'K-1',
      projectKey: 'K',
      idempotencyKey: 'i',
      agentSeconds: (2 * RUN_HEARTBEAT_INTERVAL_MS) / 1000,
      logEventsPerBeat: 2.7,
      recycle: false,
    });
    const beats = plan.after.filter((r: { op: string }) => r.op === 'heartbeatDispatchRun');
    expect(beats.map((r: { atMs: number }) => r.atMs)).toEqual([
      0,
      RUN_HEARTBEAT_INTERVAL_MS,
      2 * RUN_HEARTBEAT_INTERVAL_MS,
    ]);
    const second = plan.after.find(
      (r: { op: string; atMs: number }) =>
        r.op === 'appendDispatchRunEvents' && r.atMs === 2 * RUN_HEARTBEAT_INTERVAL_MS,
    ) as { body: { events: Array<{ kind: string }> } };
    // Only the two log events: the queue was flushed at the first beat.
    expect(second.body.events.map((e) => e.kind)).toEqual(['log', 'log']);
    expect(plan.after.at(-1)!.op).toBe('closeDispatchRun');
  });

  it('a beat with nothing queued sends the heartbeat alone, no empty append', () => {
    const plan = typedPlan({
      key: 'K-1',
      projectKey: 'K',
      idempotencyKey: 'i',
      agentSeconds: (2 * RUN_HEARTBEAT_INTERVAL_MS) / 1000,
    });
    const atSecondBeat = plan.after
      .filter((r: { atMs: number }) => r.atMs === 2 * RUN_HEARTBEAT_INTERVAL_MS)
      .map((r: { op: string }) => r.op);
    // The heartbeat at t=2 intervals carries no append before it; the appends at
    // that instant are the exit + verdict flush that follows the replan read.
    expect(atSecondBeat.slice(0, 2)).toEqual(['heartbeatDispatchRun', 'getWorkItem']);
    expect(
      plan.after.filter((r: { op: string }) => r.op === 'appendDispatchRunEvents'),
    ).toHaveLength(4);
  });

  it('requestsPerIteration counts iterationRequests, with the recycle by default', () => {
    expect(requestsPerIteration({ agentSeconds: 0 })).toBe(15);
    expect(requestsPerIteration({ agentSeconds: 0, recycle: false })).toBe(13);
    expect(
      iterationRequests({ key: 'K-1', projectKey: 'K', idempotencyKey: 'i', agentSeconds: -5 }),
    ).toHaveLength(15);
  });

  it('runSlice deals disjoint cards to run agents and nothing to strangers', () => {
    const m = manifest();
    expect(runSlice(m, m.agents[3]).map((c: { key: string }) => c.key)).toEqual(['P1-R1', 'P1-R3']);
    expect(runSlice(m, m.agents[4]).map((c: { key: string }) => c.key)).toEqual(['P1-R2']);
    expect(runSlice(m, m.agents[0])).toEqual([]); // not a run agent
    expect(runSlice(m, { ...m.agents[3], projectId: 'gone' })).toEqual([]);
  });
});

// ─── lib/endpointHost.ts ────────────────────────────────────────────────────

describe('endpointHost — unreadable and port-carrying input', () => {
  it('returns null for an unparseable URL, a URL with no host and null input', () => {
    expect(endpointHost('postgresql://')).toBeNull();
    expect(endpointHost('http://[bad')).toBeNull();
    expect(endpointHost(null)).toBeNull();
    expect(endpointHost(undefined)).toBeNull();
    expect(endpointHost(':5432')).toBeNull();
  });

  it('strips a port and a -pooler suffix from a bare single-label host', () => {
    expect(endpointHost('EP-X-POOLER:5432')).toBe('ep-x');
    expect(endpointHost('localhost')).toBe('localhost');
  });

  it('endpointHostList drops unreadable entries and tolerates null', () => {
    expect(endpointHostList(null)).toEqual([]);
    expect(endpointHostList('a-pooler.x, ,b.y')).toEqual(['a.x', 'b.y']);
  });
});

// ─── preflight/sideEffects.ts ───────────────────────────────────────────────

describe('sideEffects — parsing', () => {
  it('parseMachineList falls back to the config image, then unknown, and defaults state and group', () => {
    const out = parseMachineList(
      JSON.stringify([
        { id: 'a', state: 'started', config: { image: 'reg/img:1' } },
        { id: 'b', image_ref: { digest: '' } },
      ]),
    );
    expect(out).toEqual([
      { id: 'a', state: 'started', group: 'app', image: 'reg/img:1' },
      { id: 'b', state: 'unknown', group: 'app', image: 'unknown' },
    ]);
    expect(() => parseMachineList('{}')).toThrow('fly machine list did not return an array');
  });

  it('parsePrintenv joins continuation lines and drops a leading stray line', () => {
    const env = parsePrintenv('stray\nKEY=-----BEGIN\nbody\n-----END\nB=2');
    expect(env.get('KEY')).toBe('-----BEGIN\nbody\n-----END');
    expect(env.get('B')).toBe('2');
    expect(env.size).toBe(2);
  });

  it('parseSecretNames reads either spelling and refuses a non-array', () => {
    expect(parseSecretNames(JSON.stringify([{ Name: 'A' }, { name: 'b' }]))).toEqual(['A', 'b']);
    expect(() => parseSecretNames('{}')).toThrow('fly secrets list did not return an array');
  });

  it('sentryProjectId reads a numeric last path segment only', () => {
    expect(sentryProjectId('https://k@o1.ingest.sentry.io/123')).toBe('123');
    expect(sentryProjectId('https://k@o1.ingest.sentry.io/abc')).toBeNull();
    expect(sentryProjectId('https://k@o1.ingest.sentry.io/')).toBeNull();
    expect(sentryProjectId('not a url')).toBeNull();
  });
});

describe('sideEffects — evaluateKey', () => {
  const config: PreflightConfig = {
    allowedDbHost: 'ep-stg.x.neon.tech',
    productionDbHosts: ['ep-prod.x.neon.tech'],
    productionSentryProjectId: '42',
  };
  const env = (o: Record<string, string>) => new Map(Object.entries(o));

  it('absent: set is live, unset passes', () => {
    const k = { key: 'K', state: { kind: 'absent' } } as const;
    expect(evaluateKey(k, env({}), config)).toEqual({ ok: true, reason: '' });
    expect(evaluateKey(k, env({ K: 'x' }), config)).toEqual({
      ok: false,
      reason: 'K is set (must be absent)',
    });
  });

  it('equals: unset, different and equal', () => {
    const k = { key: 'K', state: { kind: 'equals', value: 'v' } } as const;
    expect(evaluateKey(k, env({}), config).reason).toBe('K is not set (must be "v")');
    expect(evaluateKey(k, env({ K: 'w' }), config).reason).toBe('K is not "v"');
    expect(evaluateKey(k, env({ K: 'v' }), config).ok).toBe(true);
  });

  it('host-is-staging: unset, unreadable, production, another host, staging', () => {
    const k = { key: 'DB', state: { kind: 'host-is-staging' } } as const;
    expect(evaluateKey(k, env({}), config).reason).toBe('DB is not set');
    expect(evaluateKey(k, env({ DB: 'postgresql://' }), config).reason).toBe(
      'DB has no readable host',
    );
    expect(
      evaluateKey(k, env({ DB: 'postgresql://u@ep-prod-pooler.x.neon.tech/db' }), config).reason,
    ).toBe('DB points at a PRODUCTION host (ep-prod.x.neon.tech)');
    expect(evaluateKey(k, env({ DB: 'postgresql://u@other.host/db' }), config).reason).toBe(
      'DB host other.host is not the staging host ep-stg.x.neon.tech',
    );
    expect(evaluateKey(k, env({ DB: 'postgresql://u@ep-stg.x.neon.tech/db' }), config).ok).toBe(
      true,
    );
  });

  it('differs-from-production: unset, unreadable, production and another project', () => {
    const k = { key: 'DSN', state: { kind: 'differs-from-production' } } as const;
    expect(evaluateKey(k, env({}), config).reason).toBe('DSN is not set');
    expect(evaluateKey(k, env({ DSN: 'garbage' }), config).reason).toBe(
      'DSN has no readable project id',
    );
    expect(evaluateKey(k, env({ DSN: 'https://k@o.sentry.io/42' }), config).reason).toBe(
      "DSN is production's Sentry project (42)",
    );
    expect(evaluateKey(k, env({ DSN: 'https://k@o.sentry.io/43' }), config).ok).toBe(true);
  });
});

describe('sideEffects — refuseConfiguration', () => {
  const full = {
    LOADTEST_STAGING_APP: 'stg',
    LOADTEST_ALLOWED_DB_HOST: 'h',
    LOADTEST_PRODUCTION_DB_HOSTS: 'p',
    LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: '1',
  };

  it('names each missing or wrong piece, in order', () => {
    expect(refuseConfiguration('stg', {})).toMatch(/^LOADTEST_STAGING_APP is not set/);
    expect(refuseConfiguration(undefined, full)).toBe('--app is required.');
    expect(refuseConfiguration('motir-core', full)).toMatch(/is production/);
    expect(refuseConfiguration('other', full)).toBe(
      '--app other is not LOADTEST_STAGING_APP (stg).',
    );
    expect(refuseConfiguration('stg', { ...full, LOADTEST_ALLOWED_DB_HOST: ' ' })).toMatch(
      /^LOADTEST_ALLOWED_DB_HOST is not set/,
    );
    expect(refuseConfiguration('stg', { ...full, LOADTEST_PRODUCTION_DB_HOSTS: ' , ' })).toMatch(
      /^LOADTEST_PRODUCTION_DB_HOSTS is not set/,
    );
    expect(
      refuseConfiguration('stg', { ...full, LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: undefined }),
    ).toMatch(/^LOADTEST_PRODUCTION_SENTRY_PROJECT_ID is not set/);
    expect(refuseConfiguration('stg', full)).toBeNull();
  });
});

describe('sideEffects — runPreflight transport failures', () => {
  const env = {
    LOADTEST_STAGING_APP: 'stg',
    LOADTEST_ALLOWED_DB_HOST: 'ep-stg.x.neon.tech',
    LOADTEST_PRODUCTION_DB_HOSTS: 'ep-prod.x.neon.tech',
    LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: '42',
  };
  const machine = JSON.stringify([{ id: 'm1', state: 'started', config: { image: 'img' } }]);
  const secrets = JSON.stringify(templateSetNames().map((Name) => ({ Name })));

  it('reads --app=<name>, uses the real clock by default, and an ssh throw is UNREAD everywhere', async () => {
    const fly: FlyRunner = async (args) => {
      if (args[0] === 'machine') return { code: 0, stdout: machine, stderr: '' };
      if (args[0] === 'secrets') return { code: 0, stdout: secrets, stderr: '' };
      throw new Error('ssh: spawn failed');
    };
    const out = await runPreflight(['--app=stg'], env, fly);
    expect(out.exitCode).toBe(EXIT.unread);
    const machineLines = out.lines.filter((l) => l.machineId === 'm1');
    expect(machineLines.length).toBe(SWITCH_TABLE.length + 1);
    expect(machineLines.every((l) => l.verdict === 'UNREAD')).toBe(true);
    expect(machineLines.find((l) => l.row === 'required-set')!.detail).toBe(
      'environment not read (ssh: spawn failed)',
    );
    const covered = SWITCH_TABLE.find((r) => r.coveredBy)!;
    expect(machineLines.find((l) => l.row === covered.id)!.detail).toBe(
      `covered by ${covered.coveredBy}`,
    );
    expect(Number.isNaN(Date.parse(machineLines[0]!.readAt))).toBe(false);
    expect(formatLine(machineLines[0]!)).toContain('machine=m1 image=img');
  });

  it('a machine list that does not parse is UNREAD with no machine named', async () => {
    const fly: FlyRunner = async () => ({ code: 0, stdout: '{}', stderr: '' });
    const out = await runPreflight(['--app', 'stg'], env, fly, () => new Date(0));
    expect(out.exitCode).toBe(EXIT.unread);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.detail).toBe(
      'could not list machines: fly machine list did not return an array',
    );
    expect(out.message).toBe('1 unread: secret-names');
    expect(formatLine(out.lines[0]!)).not.toContain('machine=');
  });
});
