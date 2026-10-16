import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { RateLimitExceededError } from '@/lib/api/v1/rateLimit';
import { rateLimitedToolError } from '@/lib/mcp/toolResult';
import { mcpRateLimitedResponse } from '@/lib/rateLimit/mcpGuard';
import { classifyMcpResponse } from '@/loadtest/k6/lib/classify.js';
import { METRIC_NAMES, recordCall } from '@/loadtest/k6/lib/record.js';
import {
  classifyReaderResponse,
  READER_METRIC_NAMES,
  recordReaderRequest,
} from '@/loadtest/k6/lib/readerOutcome.js';
import { classifyRunResponse, SUCCESS_STATUS } from '@/loadtest/k6/runs/classify.js';
import { RUN_METRIC_NAMES, recordRunStep } from '@/loadtest/k6/runs/metrics.js';
import { OUTCOME_BUCKETS } from '@/loadtest/report/thresholds';
import {
  STEADY,
  STEADY_START,
  healthyPoints,
  reportOn,
  writeRunDir,
  type K6Point,
} from './reportFixture';

// THE STORY TEST GATE, SEAM 2 (Story MOTIR-8538 · MOTIR-8681): a rate-limit refusal is
// never success and never error, ACROSS the seam. Each refusal is built by the
// SHIPPED builder the server answers with, classified by the scenario's own
// classifier, recorded by the scenario's own recorder into k6 point lines, and read
// by the real report. Nothing on the path between the server's 429 and the report's
// line is retyped here.

/** A k6 metric stand-in: every `add` becomes a point line at the current `t`. */
function sink() {
  const points: K6Point[] = [];
  let t = 0;
  const metric = (name: string) => ({
    add: (value: number | boolean, tags: Record<string, string>) =>
      points.push({ metric: name, t, value: Number(value), tags }),
  });
  const pick = <K extends string>(names: Record<K, string>) =>
    Object.fromEntries(Object.entries(names).map(([k, n]) => [k, metric(n as string)])) as Record<
      K,
      ReturnType<typeof metric>
    >;
  return {
    points,
    at: (ms: number) => {
      t = ms;
    },
    mcp: pick(METRIC_NAMES),
    run: pick(RUN_METRIC_NAMES),
    reader: pick(READER_METRIC_NAMES),
  };
}

const DECISION = {
  allowed: false,
  limit: 600,
  remaining: 0,
  resetAt: 1_760_000_000,
  degraded: false,
};
const rpc = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });

/** The four refusal shapes, each as the server answers it. */
async function refusalShapes() {
  const transport = mcpRateLimitedResponse(DECISION);
  const v1 = classifyApiV1Error(new RateLimitExceededError(2))!;
  return {
    mcpTransport: {
      status: transport.status,
      headers: transport.headers,
      body: await transport.text(),
      tool: 'update_work_item',
    },
    mcpPerTool: {
      status: 200,
      headers: {},
      body: rpc(rateLimitedToolError(3, 'Too many requests for this tool.')),
      tool: 'get_work_item',
    },
    apiV1: { status: v1.status, headers: {}, body: JSON.stringify(v1.body) },
    reader: { status: 429, headers: { 'retry-after': '1' } },
  };
}

const EVERY = 10; // one of each refusal every 10th steady second
const REFUSAL_SECONDS = Math.ceil(STEADY / EVERY);

/** Healthy traffic, plus a known number of errors, plus (optionally) every refusal shape. */
async function traffic(withRefusals: boolean) {
  const s = sink();
  const shapes = await refusalShapes();
  const outcomes: string[] = [];
  for (let sec = 0; sec < STEADY; sec += EVERY) {
    s.at(STEADY_START + sec * 1000 + 700);
    // A known error per scenario.
    recordCall(s.mcp, {
      group: 'write',
      tool: 'update_work_item',
      outcome: classifyMcpResponse({ status: 500, body: '', tool: 'update_work_item' }).outcome,
      durationMs: 40,
    });
    if (!withRefusals) continue;
    const a = classifyMcpResponse(shapes.mcpTransport);
    recordCall(s.mcp, {
      group: 'write',
      tool: 'update_work_item',
      outcome: a.outcome,
      durationMs: 5,
      retryAfterSeconds: a.retryAfterSeconds,
    });
    const b = classifyMcpResponse(shapes.mcpPerTool);
    recordCall(s.mcp, {
      group: 'read',
      tool: 'get_work_item',
      outcome: b.outcome,
      durationMs: 5,
      retryAfterSeconds: b.retryAfterSeconds,
    });
    const c = classifyRunResponse({ step: 'heartbeat', ...shapes.apiV1 });
    recordRunStep(s.run, { step: 'heartbeat', outcome: c.outcome, durationMs: 5 });
    const d = classifyReaderResponse(shapes.reader);
    recordReaderRequest(s.reader, { route: 'boards', outcome: d, status: 429, durationMs: 5 });
    outcomes.push(a.outcome, b.outcome, c.outcome, d);
  }
  return { points: [...healthyPoints(), ...s.points], outcomes };
}

