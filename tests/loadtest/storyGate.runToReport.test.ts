import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { OPTIONS as PREFLIGHT_OPTIONS, runPreflight } from '@/loadtest/preflight/sideEffects';
import {
  EXIT as REPORT_EXIT,
  OPTIONS as REPORT_OPTIONS,
  runReportCli,
} from '@/loadtest/report/report';
import type { Exec } from '@/loadtest/run/fly';
import { EXIT, OPTIONS as RUN_OPTIONS, runLoadTest } from '@/loadtest/run/run';
import { OPTIONS as RESET_OPTIONS } from '@/loadtest/seed/reset';
import { OPTIONS as SEED_OPTIONS } from '@/loadtest/seed/seed';
import {
  APP,
  ENV,
  GEN_APP,
  ROOT,
  SMOKE_ARGS,
  appMachine,
  baselineDir,
  deps,
  fake,
  fakeExec,
  flyCalls,
  generatorStarts,
  generatorStops,
  k6Starts,
  ok,
  record,
  resetFake,
  sinkEnv,
  toJson,
} from './fakePlatform';
import {
  PROM_URL,
  TOKEN,
  cpuCsv,
  healthyProm,
  healthySecond,
  pointsFile,
  promStub,
  type K6Point,
} from './reportFixture';

// THE STORY TEST GATE, SEAM 4 (Story MOTIR-8538 · MOTIR-8681): profile → run command
// → run.json → report, for real. The run command runs against the fake platform
// (./fakePlatform.ts — the only stub, standing in for `fly`, `neonctl` and k6), with
// the REAL side-effect preflight reading every machine's environment, and the REAL
// report reading the run directory it leaves. Each refusal is asserted at the
// crossing: what the run command did not do afterwards, and what the report says
// about the directory it left.

// The fake run's window: k6 starts 20:00:00, the smoke profile ramps 60 s and holds
// 180 s, and k6 ends 20:04:20 (fakePlatform's `cat started.at` / `cat ended.at`).
const STARTED = Date.parse('2026-10-15T20:00:00Z');
const STEADY_FROM = STARTED + 60_000;
const STEADY_TO = STARTED + 240_000;
const ENDED = Date.parse('2026-10-15T20:04:20Z');

/** What k6 would have written: healthy traffic over the steady window. */
function k6Points(): K6Point[] {
  const out: K6Point[] = [];
  for (let t = STEADY_FROM; t < STEADY_TO; t += 1000) out.push(...healthySecond(t + 500));
  return out;
}

/** The real report, against a stub Prometheus answering for the fake's machine ids. */
async function realReport(dir: string): Promise<number> {
  const ids = (record(dir).app.machines as { id: string }[] | string) ?? [];
  const machineIds = Array.isArray(ids) ? ids.map((m) => m.id) : ['app1'];
  const stub = promStub(healthyProm(machineIds.length, machineIds));
  return runReportCli([dir], {
    env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_PROM_URL: PROM_URL },
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    cwd: fake.cwd,
    now: () => new Date(ENDED + 3_600_000),
    sleep: async () => undefined,
    log: () => undefined,
    fetchImpl: stub.fetchImpl,
  });
}

const reportJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));

/** The run command with the real preflight and the real report. */
const realDeps = (over: Parameters<typeof deps>[0] = {}) =>
  deps({
    env: { ...ENV, LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: '4501' },
    preflight: undefined,
    report: realReport,
    ...over,
  });

beforeEach(() => {
  resetFake();
  fake.world.staging.push(appMachine('worker1', { group: 'worker', services: [] }));
  fake.downloads = {
    'k6-points.json.gz': pointsFile(k6Points()),
    'generator-cpu.csv': cpuCsv(() => 0.3, STARTED - 10_000, ENDED),
  };
});

