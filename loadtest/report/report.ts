// `pnpm loadtest:report <run dir> [--publish]` (Story MOTIR-8538 · MOTIR-8679).
//
// Reads a run directory, writes `report.md` and `report.json` into it, prints the
// verdict, and EXITS WITH THE VERDICT:
//   0 PASS · 1 FAIL · 3 UNMEASURED · 6 INVALID · 2 no run directory / run.json
// The run command (MOTIR-8678) invokes it as its last step whenever a run.json
// exists — after exit 4 or 5 too, so a refused or interrupted run is reported
// INVALID with its reason.
//
// It waits until `window.endedAt + LOADTEST_PROM_SETTLE_SECONDS` (default 60 s: Fly
// scrapes every 15 s, plus ingestion) before it asks Prometheus; on an old run
// directory that moment has passed, so it does not wait.
//
// THE REPORT READS; IT CHANGES NOTHING. Its only platform calls are Prometheus
// reads against the staging app's label. `--publish` copies the two report files
// into `loadtest/reports/<date>-<profile>-n<N>-<runId8>/` — the run directory itself
// is gitignored because it holds tokens — and refuses if either holds a cookie, a
// bearer token or a connection string.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { LoadProfile } from '../profiles/schema';
import type { Exec } from '../run/fly';
import { spawnExec } from '../run/fly';
import type { RunRecord } from '../run/runRecord';
import {
  readCandidates,
  rankCandidates,
  readWaitHold,
  statementDelta,
  type BottleneckConfig,
} from './bottleneck';
import {
  known,
  loadRunInputs,
  NoRunRecordError,
  ok,
  unmeasured,
  type CpuSample,
  type Reading,
  type RunInputs,
} from './inputs';
import { aggregatePoints, type PointsAggregate } from './k6Points';
import { judgeP2028, readLogP2028, readPlatformP2028 } from './p2028';
import { createPromClient, PRODUCTION_APP } from './prometheus';
import { countProxyCodes, readPlatform503, type ProxyShed } from './proxyShed';
import {
  renderJson,
  renderMarkdown,
  type GeneratorLoad,
  type Report,
  type Verdict,
} from './render';
import { readBaseline, readRoutingShares, scaleOutLine } from './scaleOut';
import { evaluateLines, routeTable, type Line } from './thresholds';

export const EXIT = { PASS: 0, FAIL: 1, missing: 2, UNMEASURED: 3, INVALID: 6 } as const;
export const SETTLE_SECONDS_DEFAULT = 60;
export const REPORTS_DIR = join('loadtest', 'reports');

/** The surface the runbook's guard test reads. */
export const OPTIONS = {
  usage: 'pnpm loadtest:report <run dir> [--publish]',
  flags: {
    publish: {
      flag: '--publish',
      help: 'copy report.md and report.json to loadtest/reports/<date>-<profile>-n<N>-<runId8>/',
    },
  },
  env: {
    LOADTEST_PROM_URL: `Fly managed Prometheus base URL (default https://api.fly.io/prometheus/moooon)`,
    LOADTEST_PROM_SETTLE_SECONDS: `seconds after window.endedAt before Prometheus is read (default ${SETTLE_SECONDS_DEFAULT})`,
    LOADTEST_FLY_PROM_TOKEN: 'the Prometheus token; else `fly auth token`',
    LOADTEST_FLY_PROM_TOKEN_SCHEME:
      'FlyV1 (the default, what a `fly auth token` value needs) or Bearer',
  },
  exits: {
    0: 'PASS',
    1: 'FAIL',
    2: 'the run directory or its run.json is missing',
    3: 'UNMEASURED — a threshold could not be read, so the run cannot PASS',
    6: 'INVALID — the run did not hold its instances, did not complete, or saturated its generator',
  },
} as const;

export interface ReportDeps {
  env: Readonly<Record<string, string | undefined>>;
  exec: Exec;
  cwd: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
}