const numbers = (value: string) => [...value.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe('seam 2 — a refusal is its own reading, from the server’s 429 to the report line', () => {
  it('every refusal shape classifies `limited` through the scenario that meets it', async () => {
    const { outcomes } = await traffic(true);
    expect(outcomes).toHaveLength(4 * REFUSAL_SECONDS);
    expect(new Set(outcomes)).toEqual(new Set(['limited']));
  });

  it('the refusal line counts exactly the refusals; error rate, latency and throughput exclude them', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'story-gate-refusals-'));
    const base = await traffic(false);
    const refused = await traffic(true);
    const a = await reportOn(writeRunDir(join(tmp, 'base'), { points: base.points }));
    const b = await reportOn(writeRunDir(join(tmp, 'refused'), { points: refused.points }));

    // No refusals: the line reads 0. With them: exactly the four shapes × the seconds.
    expect(numbers(a.line('perInstance.rateLimitedMax')!.value)[1]).toBe(0);
    const [, limited, denominator] = numbers(b.line('perInstance.rateLimitedMax')!.value);
    expect(limited).toBe(4 * REFUSAL_SECONDS);
    // Every source contributed a refusal, so the denominator is every request.
    expect(denominator).toBe(
      numbers(b.line('perInstance.errorRate')!.value).at(-1)! + 4 * REFUSAL_SECONDS,
    );

    // The error rate's numerator AND denominator are unchanged by the refusals, and
    // the numerator is exactly the injected errors: the empty claims in the
    // healthy traffic are not errors.
    expect(b.line('perInstance.errorRate')!.value).toBe(a.line('perInstance.errorRate')!.value);
    expect(numbers(b.line('perInstance.errorRate')!.value).slice(-2)[0]).toBe(REFUSAL_SECONDS);

    // Every latency series and the served throughput are unchanged.
    for (const key of [
      'perInstance.readP95Ms',
      'perInstance.readP99Ms',
      'perInstance.mutateP95Ms',
      'perInstance.mutateP99Ms',
      'perInstance.targetRps',
    ])
      expect(b.line(key)!.value).toBe(a.line(key)!.value);
    // The empty claim counts as served: 16 a second including it (reportFixture's healthySecond).
    expect(a.line('perInstance.targetRps')!.value).toBe('16 rps served');
  });
});

describe('outcome totality — what the scenarios emit is what the report buckets', () => {
  it('the union of the three classifiers’ outcomes over their response matrices equals OUTCOME_BUCKETS', async () => {
    const shapes = await refusalShapes();
    const seen = new Set<string>();

    // Agents: refusals, an empty claim, a served call, a server error, the
    // strict-input refusal (a JSON-RPC error body at 200) and an unparseable body.
    for (const r of [
      shapes.mcpTransport,
      shapes.mcpPerTool,
      {
        status: 200,
        body: rpc({ structuredContent: { outcome: 'taken' } }),
        tool: 'claim_work_item',
      },
      {
        status: 200,
        body: rpc({ structuredContent: { outcome: 'claimed' } }),
        tool: 'claim_work_item',
      },
      { status: 200, body: rpc({ content: [] }), tool: 'get_work_item' },
      { status: 200, body: rpc({ isError: true, structuredContent: { code: 'NOT_FOUND' } }) },
      {
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }),
      },
      { status: 500, body: '' },
      { status: 200, body: 'not json' },
    ])
      seen.add(classifyMcpResponse(r).outcome);

    // Run steps: every step's success status and a wrong one, the claim's answers, a 429.
    for (const [step, status] of Object.entries(SUCCESS_STATUS)) {
      seen.add(classifyRunResponse({ step, status, body: '{"outcome":"claimed"}' }).outcome);
      seen.add(classifyRunResponse({ step, status: status + 1, body: '{}' }).outcome);
    }
    for (const outcome of ['claimed', 'mine', 'taken', 'not_claimable', 'weird'])
      seen.add(
        classifyRunResponse({ step: 'claim', status: 200, body: JSON.stringify({ outcome }) })
          .outcome,
      );
    seen.add(classifyRunResponse({ step: 'heartbeat', ...shapes.apiV1 }).outcome);

    // Readers: served, a hop, a bounce, a refusal, a failure.
    for (const r of [
      { status: 200 },
      { status: 302, headers: { location: '/items' } },
      { status: 302, headers: { location: 'http://x.flycast/sign-in?next=/' } },
      shapes.reader,
      { status: 500 },
    ])
      seen.add(classifyReaderResponse(r));

    expect([...seen].sort()).toEqual(Object.keys(OUTCOME_BUCKETS).sort());
    for (const outcome of seen)
      expect(OUTCOME_BUCKETS[outcome as keyof typeof OUTCOME_BUCKETS]).toBeDefined();
  });
});
