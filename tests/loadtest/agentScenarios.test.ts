import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backoffSeconds, EMPTY, ERROR, LIMITED, OK, OUTCOMES } from '@/loadtest/k6/lib/outcome.js';
import { classifyMcpResponse } from '@/loadtest/k6/lib/classify.js';
import { recordCall, ROLE_AGENT } from '@/loadtest/k6/lib/record.js';
import {
  agentsOfRole,
  pickAgent,
  pickArgs,
  TOOL_SCHEMAS,
  TRANSITION_PAIR,
  weightedPick,
} from '@/loadtest/k6/lib/agents.js';
import {
  burstIteration,
  claimIteration,
  MIX,
  writeIteration,
} from '@/loadtest/k6/lib/iterations.js';
import type { ManifestAgent, ManifestCard, SeedManifest } from '@/loadtest/seed/manifest';
import { SMOKE_SHAPE } from '@/loadtest/seed/shape';

// Story MOTIR-8538 · MOTIR-8675 — the agent scenarios' pure halves: the outcome
// classifier, the metric recorder, the agent and argument pickers and the
// iteration bodies. k6 itself is not run here (the end-to-end card does that);
// everything a scenario decides is decided in these functions.

// ── A synthetic manifest: two workspaces, two projects, every role ──────────

let seq = 0;
const cards = (prefix: string, n: number): ManifestCard[] =>
  Array.from({ length: n }, () => ({ id: `id-${prefix}-${++seq}`, key: `${prefix}-${seq}` }));

function project(key: string, workspaceId: string) {
  return {
    id: `proj-${key}`,
    key,
    workspaceId,
    content: { stories: cards(key, 2), subtasks: cards(key, 4) },
    pools: {
      claim: cards(key, 6),
      run: cards(key, 3),
      write: cards(key, 6),
      parents: { claim: cards(key, 1)[0]!, run: cards(key, 1)[0]!, write: cards(key, 1)[0]! },
    },
    readPlanIds: [`readplan-${key}-0`, `readplan-${key}-1`],
    scratchPlanIds: [] as string[],
  };
}

const projects = [project('LA', 'ws-a'), project('LB', 'ws-b')];
let tokenSeq = 0;
function agent(
  role: ManifestAgent['role'],
  p: (typeof projects)[number],
  burst = false,
): ManifestAgent {
  const n = ++tokenSeq;
  const a: ManifestAgent = {
    tokenId: `tok-${n}`,
    token: `motir_pat_secret${n}`,
    role,
    userId: `user-${n % 3}`,
    workspaceId: p.workspaceId,
    projectId: p.id,
    projectKey: p.key,
    scratchPlanIds: role === 'write' ? [`scratch-${n}`] : [],
  };
  if (role === 'write') p.scratchPlanIds.push(...a.scratchPlanIds);
  if (burst) {
    const parents = cards(`${p.key}B${n}P`, 2);
    a.burst = { cards: cards(`${p.key}B${n}`, 5), parents: [parents[0]!, parents[1]!] };
  }
  return a;
}

const agents: ManifestAgent[] = [];
for (const p of projects) {
  agents.push(agent('read', p), agent('read', p), agent('write', p, true), agent('write', p, true));
  agents.push(agent('write', p), agent('claim', p), agent('claim', p), agent('run', p));
}

const manifest = {
  version: 1,
  runTag: 'unit',
  seededAt: '2026-10-15T00:00:00Z',
  baseUrl: 'http://localhost:3000',
  databaseHost: 'localhost',
  sessionLifetimeSeconds: 604800,
  sessionsExpireAt: '2026-10-22T00:00:00Z',
  shape: SMOKE_SHAPE,
  users: [],
  agents,
  workspaces: [],
  projects,
} as unknown as SeedManifest;

// ── The classifier ──────────────────────────────────────────────────────────

const rpc = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
const sse = (payload: string) => `event: message\ndata: ${payload}\n\n`;

