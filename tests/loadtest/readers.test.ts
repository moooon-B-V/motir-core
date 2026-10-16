import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ERROR, LIMITED, OK, OUTCOMES } from '@/loadtest/k6/lib/outcome.js';
import {
  classifyReaderResponse,
  isBounce,
  probeVerdict,
  READER_METRIC_NAMES,
  READER_ROUTES,
  recordReaderRequest,
  ROLE_READER,
} from '@/loadtest/k6/lib/readerOutcome.js';
import { createWindowReadGate, viewedTabOf, windowPath } from '@/loadtest/k6/lib/windowReadGate.js';
import {
  browseTarget,
  readerIndexForVu,
  readerReuseWarning,
  readersFromManifest,
} from '@/loadtest/k6/lib/readerUsers.js';
import { readerScenarios, readerSplit } from '@/loadtest/k6/lib/readerProfile.js';

// Story MOTIR-8538 · MOTIR-8677 — the reader scenarios' pure halves: the
// classifier and recorder, the window-read rule, the reader records and the
// scenarios fragment. k6 itself is not run here.

type Tags = Record<string, string>;
function stubMetrics() {
  type Added = Array<{ value: number; tags: Tags }>;
  const added: Record<'requests' | 'duration' | 'http503', Added> = {
    requests: [],
    duration: [],
    http503: [],
  };
  const metric = (name: keyof typeof added) => ({
    add: (value: number, tags: Tags) => {
      added[name].push({ value, tags });
    },
  });
  return {
    added,
    metrics: {
      requests: metric('requests'),
      duration: metric('duration'),
      http503: metric('http503'),
    },
  };
}

describe('classifyReaderResponse', () => {
  it('200 and the 307 landing hop are ok', () => {
    expect(classifyReaderResponse({ status: 200 })).toBe(OK);
    expect(
      classifyReaderResponse({ status: 307, headers: { Location: '/workbench?tab=todo' } }),
    ).toBe(OK);
  });

  it('429 is limited — never ok, never error', () => {
    expect(classifyReaderResponse({ status: 429 })).toBe(LIMITED);
  });

  it('every other status, and a transport failure, is an error', () => {
    for (const status of [0, 400, 401, 403, 404, 500, 502, 503, 504]) {
      expect(classifyReaderResponse({ status })).toBe(ERROR);
    }
  });

  it('a redirect that bounces the reader out is an error, not a hop', () => {
    for (const loc of [
      '/sign-in',
      'http://localhost:3000/sign-in?next=%2Fworkbench',
      '/re-consent',
      '/two-factor-required',
      '/no-project',
    ]) {
      expect(classifyReaderResponse({ status: 307, headers: { location: loc } })).toBe(ERROR);
    }
    expect(isBounce('/sign-in-help')).toBe(false);
    expect(isBounce('/items')).toBe(false);
  });

  it('emits only the shared four outcome strings', () => {
    expect([...OUTCOMES]).toEqual(['ok', 'empty', 'limited', 'error']);
    const seen = new Set(
      [0, 200, 302, 307, 401, 429, 503].map((status) => classifyReaderResponse({ status })),
    );
    for (const o of seen) expect(OUTCOMES).toContain(o);
  });
});

