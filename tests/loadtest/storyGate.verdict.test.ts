import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '@/loadtest/report/report';
import { THRESHOLD_INPUTS } from '@/loadtest/report/thresholds';
import { copiedFrom } from '@/loadtest/run/neon';
import type { MachineRecord } from '@/loadtest/run/runRecord';
import {
  STEADY,
  STEADY_START,
  T0,
  healthyPoints,
  healthyProm,
  healthySecond,
  reportOn,
  runRecord,
  withHandlers,
  writeRunDir,
  type FixtureOptions,
  type Handler,
  type K6Point,
} from './reportFixture';

// THE STORY TEST GATE, SEAM 3 (Story MOTIR-8538 · MOTIR-8681): `unmeasured` never
// yields PASS, and `n/a` never blocks one. The lines are read from the run
// directory's own profile.resolved.json and their backing inputs from the report's
// exported THRESHOLD_INPUTS — nothing is listed here — so a threshold added later is
// covered, and one added without its mapping fails.

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'story-gate-verdict-'));
});
const dirFor = (name: string) => join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}`);

/** At N = 2 the steady traffic doubles, so served rps scales and the scale-out line PASSes. */
function doubled(): K6Point[] {
  const out = healthyPoints();
  for (let s = 0; s < STEADY; s += 1) out.push(...healthySecond(STEADY_START + s * 1000 + 600));
  return out;
}

interface Fixture {
  n: 1 | 2;
  opts: FixtureOptions;
  handlers: Handler[];
}

async function passingFixture(n: 1 | 2): Promise<Fixture> {
  if (n === 1) return { n, opts: { n: 1 }, handlers: healthyProm(1) };
  const baseline = writeRunDir(dirFor('baseline'), { n: 1 });
  expect((await reportOn(baseline)).code).toBe(EXIT.PASS);
  return {
    n,
    opts: { n: 2, points: doubled(), run: { baseline } },
    handlers: healthyProm(2),
  };
}

const UNMEASURED_WINDOW = {
  startedAt: 'unmeasured',
  rampEndedAt: 'unmeasured',
  steadyEndedAt: 'unmeasured',
  endedAt: 'unmeasured',
};

/** Take one input away from a fixture, by the id THRESHOLD_INPUTS names it with. */
function without(f: Fixture, input: string): Fixture {
  if (input === 'run.json#window')
    return {
      ...f,
      opts: { ...f.opts, run: { ...f.opts.run, window: UNMEASURED_WINDOW as never } },
    };
  if (input === 'baseline:report.json') {
    rmSync(join(f.opts.run!.baseline as string, 'report.json'));
    return f;
  }
  if (input === 'prometheus:requests-by-instance')
    return {
      ...f,
      handlers: withHandlers(f.handlers, [
        /^sum by \(instance\) \((fly_app_http_responses_count|db_tx_wait_seconds_count)\{/,
        () => [],
      ]),
    };
  if (input.startsWith('prometheus:')) {
    const series = input.slice('prometheus:'.length);
    return { ...f, handlers: withHandlers(f.handlers, [new RegExp(series), () => []]) };
  }
  if (input === 'k6-points.json.gz') return { ...f, opts: { ...f.opts, points: null } };
  throw new Error(`THRESHOLD_INPUTS names "${input}", which this gate does not know how to remove`);
}

const run = async (f: Fixture) =>
  reportOn(writeRunDir(dirFor(`n${f.n}`), f.opts), { handlers: f.handlers });

/** The perInstance / scaleOut keys the resolved profile carries. */
function lineKeys(dir: string): string[] {
  const resolved = JSON.parse(readFileSync(join(dir, 'profile.resolved.json'), 'utf8')) as {
    thresholds: Record<string, Record<string, unknown>>;
  };
  return (['perInstance', 'scaleOut'] as const).flatMap((section) =>
    Object.keys(resolved.thresholds[section] ?? {}).map((k) => `${section}.${k}`),
  );
}

describe('seam 3 — removing the input behind any line gives UNMEASURED, never PASS', () => {
  for (const n of [1, 2] as const) {
    it(`at N = ${n}: each line that applies, each of its inputs`, async () => {
      const f = await passingFixture(n);
      const base = await run(f);
      expect(base.json.verdict).toBe('PASS');
      expect(base.code).toBe(EXIT.PASS);

      const keys = lineKeys(writeRunDir(dirFor('keys'), f.opts));
      expect(keys.length).toBeGreaterThan(0);
      // A key with no mapping fails here: a threshold cannot be added without one.
      for (const k of keys) expect(THRESHOLD_INPUTS[k], `THRESHOLD_INPUTS["${k}"]`).toBeDefined();

      // Only the lines that apply at this N; removing an input under an n/a line
      // would pass vacuously.
      const applies = keys.filter((k) => base.line(k)!.status !== 'n/a');
      expect(applies.length).toBeGreaterThan(0);

      // One case per INPUT, not per key: removing k6-points.json.gz is one case.
      const byInput = new Map<string, string[]>();
      for (const k of applies)
        for (const input of THRESHOLD_INPUTS[k]!)
          byInput.set(input, [...(byInput.get(input) ?? []), k]);

      for (const [input, backed] of byInput) {
        const r = await run(without(await passingFixture(n), input));
        for (const k of backed) {
          expect(r.line(k), `${input} → ${k}`).toMatchObject({ status: 'unmeasured' });
          expect(r.line(k)!.reason, `${input} → ${k}`).toBeTruthy();
        }
        expect(r.json.verdict, input).toBe('UNMEASURED');
        expect(r.code, input).toBe(EXIT.UNMEASURED);
      }
    });
  }
});

/** A P2028 counter series on m1 that starts at 0 and reads `v` once the steady window opens. */
const p2028At = (v: number): Handler => [
  /outcome=~"p2028_\.\*"/,
  (t) => [
    {
      labels: { instance: 'm1', outcome: 'p2028_timeout' },
      value: t * 1000 >= STEADY_START ? v : 0,
    },
  ],
];

describe('seam 3 — the P2028 line', () => {
  it('without the counter and with an empty log capture it is unmeasured, never 0', async () => {
    const r = await run(
      without(
        { n: 1, opts: { n: 1, logs: [] }, handlers: healthyProm(1) },
        'prometheus:db_tx_wait_seconds_count',
      ),
    );
    expect(r.line('perInstance.p2028')!.status).toBe('unmeasured');
    expect(r.line('perInstance.p2028')!.value).not.toBe('0');
    expect(r.json.verdict).not.toBe('PASS');
  });

  it('a missing `committed` positive control on one instance is unmeasured', async () => {
    const f = await passingFixture(2);
    const r = await run({
      ...f,
      handlers: withHandlers(f.handlers, [
        /outcome="committed"/,
        (t) => [{ labels: { instance: 'm1' }, value: Math.max(0, t - T0 / 1000) * 10 }],
      ]),
    });
    expect(r.line('perInstance.p2028')!.status).toBe('unmeasured');
    expect(r.json.verdict).toBe('UNMEASURED');
  });

  it('a nonzero p2028 count FAILs, whatever the (empty) log says', async () => {
    const r = await run({
      n: 1,
      opts: { n: 1, logs: [] },
      handlers: withHandlers(healthyProm(1), p2028At(2)),
    });
    expect(r.line('perInstance.p2028')!.status).toBe('FAIL');
    expect(r.json.verdict).toBe('FAIL');
    expect(r.code).toBe(EXIT.FAIL);
  });
});

describe('seam 3 — n/a never blocks a PASS, and never hides a missing reading', () => {
  it('N = 1: the scale-out line is n/a and the run PASSes; N = 2: the same line is measured', async () => {
    const one = await run(await passingFixture(1));
    expect(one.line('scaleOut.efficiency')!.status).toBe('n/a');
    expect(one.json.verdict).toBe('PASS');

    const two = await run(await passingFixture(2));
    expect(two.line('scaleOut.efficiency')!.status).toBe('PASS');
    expect(two.line('perInstance.targetRps')!.status).toBe('n/a');
    expect(two.json.verdict).toBe('PASS');
  });
});

describe('seam 3 — a scale-out line on a bad baseline is unmeasured, never PASS', () => {
  const cases: [string, (f: Fixture) => Promise<Fixture> | Fixture][] = [
    ['a missing baseline report', (f) => without(f, 'baseline:report.json')],
    [
      'a baseline whose profile hash differs',
      async (f) => {
        const other = writeRunDir(dirFor('baseline-hash'), {
          run: { profile: { ...runRecord(1).profile, sha256: 'x'.repeat(64) } },
        });
        await reportOn(other);
        return { ...f, opts: { ...f.opts, run: { ...f.opts.run, baseline: other } } };
      },
    ],
    [
      'a baseline on another machine size',
      async (f) => {
        const big = (runRecord(1).app.machines as MachineRecord[]).map((m) => ({
          ...m,
          memoryMb: 4096,
        }));
        const other = writeRunDir(dirFor('baseline-size'), {
          run: { app: { name: runRecord(1).app.name, machines: big }, candidateSize: true },
        });
        await reportOn(other);
        return { ...f, opts: { ...f.opts, run: { ...f.opts.run, baseline: other } } };
      },
    ],
    [
      'an INVALID baseline',
      async (f) => {
        const other = writeRunDir(dirFor('baseline-invalid'), { run: { instancesHeld: false } });
        expect((await reportOn(other)).json.verdict).toBe('INVALID');
        return { ...f, opts: { ...f.opts, run: { ...f.opts.run, baseline: other } } };
      },
    ],
  ];
  for (const [name, spoil] of cases)
    it(name, async () => {
      const r = await run(await spoil(await passingFixture(2)));
      expect(r.line('scaleOut.efficiency')!.status).toBe('unmeasured');
      expect(r.json.verdict).toBe('UNMEASURED');
      expect(r.code).toBe(EXIT.UNMEASURED);
    });

  it('a lopsided request share is unmeasured with the routing reason, never FAIL', async () => {
    const f = await passingFixture(2);
    const r = await run({
      ...f,
      handlers: withHandlers(f.handlers, [
        /^sum by \(instance\) \(fly_app_http_responses_count\{/,
        (t) => [
          { labels: { instance: 'm1' }, value: (t - T0 / 1000) * 90 },
          { labels: { instance: 'm2' }, value: (t - T0 / 1000) * 10 },
        ],
      ]),
    });
    expect(r.line('scaleOut.efficiency')).toMatchObject({ status: 'unmeasured' });
    expect(r.line('scaleOut.efficiency')!.reason).toMatch(/^routing, not scaling/);
  });
});

describe('seam 3 — the header carries what run.json wrote', () => {
  it('a sha written as `unmeasured` reaches the header as `unmeasured`', async () => {
    const r = await run({
      n: 1,
      opts: { n: 1, run: { sha: 'unmeasured' } },
      handlers: healthyProm(1),
    });
    expect(r.json.header.sha).toBe('unmeasured');
  });

  it('the copied-from time follows refresh.json, the reset field, parent_timestamp, created_at', async () => {
    const branch = {
      id: 'br-1',
      last_reset_at: '2026-10-13T00:00:00Z',
      parent_timestamp: '2026-10-12T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    };
    const refresh = { branchId: 'br-1', refreshedAt: '2026-10-14T05:00:00Z' };
    const order: [unknown, Record<string, unknown>, string][] = [
      [refresh, branch, refresh.refreshedAt],
      [null, branch, branch.last_reset_at],
      [null, { ...branch, last_reset_at: undefined }, branch.parent_timestamp],
      [null, { id: 'br-1', created_at: branch.created_at }, branch.created_at],
    ];
    for (const [file, json, expected] of order) {
      // The run command's own pick, written into run.json, read by the real report.
      const picked = copiedFrom(file, { branch: json });
      const r = await run({
        n: 1,
        opts: {
          n: 1,
          run: {
            neon: {
              ...runRecord(1).neon,
              copiedAt: picked.copiedAt,
              copiedAtField: picked.copiedAtField,
            },
          },
        },
        handlers: healthyProm(1),
      });
      expect(r.json.header.neon.copiedAt).toBe(expected);
      expect(r.json.comparable?.neonCopiedAt ?? expected).toBe(expected);
    }
  });
});