describe('classifyMcpResponse', () => {
  it('any 429 is limited; the body’s retryAfterSeconds wins over Retry-After', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32029,
        message: 'slow',
        data: { code: 'RATE_LIMITED', retryAfterSeconds: 7 },
      },
    });
    expect(
      classifyMcpResponse({ status: 429, headers: { 'Retry-After': '3' }, body }),
    ).toMatchObject({
      outcome: LIMITED,
      retryAfterSeconds: 7,
    });
    expect(
      classifyMcpResponse({ status: 429, headers: { 'Retry-After': '3' }, body: '' }),
    ).toMatchObject({
      outcome: LIMITED,
      retryAfterSeconds: 3,
    });
    expect(
      classifyMcpResponse({ status: 429, headers: {}, body: '<html>nope</html>' }).outcome,
    ).toBe(LIMITED);
  });

  it('a 200 per-tool RATE_LIMITED result is limited', () => {
    const body = rpc({
      isError: true,
      content: [{ type: 'text', text: 'slow down' }],
      structuredContent: { code: 'RATE_LIMITED', retryAfterSeconds: 4 },
    });
    expect(classifyMcpResponse({ status: 200, headers: {}, body })).toMatchObject({
      outcome: LIMITED,
      retryAfterSeconds: 4,
    });
  });

  it('a claim answered taken or not_claimable is empty; claimed and mine are ok', () => {
    for (const [o, want] of [
      ['taken', EMPTY],
      ['not_claimable', EMPTY],
      ['claimed', OK],
      ['mine', OK],
    ] as const) {
      const body = rpc({ content: [], structuredContent: { outcome: o } });
      expect(
        classifyMcpResponse({ status: 200, headers: {}, body, tool: 'claim_work_item' }).outcome,
      ).toBe(want);
    }
  });

  it('errors: another non-200, an isError result, an unparseable body, a JSON-RPC error with no result', () => {
    expect(classifyMcpResponse({ status: 500, headers: {}, body: rpc({}) }).outcome).toBe(ERROR);
    expect(classifyMcpResponse({ status: 401, headers: {}, body: '' }).outcome).toBe(ERROR);
    expect(
      classifyMcpResponse({
        status: 200,
        headers: {},
        body: rpc({ isError: true, content: [], structuredContent: { code: 'NOT_FOUND' } }),
      }).outcome,
    ).toBe(ERROR);
    expect(classifyMcpResponse({ status: 200, headers: {}, body: '{not json' }).outcome).toBe(
      ERROR,
    );
    const strictRefusal = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Unrecognized key: "keys"' },
    });
    expect(classifyMcpResponse({ status: 200, headers: {}, body: strictRefusal }).outcome).toBe(
      ERROR,
    );
  });

  it('parses an SSE-framed body', () => {
    expect(
      classifyMcpResponse({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sse(
          rpc({ content: [{ type: 'text', text: 'hi' }], structuredContent: { key: 'LA-1' } }),
        ),
      }),
    ).toMatchObject({ outcome: OK, structured: { key: 'LA-1' } });
    expect(
      classifyMcpResponse({
        status: 200,
        headers: {},
        body: sse(rpc({ content: [], structuredContent: { outcome: 'taken' } })),
        tool: 'claim_work_item',
      }).outcome,
    ).toBe(EMPTY);
  });

  it('the back-off takes the refusal’s seconds, a default, and the profile’s cap', () => {
    expect(backoffSeconds(7, 30)).toBe(7);
    expect(backoffSeconds(90, 30)).toBe(30);
    expect(backoffSeconds(null, 30)).toBe(1);
  });
});

// ── The metric recorder ─────────────────────────────────────────────────────

function stubMetrics() {
  const log: { metric: string; value: unknown; tags: Record<string, unknown> }[] = [];
  const m = (metric: string) => ({
    add: (value: unknown, tags: Record<string, unknown>) => log.push({ metric, value, tags }),
  });
  return {
    log,
    metrics: {
      duration: m('mcp_call_duration'),
      calls: m('mcp_calls'),
      errors: m('mcp_errors'),
      limited: m('mcp_rate_limited'),
      retryAfter: m('retry_after_seconds'),
    },
  };
}

describe('recordCall', () => {
  it('a limited or empty call never reaches the duration trend or the error rate, and counts once', () => {
    for (const outcome of [LIMITED, EMPTY]) {
      const { log, metrics } = stubMetrics();
      recordCall(metrics, {
        group: 'claim',
        tool: 'claim_work_item',
        outcome,
        durationMs: 3,
        retryAfterSeconds: outcome === LIMITED ? 5 : null,
      });
      expect(log.filter((l) => l.metric === 'mcp_call_duration')).toHaveLength(0);
      expect(log.filter((l) => l.metric === 'mcp_errors').map((l) => l.value)).toEqual([false]);
      const calls = log.filter((l) => l.metric === 'mcp_calls');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tags['outcome']).toBe(outcome);
    }
  });

  it('an ok call feeds the trend; every metric carries role: agent', () => {
    const { log, metrics } = stubMetrics();
    for (const outcome of OUTCOMES) {
      recordCall(metrics, {
        group: 'read',
        tool: 'skeleton',
        outcome,
        durationMs: 12,
        retryAfterSeconds: 2,
      });
    }
    expect(log.filter((l) => l.metric === 'mcp_call_duration').map((l) => l.value)).toEqual([12]);
    expect(log.filter((l) => l.metric === 'mcp_errors' && l.value === true)).toHaveLength(1);
    expect(log.filter((l) => l.metric === 'retry_after_seconds')).toHaveLength(1);
    for (const l of log) expect(l.tags['role']).toBe(ROLE_AGENT);
  });

  it('the vocabulary is exactly four strings', () => {
    expect([...OUTCOMES]).toEqual(['ok', 'empty', 'limited', 'error']);
  });
});