const ms = (iso: unknown) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/** The generator's CPU over the steady window, from the `/proc/stat` samples. */
export function generatorLoad(
  cpu: Reading<CpuSample[]>,
  steady: { start: number; end: number } | null,
  cfg: LoadProfile['thresholds']['generator'],
): GeneratorLoad {
  if (cpu.state !== 'ok')
    return { status: 'unmeasured', mean: null, peak: null, reason: cpu.reason };
  if (!steady)
    return {
      status: 'unmeasured',
      mean: null,
      peak: null,
      reason: 'the steady window is unmeasured',
    };
  const s = cpu.value.filter(
    (x) => x.epochSeconds * 1000 >= steady.start && x.epochSeconds * 1000 <= steady.end,
  );
  if (s.length < 2)
    return {
      status: 'unmeasured',
      mean: null,
      peak: null,
      reason: 'fewer than two CPU samples in the steady window',
    };
  const util = (a: CpuSample, b: CpuSample) =>
    b.total > a.total ? (b.busy - a.busy) / (b.total - a.total) : 0;
  const mean = util(s[0]!, s.at(-1)!);
  let peak = 0;
  for (let i = 1; i < s.length; i += 1) {
    let j = i - 1;
    while (j > 0 && s[i]!.epochSeconds - s[j]!.epochSeconds < cfg.peakSeconds) j -= 1;
    if (s[i]!.epochSeconds - s[j]!.epochSeconds >= cfg.peakSeconds)
      peak = Math.max(peak, util(s[j]!, s[i]!));
  }
  const saturated = mean >= cfg.cpuMeanMax || peak >= cfg.cpuPeakMax;
  return {
    status: saturated ? 'saturated' : 'ok',
    mean,
    peak,
    reason: saturated
      ? `limits mean ${cfg.cpuMeanMax}, any ${cfg.peakSeconds} s ${cfg.cpuPeakMax}`
      : null,
  };
}

/** Machine size, as `<cpuKind>-<cpus>x-<memoryMb>MB`, joined when machines differ. */
export function sizeOf(run: RunRecord): string {
  const machines = known(run.app.machines);
  if (!machines || machines.length === 0) return 'unmeasured';
  return [
    ...new Set(machines.map((m) => `${m.cpuKind}-${String(m.cpus)}x-${String(m.memoryMb)}MB`)),
  ].join(' + ');
}

function headerOf(
  inputs: RunInputs,
  extra: {
    promEndpoint: string;
    promQueriedAt: string | null;
    settleSeconds: number;
    generator: GeneratorLoad;
  },
) {
  const run = inputs.run;
  const pg = (r: RunInputs['pgssBefore']) =>
    r.state === 'ok' && r.value.state === 'ok'
      ? {
          host: r.value.answeredBy.host,
          computeStartedAt: r.value.answeredBy.computeStartedAt,
          statsReset: r.value.coverage.statsReset,
        }
      : 'unmeasured';
  const machines = known(run.app.machines);
  return {
    instances: run.instances,
    sha: run.sha,
    shaReadFrom: run.shaReadFrom,
    neon: run.neon,
    app: {
      name: run.app.name,
      size: sizeOf(run),
      machines: machines
        ? machines.map((m) => ({
            id: m.id,
            region: m.region,
            cpus: m.cpus,
            memoryMb: m.memoryMb,
            imageRef: m.imageRef,
          }))
        : 'unmeasured',
    },
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
      cpuMean: extra.generator.mean ?? 'unmeasured',
      cpuMax: extra.generator.peak ?? 'unmeasured',
    },
    k6: { version: run.k6.version, extensions: run.k6.extensions },
    window: run.window,
    prometheus: {
      endpoint: extra.promEndpoint,
      app: run.app.name,
      queriedAt: extra.promQueriedAt ?? 'unmeasured',
      /** The post-window wait before the first query (LOADTEST_PROM_SETTLE_SECONDS, default 60). */
      settleSeconds: extra.settleSeconds,
    },
    pgStatStatements: { before: pg(inputs.pgssBefore), after: pg(inputs.pgssAfter) },
    baseline: run.baseline ?? 'none (N = 1)',
  };
}

