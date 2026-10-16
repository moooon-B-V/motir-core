// THE RUN-WINDOW RECORDERS, TOGETHER (Story MOTIR-8538 · MOTIR-8683).
//
// The run command starts these after its seed step and before k6, and stops them
// after k6's results are fetched. Each writes into the run directory:
//
//   app-logs.ndjson + app-logs.gaps.json   every staging machine's log lines
//   db-samples.csv                         a database load sample every 10 s
//   neon-endpoint-start.json / -end.json   the endpoint's compute state
//   pgss-before.json / pgss-after.json     pg_stat_statements, top 200 ×3
//
// (`k6-points.json.gz` is k6's own, fetched from the generator.) A recorder that
// fails writes what it has plus `<name>.state.json` and NEVER fails the run: the
// report turns a missing or partial recording into `unmeasured`. All of them run on
// the operator machine; none needs a route to the private app, and none writes to
// any database.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../run/fly';
import {
  APP_LOGS_GAPS_FILE,
  APP_LOGS_STATE_FILE,
  spawnLogRunner,
  startAppLogCapture,
  type AppLogCapture,
  type LogRunner,
} from './appLogs';
import {
  startDbSampler,
  DB_SAMPLES_FILE,
  DB_SAMPLES_STATE_FILE,
  DB_SAMPLE_COLUMNS,
  type DbSampler,
  type SamplerClient,
} from './dbSampler';
import { readEndpointState, resolveBranchDirectUrl } from './neon';
import { snapshotPgss, type ReadTopStatements } from './pgss';
import { redact } from './redact';

export const CAPTURE_FILES = [
  'app-logs.ndjson',
  'app-logs.gaps.json',
  'db-samples.csv',
  'neon-endpoint-start.json',
  'neon-endpoint-end.json',
  'pgss-before.json',
  'pgss-after.json',
] as const;

export interface CaptureDeps {
  logRunner?: LogRunner;
  fetchImpl?: typeof fetch;
  readTopStatements?: ReadTopStatements;
  dbClient?: (url: string) => SamplerClient;
  sampleIntervalMs?: number;
}

export interface Recorders {
  stop(): Promise<{ logLines: number; logGaps: number; logInstances: string[]; dbSamples: number }>;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export async function startRecorders(ctx: {
  app: string;
  outDir: string;
  exec: Exec;
  env: Readonly<Record<string, string | undefined>>;
  project: string;
  branch: string;
  branchId: string;
  now: () => Date;
  log: (line: string) => void;
  deps?: CaptureDeps;
}): Promise<Recorders> {
  const d = ctx.deps ?? {};
  const failed = (what: string, err: unknown, secrets: string[] = []) => {
    const reason = redact((err as Error).message, secrets);
    ctx.log(
      `capture: ${what} failed — ${reason} (the run goes on; the report reads it as unmeasured)`,
    );
    return reason;
  };

  // The app's logs.
  let logs: AppLogCapture | null = null;
  try {
    logs = await startAppLogCapture({
      app: ctx.app,
      runner: d.logRunner ?? spawnLogRunner,
      outDir: ctx.outDir,
      now: ctx.now,
    });
  } catch (err) {
    const reason = failed('the log capture', err);
    await writeFile(join(ctx.outDir, APP_LOGS_GAPS_FILE), json([]));
    await writeFile(join(ctx.outDir, 'app-logs.ndjson'), '');
    await writeFile(join(ctx.outDir, APP_LOGS_STATE_FILE), json({ state: 'failed', reason }));
  }

  // The direct URL, in memory only.
  let directUrl: string | null = null;
  let directUnread = '';
  try {
    directUrl = await resolveBranchDirectUrl(ctx.exec, ctx.project, ctx.branch);
  } catch (err) {
    directUnread = failed('resolving the branch direct URL', err);
  }

  // The database sampler.
  let sampler: DbSampler | null = null;
  if (directUrl) {
    try {
      sampler = await startDbSampler({
        directUrl,
        outDir: ctx.outDir,
        intervalMs: d.sampleIntervalMs,
        now: ctx.now,
        client: d.dbClient,
      });
    } catch (err) {
      directUnread = failed('the database sampler', err, [directUrl]);
    }
  }
  if (!sampler) {
    await writeFile(join(ctx.outDir, DB_SAMPLES_FILE), `${DB_SAMPLE_COLUMNS.join(',')}\n`);
    await writeFile(
      join(ctx.outDir, DB_SAMPLES_STATE_FILE),
      json({ state: 'failed', reason: directUnread }),
    );
  }

  const endpoint = async (file: string) =>
    writeFile(
      join(ctx.outDir, file),
      json(
        await readEndpointState({
          env: ctx.env,
          project: ctx.project,
          branchId: ctx.branchId,
          now: ctx.now,
          fetchImpl: d.fetchImpl,
        }),
      ),
    );
  await endpoint('neon-endpoint-start.json');
  await snapshotPgss({
    name: 'pgss-before',
    directUrl,
    outDir: ctx.outDir,
    read: d.readTopStatements,
    unreadReason: directUnread,
  });

  return {
    async stop() {
      const l = logs ? await logs.stop() : { lines: 0, gaps: [], instances: [] };
      const s = sampler ? await sampler.stop() : { rows: 0 };
      await endpoint('neon-endpoint-end.json');
      await snapshotPgss({
        name: 'pgss-after',
        directUrl,
        outDir: ctx.outDir,
        read: d.readTopStatements,
        unreadReason: directUnread,
      });
      return {
        logLines: l.lines,
        logGaps: l.gaps.length,
        logInstances: l.instances,
        dbSamples: s.rows,
      };
    },
  };
}