// ── The pickers ─────────────────────────────────────────────────────────────

describe('pickAgent', () => {
  it('is stable per VU and covers every agent of the role over agents × 3 VU ids', () => {
    for (const role of ['read', 'write', 'claim', 'run'] as const) {
      const of = agentsOfRole(manifest, role);
      const seen = new Set<string>();
      for (let vu = 1; vu <= manifest.agents.length * 3; vu++) {
        const a = pickAgent(manifest, role, vu).agent;
        expect(a.role).toBe(role);
        expect(pickAgent(manifest, role, vu).agent.tokenId).toBe(a.tokenId);
        seen.add(a.tokenId);
      }
      expect(seen.size).toBe(of.length);
    }
  });

  it('a burst VU gets a write agent and its own slot; no two share one', () => {
    const slots = agentsOfRole(manifest, 'burst').length;
    const used = new Set<string>();
    for (let vu = 0; vu < slots; vu++) {
      const { agent: a, slot } = pickAgent(manifest, 'burst', vu);
      expect(a.role).toBe('write');
      expect(slot).toBe(a.burst);
      for (const c of [...slot!.cards, ...slot!.parents]) {
        expect(used.has(c.id)).toBe(false);
        used.add(c.id);
      }
    }
  });
});

describe('pickArgs', () => {
  const projectIds = (p: (typeof projects)[number]) =>
    new Set(
      [...p.content.stories, ...p.content.subtasks, ...p.pools.claim, ...p.pools.write].map(
        (c) => c.key,
      ),
    );

  it('every argument set holds the recorded required keys and nothing outside the schema', () => {
    const toolsByRole: Record<string, string[]> = {
      read: [...MIX.read],
      write: [...MIX.write],
      claim: ['claim_work_item'],
    };
    for (const [role, tools] of Object.entries(toolsByRole)) {
      for (const a of agentsOfRole(manifest, role)) {
        for (const tool of tools) {
          for (let n = 0; n < 8; n++) {
            const args = pickArgs(manifest, a, tool, n);
            const schema = TOOL_SCHEMAS[tool as keyof typeof TOOL_SCHEMAS];
            for (const k of schema.required) expect(args, `${tool} ${k}`).toHaveProperty(k);
            for (const k of Object.keys(args)) expect(schema.properties).toContain(k);
          }
        }
      }
    }
    for (const a of agentsOfRole(manifest, 'burst')) {
      const args = pickArgs(manifest, a, 'move_to_parent', 0);
      expect(Object.keys(args).sort()).toEqual(['key', 'parentKey']);
    }
  });

  it('draws only from the agent’s own project, pools and burst slot', () => {
    for (const a of manifest.agents) {
      const p = projects.find((x) => x.id === a.projectId)!;
      const own = projectIds(p);
      if (a.role === 'read') {
        expect(own).toContain(pickArgs(manifest, a, 'get_work_item', 3).key);
        expect(pickArgs(manifest, a, 'skeleton').projectKey).toBe(p.key);
        expect(p.readPlanIds).toContain(pickArgs(manifest, a, 'get_plan', 1).planId);
      }
      if (a.role === 'claim') {
        for (let n = 0; n < 10; n++) {
          const { key } = pickArgs(manifest, a, 'claim_work_item', n);
          expect(p.pools.claim.map((c) => c.key)).toContain(key);
        }
      }
      if (a.burst) {
        for (let n = 0; n < 20; n++) {
          const { key, parentKey } = pickArgs(manifest, a, 'move_to_parent', n);
          expect(a.burst.cards.map((c) => c.key)).toContain(key);
          expect(a.burst.parents.map((c) => c.key)).toContain(parentKey);
        }
      }
    }
  });

  it('add_plan_items is one add, no parentRef, never final, on a scratch plan', () => {
    const reads = projects.flatMap((p) => p.readPlanIds);
    for (const a of agentsOfRole(manifest, 'write')) {
      for (let n = 0; n < 4; n++) {
        const args = pickArgs(manifest, a, 'add_plan_items', n);
        expect(a.scratchPlanIds).toContain(args.planId);
        expect(reads).not.toContain(args.planId);
        expect(args).not.toHaveProperty('final');
        expect(args.proposals).toHaveLength(1);
        expect(args.proposals![0]!.op).toBe('add');
        expect(args.proposals![0]).not.toHaveProperty('parentRef');
      }
    }
  });

  it('weightedPick honours the weights', () => {
    expect(weightedPick({ a: 1, b: 0, c: 3 }, 0)).toBe('a');
    expect(weightedPick({ a: 1, b: 0, c: 3 }, 0.3)).toBe('c');
    expect(weightedPick({ a: 1, c: 3 }, 0.999)).toBe('c');
  });
});