/** Identifiers and configuration only — no measured value, no time. */
export function comparableOf(run: RunRecord): Record<string, unknown> {
  const machines = known(run.app.machines);
  return {
    sha: run.sha,
    neonBranchId: run.neon.branchId,
    neonCopiedAt: run.neon.copiedAt,
    app: run.app.name,
    machineIds: machines ? machines.map((m) => m.id).sort() : 'unmeasured',
    size: sizeOf(run),
    instances: run.instances,
    profile: run.profile.name,
    loadHash: run.profile.sha256,
    concurrency: run.concurrency,
    requiredConcurrency: run.requiredConcurrency,
    rateLimits: run.rateLimits,
    traceRate: run.traceRate,
    generatorMachineId: run.generator.machineId,
    generatorCpus: run.generator.cpus,
    k6Version: run.k6.version,
    baseline: run.baseline,
  };
}

export function verdictOf(
  run: RunRecord,
  lines: Line[],
  generator: GeneratorLoad,
): { verdict: Verdict; reasons: string[] } {
  const invalid: string[] = [];
  if (run.instancesHeld !== true)
    invalid.push(
      run.instancesHeld === false
        ? 'the app machine set changed during the run'
        : 'the machine set was never confirmed held',
    );
  if (run.exitCode !== 0)
    invalid.push(`the run exited ${String(run.exitCode)}${run.reason ? `: ${run.reason}` : ''}`);
  if (generator.status === 'saturated')
    invalid.push(`the generator saturated (${generator.reason})`);
  if (invalid.length > 0) return { verdict: 'INVALID', reasons: invalid };
  const judged = lines.filter((l) => l.status !== 'n/a');
  const failed = judged.filter((l) => l.status === 'FAIL');
  if (failed.length > 0) return { verdict: 'FAIL', reasons: failed.map((l) => `${l.name} FAIL`) };
  const um = judged.filter((l) => l.status === 'unmeasured').map((l) => `${l.name} unmeasured`);
  if (generator.status === 'unmeasured') um.push('generator CPU unmeasured');
  if (um.length > 0) return { verdict: 'UNMEASURED', reasons: um };
  return { verdict: 'PASS', reasons: [] };
}

