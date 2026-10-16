// THE RUN DIRECTORY, READ (Story MOTIR-8538 · MOTIR-8679).
//
// Every file the run command (MOTIR-8678) and the run-window capture (MOTIR-8683)
// leave in a run directory, loaded into a `Reading<T>`. A missing file, a
// `<name>.state.json` beside it (the recorder said it failed) or a parse failure is
// `unmeasured` WITH ITS REASON — never a throw, and never a zero. Only `run.json`
// is required: without it there is no run to report on (the CLI exits 2).
//
// `k6-points.json.gz` and `app-logs.ndjson` are large, so they are not loaded here:
// their PATHS are, and `k6Points.ts` / `p2028.ts` stream them.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TopStatementsResult } from '../../scripts/pgTopStatements';
import type { EndpointReading } from '../capture/neon';
import type { ResolvedProfile } from '../profiles/resolve';
import type { Gap } from '../capture/appLogs';
import { RUN_RECORD_FILE, UNMEASURED, type M, type RunRecord } from '../run/runRecord';

export type Reading<T> = { state: 'ok'; value: T } | { state: 'unmeasured'; reason: string };

export const ok = <T>(value: T): Reading<T> => ({ state: 'ok', value });
export const unmeasured = (reason: string): Reading<never> => ({ state: 'unmeasured', reason });

/** A value from `run.json`, or null when it says `unmeasured`. */
export const known = <T>(v: M<T> | undefined): T | null =>
  v === undefined || v === UNMEASURED ? null : (v as T);

export const POINTS_FILE = 'k6-points.json.gz';
export const APP_LOGS_FILE = 'app-logs.ndjson';

/** One generator CPU sample: `/proc/stat`'s first line, every 5 s (generator.ts `runScript`). */
export interface CpuSample {
  epochSeconds: number;
  nproc: number;
  busy: number;
  total: number;
}

/** One `db-samples.csv` row (capture/dbSampler.ts `DB_SAMPLE_COLUMNS`). */
export interface DbSample {
  at: string;
  backends: number;
  active: number;
  idle_in_transaction: number;
  lock_waiting: number;
  max_connections: number;
}

export interface RunInputs {
  dir: string;
  run: RunRecord;
  resolved: Reading<ResolvedProfile>;
  summary: Reading<Record<string, unknown>>;
  generatorCpu: Reading<CpuSample[]>;
  points: Reading<string>;
  appLogs: Reading<string>;
  logGaps: Reading<Gap[]>;
  dbSamples: Reading<DbSample[]>;
  endpointStart: Reading<EndpointReading>;
  endpointEnd: Reading<EndpointReading>;
  pgssBefore: Reading<TopStatementsResult>;
  pgssAfter: Reading<TopStatementsResult>;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Why a recorder's file is not a reading, or null when it may be. */
async function stateFailure(dir: string, file: string): Promise<string | null> {
  const base = file.replace(/\.(json|csv|ndjson|json\.gz)$/, '');
  const stateFile = join(dir, `${base}.state.json`);
  if (!(await exists(stateFile))) return null;
  try {
    const s = JSON.parse(await readFile(stateFile, 'utf8')) as { state?: string; reason?: string };
    return `${base}.state.json says ${s.state ?? 'failed'}${s.reason ? `: ${s.reason}` : ''}`;
  } catch {
    return `${base}.state.json is present`;
  }
}

async function readText(dir: string, file: string): Promise<Reading<string>> {
  const path = join(dir, file);
  if (!(await exists(path))) return unmeasured(`${file} is missing`);
  const failed = await stateFailure(dir, file);
  if (failed) return unmeasured(failed);
  return ok(await readFile(path, 'utf8'));
}

async function readJson<T>(dir: string, file: string): Promise<Reading<T>> {
  const text = await readText(dir, file);
  if (text.state !== 'ok') return text;
  try {
    return ok(JSON.parse(text.value) as T);
  } catch (err) {
    return unmeasured(`${file} does not parse: ${(err as Error).message}`);
  }
}

async function pathOf(dir: string, file: string): Promise<Reading<string>> {
  const path = join(dir, file);
  if (!(await exists(path))) return unmeasured(`${file} is missing`);
  const failed = await stateFailure(dir, file);
  return failed ? unmeasured(failed) : ok(path);
}

/** `generator-cpu.csv`: `epochSeconds,nproc,procStatCpu` — the last a whole `/proc/stat` line. */
export function parseGeneratorCpu(text: string): CpuSample[] {
  const out: CpuSample[] = [];
  for (const line of text.split('\n').slice(1)) {
    const [epoch, nproc, stat] = line.split(',');
    if (!epoch || !stat) continue;
    // cpu user nice system idle iowait irq softirq steal guest guest_nice
    const f = stat.trim().split(/\s+/).slice(1).map(Number);
    if (f.length < 4 || f.some((n) => !Number.isFinite(n))) continue;
    const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    out.push({ epochSeconds: Number(epoch), nproc: Number(nproc), busy: total - idle, total });
  }
  return out;
}

/** `db-samples.csv`, header first. */
export function parseDbSamples(text: string): DbSample[] {
  const [head, ...rows] = text.split('\n').filter((l) => l.trim());
  if (!head) return [];
  const cols = head.split(',');
  return rows.map((row) => {
    const v = row.split(',');
    const at = (k: string) => v[cols.indexOf(k)] ?? '';
    const num = (k: string) => Number(at(k));
    return {
      at: at('at'),
      backends: num('backends'),
      active: num('active'),
      idle_in_transaction: num('idle_in_transaction'),
      lock_waiting: num('lock_waiting'),
      max_connections: num('max_connections'),
    };
  });
}

export class NoRunRecordError extends Error {
  constructor(readonly dir: string) {
    super(`${join(dir, RUN_RECORD_FILE)} is missing or unreadable — there is no run to report on`);
    this.name = 'NoRunRecordError';
  }
}

export async function loadRunInputs(dir: string): Promise<RunInputs> {
  let run: RunRecord;
  try {
    run = JSON.parse(await readFile(join(dir, RUN_RECORD_FILE), 'utf8')) as RunRecord;
  } catch {
    throw new NoRunRecordError(dir);
  }
  const csv = async <T>(file: string, parse: (t: string) => T[]): Promise<Reading<T[]>> => {
    const t = await readText(dir, file);
    if (t.state !== 'ok') return t;
    const rows = parse(t.value);
    return rows.length > 0 ? ok(rows) : unmeasured(`${file} holds no samples`);
  };
  return {
    dir,
    run,
    resolved: await readJson<ResolvedProfile>(dir, 'profile.resolved.json'),
    summary: await readJson<Record<string, unknown>>(dir, 'summary.json'),
    generatorCpu: await csv('generator-cpu.csv', parseGeneratorCpu),
    points: await pathOf(dir, POINTS_FILE),
    appLogs: await pathOf(dir, APP_LOGS_FILE),
    logGaps: await readJson<Gap[]>(dir, 'app-logs.gaps.json'),
    dbSamples: await csv('db-samples.csv', parseDbSamples),
    endpointStart: await readJson<EndpointReading>(dir, 'neon-endpoint-start.json'),
    endpointEnd: await readJson<EndpointReading>(dir, 'neon-endpoint-end.json'),
    pgssBefore: await readJson<TopStatementsResult>(dir, 'pgss-before.json'),
    pgssAfter: await readJson<TopStatementsResult>(dir, 'pgss-after.json'),
  };
}
