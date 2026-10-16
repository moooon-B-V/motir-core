// THE STAGING APP'S LOGS, FOR THE WHOLE RUN (Story MOTIR-8538 · MOTIR-8683).
//
// One `fly logs -a <app> --json` stream, unfiltered: with no `--machine` it
// carries every machine of the app (flyctl's help: logs "can be filtered to a
// specific machine using --machine/-m"), `app` and `worker` alike, and each line
// names its machine in its own `instance` field.
//
// Fly keeps only a short buffer (`fly logs --no-tail` returns about 100 lines), so
// capturing while the run happens is the only way to have these lines afterwards.
// They are CORROBORATION, not the P2028 source (the app writes no P2028 line; the
// report reads the platform's `db_tx_wait_seconds_count` counter) — they carry the
// app's other errors and the proxy's own codes (`PL01`/`PL02`, `PR01`).
//
// A stream that exits is restarted with backoff until `stop()`. flyctl has no
// `--since`, so a reconnect cannot backfill: the uncovered interval is written to
// `app-logs.gaps.json`, which is the honest record. Lines the buffer replays on
// reconnect are dropped by (timestamp, instance, message).
//
// ⚠️ The JSON field names (`timestamp`, `instance`, `message`) follow flyctl's
// log entry as documented; no flyctl was reachable where this was written, so the
// first real run reads one line and confirms them (MOTIR-8683's recorded
// discrepancy). With N = 2 both machine ids must appear; if the unfiltered stream
// ever carries only one, start one stream per machine with `--machine <id>`.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const APP_LOGS_FILE = 'app-logs.ndjson';
export const APP_LOGS_GAPS_FILE = 'app-logs.gaps.json';
export const APP_LOGS_STATE_FILE = 'app-logs.state.json';

/** A running `fly <args>` whose stdout arrives line by line. */
export interface LogStream {
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number>;
  kill(): void;
}

/** Starts `fly <args>`, calling `onLine` per stdout line. Injected so tests can stub it. */
export type LogRunner = (args: readonly string[], onLine: (line: string) => void) => LogStream;

/* v8 ignore start -- the production stream; tests inject a stub. */
export const spawnLogRunner: LogRunner = (args, onLine) => {
  const child = spawn('fly', [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  createInterface({ input: child.stdout }).on('line', onLine);
  const exited = new Promise<number>((resolveExit) => {
    child.on('error', () => resolveExit(127));
    child.on('close', (code) => resolveExit(code ?? 1));
  });
  return { exited, kill: () => child.kill('SIGTERM') };
};
/* v8 ignore stop */

export interface Gap {
  from: string;
  to: string;
  exitCode: number;
}

export interface AppLogCapture {
  /** Stop streaming, flush, and write the gaps (and state) files. */
  stop(): Promise<{ lines: number; gaps: Gap[]; instances: string[] }>;
}

/** The dedupe key of one line, or null when it is not a JSON log entry. */
export function lineKey(line: string): { key: string; instance: string | null } | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const instance = typeof entry['instance'] === 'string' ? entry['instance'] : null;
  return {
    key: JSON.stringify([entry['timestamp'] ?? null, instance, entry['message'] ?? null]),
    instance,
  };
}

/** The `fly logs` arguments: unfiltered, so every machine of the app. */
export const logsArgs = (app: string) => ['logs', '-a', app, '--json'];

export async function startAppLogCapture(opts: {
  app: string;
  runner: LogRunner;
  outDir: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
}): Promise<AppLogCapture> {
  if (opts.app === 'motir-core') {
    throw new Error('refused: the log capture never reads production (motir-core)');
  }
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? 2000;
  await mkdir(opts.outDir, { recursive: true });
  const out = createWriteStream(join(opts.outDir, APP_LOGS_FILE), { flags: 'w' });

  const seen = new Set<string>();
  const instances = new Set<string>();
  const gaps: Gap[] = [];
  const failures: { at: string; exitCode: number }[] = [];
  let lines = 0;
  let stopped = false;
  let current: LogStream | null = null;

  const onLine = (line: string) => {
    if (!line.trim()) return;
    const k = lineKey(line);
    if (k) {
      if (seen.has(k.key)) return;
      seen.add(k.key);
      if (k.instance) instances.add(k.instance);
    }
    out.write(`${line}\n`);
    lines += 1;
  };

  const loop = (async () => {
    while (!stopped) {
      current = opts.runner(logsArgs(opts.app), onLine);
      const code = await current.exited;
      if (stopped) break;
      const from = now().toISOString();
      failures.push({ at: from, exitCode: code });
      await sleep(backoff);
      // The interval no stream covered: from the exit to the reconnect (or the stop).
      gaps.push({ from, to: now().toISOString(), exitCode: code });
    }
  })();

  return {
    async stop() {
      stopped = true;
      current?.kill();
      await loop;
      await new Promise<void>((r) => out.end(r));
      await writeFile(join(opts.outDir, APP_LOGS_GAPS_FILE), `${JSON.stringify(gaps, null, 2)}\n`);
      if (failures.length > 0) {
        await writeFile(
          join(opts.outDir, APP_LOGS_STATE_FILE),
          `${JSON.stringify(
            {
              state: lines > 0 ? 'partial' : 'failed',
              reason: `fly logs exited ${failures.length} time(s) during the run`,
              failures,
            },
            null,
            2,
          )}\n`,
        );
      }
      return { lines, gaps, instances: [...instances].sort() };
    },
  };
}