/** Fly does not run `ssh console -C` through a shell: shell syntax must be `sh -c '…'`. */
const SHELL_SYNTAX = /[|<>]|&&|\$[A-Za-z_{(]/;
function shellGuard(inner: Exec): Exec {
  return async (bin, args) => {
    if (bin === 'fly' && args[0] === 'ssh' && args[1] === 'console') {
      const cmd = args[args.indexOf('-C') + 1] ?? '';
      if (SHELL_SYNTAX.test(cmd) && !/^sh -c '[\s\S]*'$/.test(cmd))
        throw new Error(`unwrapped shell syntax in fly ssh console -C: ${cmd}`);
    }
    return inner(bin, args);
  };
}

/** The calls the preflight makes: the secret names and a bare printenv per machine. */
const preflightCalls = () =>
  flyCalls((a) => (a[0] === 'secrets' && a[1] === 'list') || a.at(-1) === 'printenv');
const indexOfCall = (pred: (a: string[]) => boolean, last = false) => {
  const all = fake.world.calls
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.bin === 'fly' && pred(c.args));
  return all.length === 0 ? -1 : (last ? all.at(-1)! : all[0]!).i;
};

describe('seam 4 — a completed run, read by the real report', () => {
  it('the header carries every run.json field it echoes, with the value written', async () => {
    const out = await runLoadTest(SMOKE_ARGS, realDeps({ exec: shellGuard(fakeExec) }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(out.reportExitCode).toBe(REPORT_EXIT.PASS);
    const run = record(out.runDir!);
    const { header, verdict } = reportJson(out.runDir!);
    expect(verdict).toBe('PASS');

    expect(header).toMatchObject({
      instances: run.instances,
      sha: run.sha,
      shaReadFrom: run.shaReadFrom,
      neon: run.neon,
      production: run.production,
      candidateSize: run.candidateSize,
      instancesHeld: run.instancesHeld,
      pinEnforced: run.pin.enforced,
      profile: { name: run.profile.name, path: run.profile.path, loadHash: run.profile.sha256 },
      traceRate: run.traceRate,
      concurrency: run.concurrency,
      requiredConcurrency: run.requiredConcurrency,
      rateLimits: run.rateLimits,
      offered: run.offered,
      generator: {
        machineId: run.generator.machineId,
        region: run.generator.region,
        cpus: run.generator.cpus,
      },
      k6: { version: run.k6.version, extensions: run.k6.extensions },
      window: run.window,
      baseline: 'none (N = 1)',
    });
    expect(header.app.name).toBe(run.app.name);
    expect(header.app.machines.map((m: { id: string }) => m.id)).toEqual(
      (run.app.machines as { id: string }[]).map((m) => m.id),
    );

    // The rest of run.json is judged or recorded, not echoed: each is named here so
    // a field added to run.json has to be placed one way or the other.
    const echoed = new Set([
      'instances',
      'sha',
      'shaReadFrom',
      'neon',
      'app',
      'production',
      'candidateSize',
      'instancesHeld',
      'pin',
      'profile',
      'traceRate',
      'concurrency',
      'requiredConcurrency',
      'rateLimits',
      'offered',
      'generator',
      'k6',
      'window',
      'baseline',
    ]);
    const notEchoed = new Set([
      'runId', // names the run directory and the published report folder
      'instancesChanged', // printed with the INVALID reason
      'scale', // how N was reached; the read-back N is `instances`
      'preflightExitCode', // a run that reaches the report passed it; preflight.txt holds the lines
      'capture', // the recorders' own counts; the inputs are read from their files
      'manifestDeleted', // an operator check, asserted by the run command's own tests
      'exitCode', // judged: a nonzero exit makes the verdict INVALID with `reason`
      'reason',
    ]);
    for (const k of Object.keys(run))
      expect(echoed.has(k) || notEchoed.has(k), `run.json field "${k}" is placed`).toBe(true);
  });

  it('a threshold edited in the profile flips that line and no other', async () => {
    const first = await runLoadTest(SMOKE_ARGS, realDeps());
    const smoke = JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8'));
    smoke.thresholds.perInstance.readP95Ms = 150; // the healthy reads' p95 is 200 ms
    const path = join(fake.cwd, 'loadtest/profiles/smoke-strict.json');
    writeFileSync(path, JSON.stringify(smoke));
    const second = await runLoadTest(
      ['--profile', path, '--instances', '1', '--app', APP],
      realDeps(),
    );
    const a = reportJson(first.runDir!).lines as { key: string; status: string }[];
    const b = reportJson(second.runDir!).lines as { key: string; status: string }[];
    const flipped = a.filter((l, i) => l.status !== b[i]!.status).map((l) => l.key);
    expect(flipped).toEqual(['perInstance.readP95Ms']);
    expect(second.reportExitCode).toBe(REPORT_EXIT.FAIL);
  });

  it('the same command twice gives the same comparable header, which holds no measurement or time', async () => {
    const one = await runLoadTest(SMOKE_ARGS, realDeps());
    const two = await runLoadTest(SMOKE_ARGS, realDeps());
    expect(one.runDir).not.toBe(two.runDir);
    const a = reportJson(one.runDir!).comparable;
    const b = reportJson(two.runDir!).comparable;
    expect(Object.keys(a).length).toBeGreaterThan(0);
    for (const k of Object.keys(a)) expect(b[k], k).toEqual(a[k]);
    for (const banned of [
      'window',
      'startedAt',
      'endedAt',
      'servedRps',
      'verdict',
      'lines',
      'cpuMean',
      'runId',
    ])
      expect(Object.keys(a)).not.toContain(banned);
    // No run time leaks in: the two runs' windows differ, the comparable block does not.
    const run = record(one.runDir!);
    for (const t of Object.values(run.window)) expect(JSON.stringify(a)).not.toContain(String(t));
  });
});

describe('seam 4 — the generator is started and stopped by the run command', () => {
  /** A call that does work ON the generator (listing it is not). */
  const generatorWork = (a: string[]) => a[0] === 'ssh' && a.includes(GEN_APP);

  for (const [name, k6Exit] of [
    ['a completed run', 0],
    ['a run whose k6 fails after the start', 107],
  ] as const)
    it(`${name}: started before the first generator call, stopped after the last`, async () => {
      fake.world.k6Exit = k6Exit;
      const out = await runLoadTest(SMOKE_ARGS, realDeps({ exec: shellGuard(fakeExec) }));
      expect(out.exitCode).toBe(k6Exit === 0 ? EXIT.completed : EXIT.k6);
      expect(generatorStarts()).toHaveLength(1);
      expect(generatorStops()).toHaveLength(1);
      const start = indexOfCall((a) => a[0] === 'machine' && a[1] === 'start');
      const stop = indexOfCall((a) => a[0] === 'machine' && a[1] === 'stop');
      expect(start).toBeLessThan(indexOfCall(generatorWork));
      expect(stop).toBeGreaterThan(indexOfCall(generatorWork, true));
      // Readiness and the pin check run ON the generator, never from the operator side.
      const probes = flyCalls((a) => a.some((x) => x.includes('curl')));
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) expect(p.args.slice(0, 4)).toEqual(['ssh', 'console', '-a', GEN_APP]);
      // A k6 failure still leaves a run.json the report reads as INVALID.
      if (k6Exit !== 0) expect(out.reportExitCode).toBe(REPORT_EXIT.INVALID);
    });

  it('the shell guard refuses an unwrapped pipe, so a green run above proves every command was wrapped', async () => {
    const guarded = shellGuard(fakeExec);
    await expect(
      guarded('fly', ['ssh', 'console', '-a', GEN_APP, '--machine', 'gen1', '-C', 'ps | grep k6']),
    ).rejects.toThrow(/unwrapped shell syntax/);
    await expect(
      guarded('fly', [
        'ssh',
        'console',
        '-a',
        GEN_APP,
        '--machine',
        'gen1',
        '-C',
        "sh -c 'ps | grep k6'",
      ]),
    ).resolves.toBeDefined();
  });
});

describe('seam 4 — the real preflight stops the run', () => {
  it('a live sink on the WORKER only exits 2 with its row and machine; nothing after the preflight runs', async () => {
    fake.world.machineEnv['worker1'] = {
      ...sinkEnv(),
      EMAIL_PROVIDER: 'resend',
    };
    const out = await runLoadTest(SMOKE_ARGS, realDeps());
    expect(out.exitCode).toBe(EXIT.refused);
    const text = readFileSync(join(out.runDir!, 'preflight.txt'), 'utf8');
    expect(text).toMatch(/LIVE/);
    expect(text).toMatch(/worker1/);
    expect(text).not.toMatch(/LIVE[^\n]*app1/);
    expectNothingAfterPreflight();
    expect(out.reportExitCode).toBe(REPORT_EXIT.INVALID);
  });

  it('an ssh failure on one machine exits 4; nothing after the preflight runs', async () => {
    fake.world.machineEnv['app1'] = 'fail';
    const out = await runLoadTest(SMOKE_ARGS, realDeps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(readFileSync(join(out.runDir!, 'preflight.txt'), 'utf8')).toMatch(/UNREAD[^\n]*app1/);
    expectNothingAfterPreflight();
  });

  it('`--app motir-core` makes zero platform calls, through the run command and the preflight alone', async () => {
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '1', '--app', 'motir-core'],
      realDeps(),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(fake.world.calls).toEqual([]);
    const calls: string[][] = [];
    const pre = await runPreflight(
      ['--app', 'motir-core'],
      { ...ENV, LOADTEST_STAGING_APP: 'motir-core' },
      async (a) => {
        calls.push([...a]);
        return { code: 0, stdout: '', stderr: '' };
      },
    );
    expect(pre.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });
});

function expectNothingAfterPreflight() {
  const lastPreflight = indexOfCall(
    (a) => (a[0] === 'secrets' && a[1] === 'list') || a.at(-1) === 'printenv',
    true,
  );
  expect(lastPreflight).toBeGreaterThan(-1);
  expect(preflightCalls().length).toBeGreaterThan(0);
  expect(fake.seedCalls).toEqual([]);
  expect(k6Starts()).toEqual([]);
  const after = fake.world.calls.slice(lastPreflight + 1);
  expect(after.filter((c) => c.args.includes(GEN_APP) && c.args[0] === 'ssh')).toEqual([]);
}

describe('seam 4 — the platform refuses before the preflight and before any load', () => {
  const N2 = () => [
    '--profile',
    'smoke',
    '--instances',
    '2',
    '--app',
    APP,
    '--baseline',
    baselineDir(),
  ];
  const cases: [string, () => string[], () => void, Partial<Parameters<typeof deps>[0]>?][] = [
    [
      'a read-back of N − 1 after the scale',
      N2,
      () => {
        fake.world.stagingAfter = { calls: 1, machines: [appMachine('app1')] };
      },
      {
        exec: async (bin, args) =>
          args[0] === 'scale'
            ? (fake.world.calls.push({ bin, args: [...args] }), ok())
            : fakeExec(bin, args),
        timeouts: { readBackMs: 30_000 },
      },
    ],
    [
      'a read-back of N + 1',
      N2,
      () => {
        fake.world.staging = [appMachine('app1'), appMachine('app2')];
        fake.world.stagingAfter = {
          calls: 1,
          machines: [appMachine('app1'), appMachine('app2'), appMachine('app3')],
        };
      },
      { timeouts: { readBackMs: 10_000 } },
    ],
    [
      'a stopped app machine in the group',
      N2,
      () => {
        fake.world.staging.push(appMachine('app2', { state: 'stopped' }));
      },
    ],
    [
      'an app machine not answering ready',
      () => SMOKE_ARGS,
      () => {
        fake.world.pin = (id) =>
          id === 'app1'
            ? { status: 503, body: '{"state":"draining"}' }
            : { status: 503, body: 'no such instance' };
      },
    ],
    [
      'a concurrency limit below the requirement',
      () => SMOKE_ARGS,
      () => {
        fake.world.staging[0]!.services[0]!.concurrency = {
          type: 'requests',
          soft_limit: 20,
          hard_limit: 25,
        };
      },
    ],
    [
      'a service that auto-stops',
      () => SMOKE_ARGS,
      () => {
        fake.world.staging[0]!.services[0]!.autostop = 'stop';
      },
    ],
  ];
  for (const [name, args, arrange, over] of cases)
    it(`${name}: exit 4, no preflight, no load, and a run.json the report reads as INVALID`, async () => {
      arrange();
      const out = await runLoadTest(args(), realDeps(over));
      expect(out.exitCode).toBe(EXIT.platform);
      expect(preflightCalls()).toEqual([]);
      expect(k6Starts()).toEqual([]);
      expect(fake.seedCalls).toEqual([]);
      expect(existsSync(join(out.runDir!, 'run.json'))).toBe(true);
      expect(out.reportExitCode).toBe(REPORT_EXIT.INVALID);
      for (const c of flyCalls((a) => a[0] === 'scale'))
        expect(c.args.slice(0, 3)).toEqual(['scale', 'count', expect.stringMatching(/^app=\d+$/)]);
    });

  it('the concurrency refusal names the required and the read value', async () => {
    fake.world.staging[0]!.services[0]!.concurrency = {
      type: 'requests',
      soft_limit: 20,
      hard_limit: 25,
    };
    const out = await runLoadTest(SMOKE_ARGS, realDeps());
    expect(record(out.runDir!).reason).toMatch(/20\/25.*66\/82|66\/82.*20\/25/);
  });

  it('a machine set that changes during the run writes instancesHeld false, and the report says INVALID (exit 6)', async () => {
    let lists = 0;
    const exec: Exec = async (bin, args) => {
      const r = await fakeExec(bin, args);
      if (args[0] === 'machine' && args[1] === 'list' && args.includes(APP)) {
        lists += 1;
        if (lists >= 3) return ok(JSON.stringify([toJson(appMachine('app9'))]));
      }
      return r;
    };
    const out = await runLoadTest(SMOKE_ARGS, realDeps({ exec }));
    expect(record(out.runDir!).instancesHeld).toBe(false);
    expect(out.reportExitCode).toBe(REPORT_EXIT.INVALID);
    expect(reportJson(out.runDir!).verdict).toBe('INVALID');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an edited copy of a profile file
type Profile = Record<string, any>;

describe('seam 4 — a profile that cannot offer its own target is refused before any platform call', () => {
  const variant = (edit: (p: Profile) => void) => {
    const p = JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8'));
    edit(p);
    const path = join(fake.cwd, `variant-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(p));
    return path;
  };
  for (const [name, edit, field] of [
    [
      'a targetRps the offered load cannot reach',
      (p: Profile) => (p.thresholds.perInstance.targetRps = 10_000),
      /targetRps/,
    ],
    [
      'a workspace offered more than the limiter’s budget',
      (p: Profile) => {
        p.thinkTimes.agentThinkSeconds = 0.001;
        p.thinkTimes.latencyAssumptionMs = 1;
        p.thresholds.perInstance.targetRps = 1;
      },
      /agentWorkspaces/,
    ],
  ] as const)
    it(name, async () => {
      const out = await runLoadTest(
        ['--profile', variant(edit), '--instances', '1', '--app', APP],
        realDeps(),
      );
      expect(out.exitCode).toBe(EXIT.refused);
      expect(fake.logs.join('\n')).toMatch(field);
      expect(fake.world.calls).toEqual([]);
    });
});

describe('seam 4 — the checked-in staging config is one Flycast can serve', () => {
  /** The keys that matter, by [section] — enough TOML for fly.toml's flat tables. */
  function readToml(text: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    let section = '';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      const head = /^\[\[?([^\]]+)\]\]?$/.exec(line);
      if (head) {
        section = head[1]!.trim();
        out[section] ??= {};
        continue;
      }
      const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (kv) (out[section] ??= {})[kv[1]!] = kv[2]!.replace(/^"|"$/g, '');
    }
    return out;
  }
  function flycastProblems(text: string): string[] {
    const t = readToml(text);
    const svc = t['http_service'] ?? {};
    const conc = t['http_service.concurrency'] ?? {};
    const problems: string[] = [];
    if (svc['force_https'] !== 'false')
      problems.push('force_https must be false (Flycast is HTTP-only)');
    if (!['off', 'false'].includes(svc['auto_stop_machines'] ?? ''))
      problems.push('auto_stop_machines must be off');
    if (svc['auto_start_machines'] !== 'false') problems.push('auto_start_machines must be false');
    if (conc['type'] !== 'requests') problems.push('concurrency type must be requests');
    for (const k of ['soft_limit', 'hard_limit'])
      if (!/^\d+$/.test(conc[k] ?? '')) problems.push(`${k} must be set explicitly`);
    return problems;
  }
  const GOOD = `app = 'motir-core-staging'
[http_service]
  internal_port = 3000
  force_https = false
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 0
  [http_service.concurrency]
    type = "requests"
    soft_limit = 960
    hard_limit = 1200
`;

  it('the guard passes a Flycast-ready config and fails each way one can go wrong', () => {
    expect(flycastProblems(GOOD)).toEqual([]);
    expect(flycastProblems(GOOD.replace('force_https = false', 'force_https = true'))).toEqual([
      'force_https must be false (Flycast is HTTP-only)',
    ]);
    expect(flycastProblems(GOOD.replace(/\s+soft_limit = 960/, ''))).toEqual([
      'soft_limit must be set explicitly',
    ]);
    expect(flycastProblems(GOOD.replace('"off"', '"stop"'))).toEqual([
      'auto_stop_machines must be off',
    ]);
  });

  // ⚠️ loadtest/staging/fly.staging.toml is MOTIR-8674's deliverable (staging
  // provisioning, step 29), which runs after this story merges. Until it lands this
  // case has nothing to read; from then on the checked-in file must pass the guard.
  const file = join(ROOT, 'loadtest/staging/fly.staging.toml');
  it.skipIf(!existsSync(file))('loadtest/staging/fly.staging.toml passes it', () => {
    expect(flycastProblems(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('seam 4 — the four CLIs’ option lists', () => {
  const flagsOf = (o: unknown): string[] =>
    !o || typeof o !== 'object'
      ? []
      : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
          k === 'flag' && typeof v === 'string' ? [v] : flagsOf(v),
        );
  const CLIS = {
    'loadtest:preflight': flagsOf(PREFLIGHT_OPTIONS),
    'loadtest:seed': flagsOf(SEED_OPTIONS),
    'loadtest:seed:reset': flagsOf(RESET_OPTIONS),
    'loadtest:run': flagsOf(RUN_OPTIONS),
    'loadtest:report': flagsOf(REPORT_OPTIONS),
  };

  it('each CLI is a package script and exports at least its documented flags', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;
    for (const [cli, flags] of Object.entries(CLIS)) {
      expect(scripts[cli], cli).toBeDefined();
      expect(flags.length, cli).toBeGreaterThan(0);
      for (const f of flags) expect(f, cli).toMatch(/^--[a-z][a-z0-9-]*$/);
    }
  });

  const readme = join(ROOT, 'loadtest/README.md');
  it('every exported flag is documented in loadtest/README.md', () => {
    const text = readFileSync(readme, 'utf8');
    for (const [cli, flags] of Object.entries(CLIS))
      for (const f of flags) expect(text, `${cli} ${f}`).toContain(f);
  });
});