// ── The iterations ──────────────────────────────────────────────────────────

type Call = { tool: string; args: Record<string, unknown> };
function recorder(outcomeFor: (tool: string) => string = () => OK) {
  const calls: Call[] = [];
  const call = (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return { outcome: outcomeFor(tool), structured: null };
  };
  return { calls, call };
}

describe('the scenario iterations', () => {
  it('no scenario calls claim_next_ready', () => {
    for (const tools of Object.values(MIX)) expect(tools).not.toContain('claim_next_ready');
    for (const file of ['agentReads', 'agentWrites', 'agentClaims', 'burst']) {
      const src = readFileSync(resolve(process.cwd(), `loadtest/k6/scenarios/${file}.js`), 'utf8');
      expect(src.replace(/\/\/.*$/gm, '')).not.toContain('claim_next_ready');
    }
  });

  it('a claim is released in the same iteration, never moved forward', () => {
    const claimer = agentsOfRole(manifest, 'claim')[0]!;
    const { calls, call } = recorder();
    claimIteration(call, manifest, claimer, 0);
    expect(calls.map((c) => c.tool)).toEqual([
      'claim_work_item',
      'update_work_item',
      'transition_status',
    ]);
    expect(calls[1]!.args).toEqual({ key: calls[0]!.args['key'], assigneeId: null });
    expect(calls[2]!.args).toEqual({ key: calls[0]!.args['key'], status: 'todo' });
    // An empty claim took nothing, so it releases nothing.
    const empty = recorder((t) => (t === 'claim_work_item' ? EMPTY : OK));
    claimIteration(empty.call, manifest, claimer, 1);
    expect(empty.calls.map((c) => c.tool)).toEqual(['claim_work_item']);
  });

  it('the write cycle uses only the declared todo ↔ in_progress pair', () => {
    const writer = agentsOfRole(manifest, 'write')[0]!;
    const { calls, call } = recorder();
    writeIteration(call, manifest, writer, 0, { transition_status: 1 }, 0);
    expect(calls.map((c) => c.args['status'])).toEqual([...TRANSITION_PAIR]);
    expect(TRANSITION_PAIR).toEqual(['in_progress', 'todo']);
  });

  it('a burst is exactly burstSize sequential parentKey moves alternating the agent’s own parents', () => {
    const b = agentsOfRole(manifest, 'burst')[0]!;
    const { calls, call } = recorder();
    burstIteration(call, manifest, b, 0);
    expect(calls).toHaveLength(b.burst!.cards.length);
    for (const c of calls) {
      expect(c.tool).toBe('move_to_parent');
      expect(c.args).not.toHaveProperty('folderId');
      expect(c.args['parentKey']).toBe(b.burst!.parents[1].key);
    }
    const back = recorder();
    burstIteration(back.call, manifest, b, 1);
    for (const c of back.calls) expect(c.args['parentKey']).toBe(b.burst!.parents[0].key);
  });

  it('no token reaches a metric tag', () => {
    const { log, metrics } = stubMetrics();
    for (const a of manifest.agents) {
      const tools = a.role === 'claim' ? MIX.claim : a.role === 'write' ? MIX.write : MIX.read;
      for (const tool of tools) {
        recordCall(metrics, {
          group: a.role,
          tool,
          outcome: OK,
          durationMs: 1,
          retryAfterSeconds: null,
        });
      }
    }
    const summary = JSON.stringify(log);
    expect(summary).not.toContain('motir_pat_');
  });
});
