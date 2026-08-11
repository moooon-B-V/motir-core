// The E2E harness watchdog reporter (MOTIR-2617).
//
// Registered in `playwright.config.ts` alongside `list` + `html`. It does the
// two things `tests/e2e/_helpers/harness-watchdog.ts` documents:
//
//   RECORD — a JSONL memory series (system MemAvailable + the webServer's RSS)
//   sampled on a timer and at every test boundary, written to
//   `out/e2e-harness/<leg>-harness.jsonl` and uploaded with the leg's artifacts.
//   Each `test` record also carries that spec's duration, so the series doubles
//   as the measurement `tests/e2e/shard-plan.ts` is derived from.
//
//   FAIL FAST — on the FIRST failure of a test (retry 0), re-probe the server.
//   If it has stopped answering, print one named error and interrupt the run, so
//   the shard does not spend a second 180 s timeout retrying against a corpse.
//
// ⚠️ On the abort mechanism: Playwright's Reporter interface has no "stop the
// run" call, and it does not await an async hook. So the abort is a SIGINT to
// our own process — exactly what Ctrl-C does — which Playwright handles by
// stopping cleanly, marking the remainder `interrupted`, still writing the
// report, and exiting non-zero. Because the hook is not awaited, the retry may
// have begun by the time the ~5 s probe answers; SIGINT then interrupts it. The
// guarantee is therefore "one spec timeout plus a few seconds", not "not one
// millisecond of the retry" — which is the whole 6-minute cost either way.

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import {
  appendSeriesRecord,
  degradedServerMessage,
  probeServerAlive,
  sampleMemory,
  type MemorySample,
} from '../_helpers/harness-watchdog';

export interface HarnessWatchdogOptions {
  /** The matrix leg this run belongs to (`E2E_SHARD`, else 'local'). */
  legId?: string;
  /** JSONL destination. Defaults to `out/e2e-harness/<leg>-harness.jsonl`. */
  outputFile?: string;
  /** The webServer's port, for RSS resolution. */
  port?: number;
  /** The URL the liveness probe hits. */
  probeUrl?: string;
  /** Timer sampling period. */
  sampleIntervalMs?: number;
  /** Set false to record only, never abort (`E2E_WATCHDOG=record`). */
  abortOnDeadServer?: boolean;
  /** Seams for the unit tests. */
  now?: () => number;
  sample?: (port: number) => MemorySample | null;
  probe?: (url: string) => Promise<{ alive: boolean; detail: string }>;
  abort?: (message: string) => void;
  log?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 10_000;

export default class HarnessWatchdogReporter implements Reporter {
  private readonly legId: string;
  private readonly outputFile: string;
  private readonly port: number;
  private readonly probeUrl: string;
  private readonly sampleIntervalMs: number;
  private readonly abortOnDeadServer: boolean;
  private readonly now: () => number;
  private readonly sample: (port: number) => MemorySample | null;
  private readonly probe: (url: string) => Promise<{ alive: boolean; detail: string }>;
  private readonly abort: (message: string) => void;
  private readonly log: (message: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private lastSample: MemorySample | null = null;
  private aborted = false;
  /** Recording is off wherever `/proc` isn't readable (macOS locally). */
  private recording = true;

  constructor(options: HarnessWatchdogOptions = {}) {
    const mode = process.env['E2E_WATCHDOG'] ?? '';
    this.legId = options.legId ?? process.env['E2E_SHARD'] ?? 'local';
    this.outputFile = options.outputFile ?? `out/e2e-harness/${this.legId}-harness.jsonl`;
    this.port = options.port ?? Number(process.env['PORT'] ?? 3000);
    this.probeUrl = options.probeUrl ?? `http://localhost:${this.port}/sign-up`;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.abortOnDeadServer = options.abortOnDeadServer ?? mode !== 'record';
    this.now = options.now ?? Date.now;
    this.sample = options.sample ?? ((port) => sampleMemory(port));
    this.probe = options.probe ?? ((url) => probeServerAlive({ url }));
    this.abort =
      options.abort ??
      ((message): void => {
        process.stderr.write(`${message}\n`);
        process.kill(process.pid, 'SIGINT');
      });
    this.log = options.log ?? ((m): void => console.warn(m));
  }

  /** Reporters that only write files must not claim the terminal. */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    const first = this.sample(this.port);
    this.recording = first !== null;
    if (!this.recording) {
      this.log(
        `[e2e-watchdog] no /proc on this platform — memory series disabled (liveness check still armed).`,
      );
    } else {
      this.lastSample = first;
      this.write({ kind: 'run-start', workers: config.workers, ...first });
      this.timer = setInterval(() => this.tick(), this.sampleIntervalMs);
      this.timer.unref?.();
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const current = this.recording ? (this.sample(this.port) ?? this.lastSample) : null;
    if (current) this.lastSample = current;
    const specFile = test.location.file.split('/').pop() ?? test.location.file;
    if (this.recording) {
      this.write({
        kind: 'test',
        spec: specFile,
        title: test.title,
        status: result.status,
        retry: result.retry,
        durationMs: result.duration,
        ...(current ?? {}),
      });
    }
    // Only the FIRST failure is worth probing: if the server is dead the run is
    // about to be aborted anyway, and if it is alive the retry is legitimate.
    const failed = result.status === 'failed' || result.status === 'timedOut';
    if (!failed || result.retry > 0 || this.aborted || !this.abortOnDeadServer) return;
    void this.checkServerAfterFailure(specFile, test.title);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recording) {
      this.write({ kind: 'run-end', status: result.status, ...(this.sample(this.port) ?? {}) });
    }
    await Promise.resolve();
  }

  private async checkServerAfterFailure(specFile: string, testTitle: string): Promise<void> {
    const verdict = await this.probe(this.probeUrl);
    if (verdict.alive || this.aborted) {
      if (this.recording) {
        this.write({
          kind: 'liveness',
          spec: specFile,
          alive: verdict.alive,
          detail: verdict.detail,
        });
      }
      return;
    }
    this.aborted = true;
    const message = degradedServerMessage({
      legId: this.legId,
      specFile,
      testTitle,
      detail: verdict.detail,
      sample: this.lastSample,
    });
    if (this.recording) {
      this.write({
        kind: 'harness-degraded',
        spec: specFile,
        title: testTitle,
        detail: verdict.detail,
      });
    }
    this.abort(message);
  }

  private tick(): void {
    const sample = this.sample(this.port);
    if (!sample) return;
    this.lastSample = sample;
    this.write({ kind: 'sample', ...sample });
  }

  private write(record: Record<string, unknown>): void {
    try {
      appendSeriesRecord(this.outputFile, { t: new Date(this.now()).toISOString(), ...record });
    } catch (error) {
      // The series is diagnostics: never let a full disk red a green shard.
      this.log(`[e2e-watchdog] could not write ${this.outputFile}: ${String(error)}`);
      this.recording = false;
    }
  }
}