describe('recordReaderRequest — the metric contract', () => {
  it('counts every request; times ok only; tags role reader', () => {
    const { added, metrics } = stubMetrics();
    recordReaderRequest(metrics, { route: 'boards', outcome: OK, status: 200, durationMs: 12 });
    recordReaderRequest(metrics, { route: 'boards', outcome: LIMITED, status: 429, durationMs: 3 });
    recordReaderRequest(metrics, { route: 'items', outcome: ERROR, status: 500, durationMs: 9 });
    expect(added.requests).toHaveLength(3);
    expect(added.requests[1]!.tags).toEqual({
      role: ROLE_READER,
      route: 'boards',
      outcome: 'limited',
      status: '429',
    });
    expect(added.duration).toEqual([{ value: 12, tags: { role: ROLE_READER, route: 'boards' } }]);
  });

  it('never times the stream, whose duration is its hold', () => {
    const { added, metrics } = stubMetrics();
    recordReaderRequest(metrics, {
      route: 'workbench_stream',
      outcome: OK,
      status: 200,
      durationMs: 60_000,
    });
    expect(added.requests).toHaveLength(1);
    expect(added.duration).toHaveLength(0);
  });

  it('a 503 counts in http_503 and is an error', () => {
    const { added, metrics } = stubMetrics();
    const outcome = classifyReaderResponse({ status: 503 });
    recordReaderRequest(metrics, { route: 'plan_get', outcome, status: 503, durationMs: 1 });
    expect(outcome).toBe(ERROR);
    expect(added.http503).toEqual([{ value: 1, tags: { role: ROLE_READER, route: 'plan_get' } }]);
    expect(added.duration).toHaveLength(0);
  });

  it('names the seven routes and the metrics the report reads', () => {
    expect([...READER_ROUTES]).toEqual([
      'workbench',
      'workbench_stream',
      'workbench_window',
      'boards',
      'items',
      'plan_get',
      'plan_poll',
    ]);
    expect(READER_METRIC_NAMES.requests).toBe('reader_requests');
    expect(READER_METRIC_NAMES.duration).toBe('reader_duration');
  });
});

describe('the window-read rule', () => {
  /** Drive the gate the way readers.js does, with reads that can overlap frames. */
  function simulate(script: Array<'frame' | 'empty' | 'readDone'>) {
    const gate = createWindowReadGate();
    let reads = 0;
    let maxInFlight = 0;
    const start = () => {
      gate.begin();
      reads += 1;
      maxInFlight = Math.max(maxInFlight, gate.inFlight ? 1 : 0);
    };
    for (const step of script) {
      if (step === 'readDone') {
        if (gate.done()) start();
      } else if (gate.frame(step === 'frame' ? ['todo'] : [])) {
        start();
      }
    }
    return { reads, maxInFlight, gate };
  }

  it('one read per non-empty frame, none for an empty one', () => {
    const r = simulate(['frame', 'readDone', 'empty', 'frame', 'readDone']);
    expect(r.reads).toBe(2);
  });

  it('frames during a read produce exactly ONE further read', () => {
    const r = simulate(['frame', 'frame', 'frame', 'frame', 'readDone', 'readDone']);
    expect(r.reads).toBe(2);
    expect(r.maxInFlight).toBe(1);
    expect(r.gate.pending).toBe(false);
  });

  it('never starts a second read while one is in flight', () => {
    const gate = createWindowReadGate();
    expect(gate.frame(['todo'])).toBe(true);
    gate.begin();
    expect(gate.frame(['finished'])).toBe(false);
    expect(() => gate.begin()).toThrow();
    expect(gate.done()).toBe(true);
    gate.begin();
    expect(gate.done()).toBe(false);
  });

  it('reads the viewed tab from the landing URL and re-reads that tab only', () => {
    expect(viewedTabOf('http://localhost:3000/workbench?tab=in-progress')).toBe('in-progress');
    expect(viewedTabOf('/workbench')).toBeNull();
    expect(windowPath('to-fix')).toBe('/api/workbench/window?tab=to-fix&page=1');
  });
});