export async function buildReport(dir: string, deps: ReportDeps): Promise<Report> {
  const inputs = await loadRunInputs(dir);
  const run = inputs.run;
  const settleRead = Number(deps.env['LOADTEST_PROM_SETTLE_SECONDS'] ?? SETTLE_SECONDS_DEFAULT);
  const settle = Number.isFinite(settleRead) ? settleRead : SETTLE_SECONDS_DEFAULT;
  const endedAt = ms(known(run.window.endedAt));
  if (Number.isFinite(endedAt)) {
    const wait = endedAt + settle * 1000 - deps.now().getTime();
    if (wait > 0) {
      deps.log(
        `report: waiting ${Math.ceil(wait / 1000)} s for Prometheus to ingest the run's last scrape`,
      );
      await deps.sleep(wait);
    }
  }
  if (run.app.name === PRODUCTION_APP)
    throw new Error('refused: the report never reads production (motir-core)');

  const resolved = inputs.resolved;
  const thresholds: LoadProfile['thresholds'] | null =
    resolved.state === 'ok' ? resolved.value.thresholds : null;
  const startedAt = ms(known(run.window.startedAt));
  const rampEnd = ms(known(run.window.rampEndedAt));
  const steadyEnd = ms(known(run.window.steadyEndedAt));
  const steady =
    Number.isFinite(rampEnd) && Number.isFinite(steadyEnd)
      ? { start: rampEnd, end: steadyEnd }
      : null;
  const whole =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? { start: startedAt, end: endedAt }
      : null;

  let points: Reading<PointsAggregate>;
  if (inputs.points.state !== 'ok') points = inputs.points;
  else if (!steady || !whole) points = unmeasured('the run window is unmeasured');
  else {
    try {
      points = ok(await aggregatePoints(inputs.points.value, steady, whole));
    } catch (err) {
      points = unmeasured(`${inputs.points.value} could not be read: ${(err as Error).message}`);
    }
  }

  const prom = createPromClient({
    app: run.app.name,
    env: deps.env,
    exec: deps.exec,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  const machines = known(run.app.machines);
  const machineIds = machines ? machines.map((m) => m.id) : null;

  const p2028 = judgeP2028(
    whole
      ? await readPlatformP2028({ prom, machineIds, window: whole })
      : { unmeasured: 'the run window is unmeasured' },
    whole
      ? await readLogP2028({ appLogs: inputs.appLogs, gaps: inputs.logGaps, window: whole })
      : { state: 'unmeasured', reason: 'the run window is unmeasured', total: 0, byInstance: {} },
    thresholds?.perInstance.p2028 ?? 0,
  );

  const proxyShed: ProxyShed = {
    platform: whole
      ? await readPlatform503(prom, whole)
      : unmeasured('the run window is unmeasured'),
    logCodes: await countProxyCodes(inputs.appLogs),
    client503: points.state === 'ok' ? ok(points.value.http503) : points,
  };

  const crossChecks: string[] = [];
  if (points.state === 'ok' && inputs.summary.state === 'ok') {
    const m = (inputs.summary.value['metrics'] ?? {}) as Record<string, Record<string, number>>;
    const mcpSummary = m['mcp_rate_limited']?.['passes'];
    const runSummary = m['run_limited']?.['count'];
    crossChecks.push(
      `mcp_rate_limited (summary.json, a Rate: passes = the sum of its values) ${show(mcpSummary)} vs mcp_calls outcome limited over the run ${points.value.limitedWholeRun.mcp}`,
      `run_limited (summary.json) ${show(runSummary)} vs run_steps outcome limited over the run ${points.value.limitedWholeRun.run}`,
    );
  }
  if (points.state === 'ok')
    crossChecks.push(
      `${points.value.outsideSteady} judged samples fell outside the steady window and were not judged`,
    );

  let lines: Line[] = [];
  let measures: Report['measures'] = { servedRps: null, perInstanceRps: null, refusals: null };
  let generator: GeneratorLoad = {
    status: 'unmeasured',
    mean: null,
    peak: null,
    reason: 'profile.resolved.json is unreadable',
  };
  let candidates: Awaited<ReturnType<typeof readCandidates>> = [];
  if (!thresholds) {
    lines = [
      {
        key: 'thresholds',
        name: 'thresholds',
        status: 'unmeasured',
        value: 'unmeasured',
        limit: 'profile.resolved.json',
        reason: resolved.state === 'ok' ? null : resolved.reason,
      },
    ];
  } else {
    const n = run.instances;
    let baseline = null;
    let routing = null;
    if (n > 1) {
      baseline = run.baseline
        ? await readBaseline(run.baseline, { loadHash: run.profile.sha256, size: sizeOf(run) })
        : null;
      routing = steady
        ? await readRoutingShares(prom, steady, n)
        : unmeasured('the steady window is unmeasured');
    }
    const first = evaluateLines({
      n,
      thresholds,
      points,
      p2028,
      scaleOut: {
        key: 'scaleOut.efficiency',
        name: 'scale-out',
        status: 'n/a',
        value: '',
        limit: '',
        reason: null,
      },
    });
    measures = first.measures;
    const scale = scaleOutLine({
      n,
      servedRps: measures.servedRps,
      efficiency: thresholds.scaleOut.efficiency,
      baseline,
      routing,
    });
    lines = first.lines.map((l) => (l.key === 'scaleOut.efficiency' ? scale : l));
    generator = generatorLoad(inputs.generatorCpu, steady, thresholds.generator);
    if (generator.status === 'saturated')
      lines = lines.map((l) =>
        l.status === 'FAIL'
          ? {
              ...l,
              annotation: [l.annotation, 'measured with a saturated generator']
                .filter(Boolean)
                .join(' — '),
            }
          : l,
      );
    if (steady) {
      const concurrency = known(run.concurrency);
      const shedSummary = [
        `platform 503 ${proxyShed.platform.state === 'ok' ? Object.values(proxyShed.platform.value).reduce<number>((a, v) => a + (v ?? 0), 0) : 'unmeasured'}`,
        `log codes ${proxyShed.logCodes.state === 'ok' ? Object.values(proxyShed.logCodes.value).reduce((a, v) => a + v, 0) : 'unmeasured'}`,
        `client http_503 ${proxyShed.client503.state === 'ok' ? proxyShed.client503.value : 'unmeasured'}`,
      ].join(', ');
      candidates = await readCandidates({
        prom,
        steady,
        machines,
        hardLimit: concurrency ? known(concurrency.hardLimit) : null,
        config: thresholds.bottleneck as BottleneckConfig,
        dbSamples: inputs.dbSamples,
        endpointStart: inputs.endpointStart,
        endpointEnd: inputs.endpointEnd,
        readerStreamsPerInstance: run.offered.readerStreamsPerInstance,
        proxyShedSummary: shedSummary,
      });
    }
  }

  const routes = points.state === 'ok' ? ok(routeTable(points.value)) : points;
  const waitHold = steady
    ? await readWaitHold(prom, steady)
    : unmeasured('the steady window is unmeasured');
  const statements = statementDelta(inputs.pgssBefore, inputs.pgssAfter);
  const anyFail = lines.some((l) => l.status === 'FAIL');
  const worstWait =
    waitHold.state === 'ok'
      ? [...waitHold.value]
          .filter((w) => w.by === 'route')
          .sort((a, b) => (b.waitP95 ?? -1) - (a.waitP95 ?? -1))[0]
      : undefined;
  const first = rankCandidates(candidates, anyFail, {
    worstRouteByP95:
      routes.state === 'ok' && routes.value[0]
        ? `${routes.value[0].route} (p95 ${Math.round(routes.value[0].p95 ?? 0)} ms)`
        : 'unmeasured',
    worstWaitRoute: worstWait
      ? `${worstWait.name} (wait p95 ${worstWait.waitP95} s)`
      : 'unmeasured',
    topStatement:
      statements.state === 'ok' && statements.top[0]
        ? `${statements.top[0].query.slice(0, 120)} (Δ ${Math.round(statements.top[0].totalMsDelta)} ms)`
        : 'unmeasured',
  });

  const { verdict, reasons } = verdictOf(run, lines, generator);
  const header = headerOf(inputs, {
    promEndpoint: prom.endpoint,
    promQueriedAt: prom.queriedAt(),
    settleSeconds: settle,
    generator,
  });
  return {
    verdict,
    verdictReasons: reasons,
    exitCode: EXIT[verdict],
    servedRps: measures.servedRps,
    header,
    comparable: comparableOf(run),
    lines,
    measures,
    p2028,
    proxyShed,
    generator,
    bottleneck: {
      first,
      candidates,
      caveats: [
        'The database candidate reads the DIRECT endpoint only, so it cannot see pooler saturation; the app’s pg.Pool (default max 10 per runtime) is the likelier first limit.',
        `Every held stream costs one workbench watermark read per second: readerStreamsPerInstance ${run.offered.readerStreamsPerInstance} is background database load named here, not lost inside a req/s figure.`,
      ],
    },
    tables: { routes, waitHold, statements },
    crossChecks,
  };
}

const show = (v: unknown) => (v === undefined || v === null ? 'unmeasured' : String(v));

/** What --publish refuses to copy: anything shaped like a cookie, bearer token or connection string. */
export const SECRET_SHAPES: readonly RegExp[] = [
  /\bpostgres(?:ql)?:\/\/\S+/i,
  /\b(?:Bearer|FlyV1)\s+[A-Za-z0-9._~+/=-]{12,}/,
  /\b(?:set-)?cookie\s*:/i,
  /better-auth\.session_token/i,
  /__Secure-[\w.-]+=/,
];

export class PublishRefusedError extends Error {
  constructor(file: string) {
    super(`refused to publish: ${file} contains a cookie, bearer token or connection string`);
    this.name = 'PublishRefusedError';
  }
}

/**
 * Eight characters that keep two published runs apart. A run id starts with its
 * UTC stamp (`20261015T221500Z-…`), whose first eight characters are only the
 * date the folder name already carries, so the stamp's time part is used.
 */
export function runId8(runId: string): string {
  return /^\d{8}(T\d{6}Z)/.exec(runId)?.[1] ?? runId.slice(0, 8);
}

export async function publishReport(runDir: string, cwd: string, run: RunRecord): Promise<string> {
  for (const f of ['report.md', 'report.json']) {
    const text = await readFile(join(runDir, f), 'utf8');
    if (SECRET_SHAPES.some((re) => re.test(text))) throw new PublishRefusedError(f);
  }
  const started = known(run.window.startedAt);
  const date = (started ?? new Date().toISOString()).slice(0, 10);
  const dest = join(
    cwd,
    REPORTS_DIR,
    `${date}-${run.profile.name}-n${run.instances}-${runId8(run.runId)}`,
  );
  await mkdir(dest, { recursive: true });
  for (const f of ['report.md', 'report.json']) await copyFile(join(runDir, f), join(dest, f));
  return dest;
}

/** The CLI, testable: returns the exit code. */
export async function runReportCli(argv: readonly string[], deps: ReportDeps): Promise<number> {
  const args = argv.filter((a) => a !== OPTIONS.flags.publish.flag);
  const publish = argv.includes(OPTIONS.flags.publish.flag);
  const dirArg = args[0];
  if (!dirArg) {
    deps.log(`usage: ${OPTIONS.usage}`);
    return EXIT.missing;
  }
  const dir = resolvePath(deps.cwd, dirArg);
  let report: Report;
  try {
    report = await buildReport(dir, deps);
  } catch (err) {
    if (err instanceof NoRunRecordError) {
      deps.log(err.message);
      return EXIT.missing;
    }
    throw err;
  }
  await writeFile(join(dir, 'report.md'), renderMarkdown(report));
  await writeFile(join(dir, 'report.json'), renderJson(report));
  deps.log(
    `verdict: ${report.verdict}${report.verdictReasons.length ? ` — ${report.verdictReasons.join('; ')}` : ''}`,
  );
  deps.log(`report: ${join(dir, 'report.md')}`);
  if (publish) {
    const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunRecord;
    try {
      deps.log(`published: ${await publishReport(dir, deps.cwd, run)}`);
    } catch (err) {
      if (!(err instanceof PublishRefusedError)) throw err;
      // The verdict still stands; the refusal is printed and nothing was copied.
      deps.log(`NOT published — ${err.message}`);
    }
  }
  return report.exitCode;
}

/* v8 ignore start -- the process entry over `runReportCli`, which tests/loadtest/report.test.ts drives. */
if (/report[\\/]report\.ts$/.test(process.argv[1] ?? '')) {
  runReportCli(process.argv.slice(2), {
    env: process.env,
    exec: spawnExec,
    cwd: process.cwd(),
    now: () => new Date(),
    sleep: (t) => new Promise((r) => setTimeout(r, t)),
    log: (line) => process.stdout.write(`${line}\n`),
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exit(EXIT.INVALID);
    });
}
/* v8 ignore stop */