describe('reader records and browsing', () => {
  const manifest = {
    users: [
      {
        id: 'u1',
        readerWorkspaceId: 'w1',
        readerProjectId: 'p1',
        cookieHeader: 'better-auth.session_token=x; workspace_id=w1',
      },
      {
        id: 'u2',
        readerWorkspaceId: 'w2',
        readerProjectId: 'p2',
        cookieHeader: 'better-auth.session_token=y; workspace_id=w2',
      },
    ],
    projects: [
      { id: 'p1', readPlanIds: ['plan-a', 'plan-b'] },
      { id: 'p2', readPlanIds: ['plan-c'] },
    ],
  };

  it("joins each user to its OWN project's read plans and keeps the seed's cookie", () => {
    const readers = readersFromManifest(manifest);
    expect(readers[1]).toEqual({
      userId: 'u2',
      workspaceId: 'w2',
      projectId: 'p2',
      cookieHeader: 'better-auth.session_token=y; workspace_id=w2',
      readPlanIds: ['plan-c'],
    });
  });

  it('assigns readers by __VU and warns only when VUs outnumber users', () => {
    expect([1, 2, 3].map((vu) => readerIndexForVu(vu, 2))).toEqual([0, 1, 0]);
    expect(readerReuseWarning(2, 2)).toBeNull();
    expect(readerReuseWarning(3, 2)).toMatch(/3 reader VUs share 2 seeded users/);
  });

  it('polls a plan with its last reviewVersion, or the no-version token for a planned plan', () => {
    const [reader] = readersFromManifest(manifest);
    const versions: Record<string, string> = {};
    expect(browseTarget('plan_poll', reader, versions, 0)).toEqual({
      route: 'plan_poll',
      path: '/api/plans/plan-a?since=0',
      planId: 'plan-a',
    });
    versions['plan-a'] = 'v 1';
    expect(browseTarget('plan_poll', reader, versions, 0).path).toBe(
      '/api/plans/plan-a?since=v%201',
    );
    expect(browseTarget('items_page', reader, versions, 0.99, 3).path).toBe('/items?page=3');
    expect(browseTarget('boards', reader, versions, 0).route).toBe('boards');
  });
});

describe('readerScenarios', () => {
  it('splits tabs and browsers and covers the hold in the graceful stop', () => {
    expect(readerSplit(200, 0.75)).toEqual({ tabs: 150, browsers: 50 });
    const s = readerScenarios({
      readers: 4,
      tabShare: 0.5,
      rampSeconds: 10,
      durationSeconds: 50,
      holdSeconds: 60,
    }) as Record<string, { exec: string; stages: Array<{ target: number }>; gracefulStop: string }>;
    expect(Object.keys(s)).toEqual(['readerTab', 'readerBrowse']);
    expect(s.readerTab!.stages.map((x) => x.target)).toEqual([2, 2]);
    expect(s.readerTab!.gracefulStop).toBe('90s');
    expect(s.readerBrowse!.exec).toBe('readerBrowse');
  });

  it('defines no thresholds', () => {
    const s = readerScenarios({ readers: 2, rampSeconds: 1, durationSeconds: 1, holdSeconds: 1 });
    expect(JSON.stringify(s)).not.toMatch(/threshold/);
  });
});

describe('the cookie probe', () => {
  it('passes a landing redirect and a 200, refuses a bounce, a 401 and a 403', () => {
    expect(probeVerdict({ status: 307, headers: { location: '/workbench?tab=todo' } })).toBeNull();
    expect(probeVerdict({ status: 200 })).toBeNull();
    expect(probeVerdict({ status: 307, headers: { location: '/sign-in' } })).toMatch(
      /redirected to \/sign-in/,
    );
    expect(probeVerdict({ status: 401 })).toMatch(/401/);
    expect(probeVerdict({ status: 403 })).toMatch(/403/);
    expect(probeVerdict({ status: 0 })).toMatch(/did not answer/);
  });
});

describe('the reader scenario file', () => {
  const src = readFileSync(resolve(__dirname, '../../loadtest/k6/scenarios/readers.js'), 'utf8');

  it('never prints a cookie', () => {
    expect(src).not.toMatch(/console\.(log|warn|error|info)\([^)]*cookie/i);
  });

  it('imports the shared outcome vocabulary rather than spelling its own', () => {
    expect(src).toMatch(/from '\.\.\/lib\/outcome\.js'/);
  });
});
