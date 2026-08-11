import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import {
  appendSeriesRecord,
  degradedServerMessage,
  findPidForInodes,
  parseListeningInodes,
  parseMemInfo,
  parseVmRssKb,
  probeServerAlive,
  sampleMemory,
} from './e2e/_helpers/harness-watchdog';
import HarnessWatchdogReporter from './e2e/_reporters/harness-watchdog';

// Guard for MOTIR-2617 — the E2E harness watchdog: the memory series a
// recurrence is diagnosed from, and the liveness check that ends a shard whose
// webServer has died instead of letting Playwright retry into a second 180s
// timeout against the same corpse.
//
// The liveness check is asserted against a REAL server that is really killed
// (SIGKILL on a child process), because the whole claim is about what happens
// when a process stops answering — a mocked `fetch` rejection would assert the
// mock, not the behaviour. The reporter's decision is then exercised separately
// with seams, since spawning Playwright to prove it aborts is not a unit test.

const tmp = (): string => mkdtempSync(join(tmpdir(), 'watchdog-'));

/** Start a real HTTP server in a child process; resolve its port and pid. */
async function startServer(): Promise<{ pid: number; port: number; kill: () => void }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const s=require("http").createServer((_q,r)=>r.end("ok"));' +
        's.listen(0,"127.0.0.1",()=>console.log(s.address().port));',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())));
    child.once('error', reject);
  });
  return { pid: child.pid as number, port, kill: () => child.kill('SIGKILL') };
}

const testCase = (file: string, title: string): TestCase =>
  ({ title, location: { file, line: 1, column: 1 } }) as TestCase;

const testResult = (over: Partial<TestResult>): TestResult =>
  ({ status: 'passed', retry: 0, duration: 1_000, ...over }) as TestResult;

const SAMPLE = {
  memTotalKb: 16_000_000,
  memAvailableKb: 400_000,
  memFreeKb: 100_000,
  serverPid: 42,
  serverRssKb: 6_500_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/proc parsing', () => {
  it('reads MemTotal / MemAvailable / MemFree out of meminfo', () => {
    const parsed = parseMemInfo(
      'MemTotal:       16382348 kB\nMemFree:          210848 kB\nMemAvailable:    1298432 kB\nBuffers: 1 kB\n',
    );
    expect(parsed).toEqual({
      memTotalKb: 16_382_348,
      memFreeKb: 210_848,
      memAvailableKb: 1_298_432,
    });
  });

  it('returns null for text that is not meminfo, rather than a machine with no memory', () => {
    expect(parseMemInfo('')).toBeNull();
    expect(parseMemInfo('Buffers:   4 kB\nCached:   8 kB\n')).toBeNull();
  });

  it('reads VmRSS out of a process status, and null when absent', () => {
    expect(parseVmRssKb('Name:\tnode\nVmPeak:\t 9 kB\nVmRSS:\t 6291456 kB\n')).toBe(6_291_456);
    expect(parseVmRssKb('Name:\tnode\n')).toBeNull();
  });

  describe('parseListeningInodes', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 x',
      '   1: 0100007F:0BB8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 9999 1 x',
      '   2: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 x',
    ].join('\n');

    it('takes the LISTENing socket on the port', () => {
      expect(parseListeningInodes(table, 3000)).toEqual(['4242']);
    });

    it('ignores an ESTABLISHED connection to the same port', () => {
      // State 01 on :0BB8 is a connection TO the server, not the server.
      expect(parseListeningInodes(table, 3000)).not.toContain('9999');
    });

    it('ignores a listener on another port, and survives a garbled table', () => {
      expect(parseListeningInodes(table, 8080)).toEqual(['7777']);
      expect(parseListeningInodes(table, 9999)).toEqual([]);
      expect(parseListeningInodes('sl local\nnonsense', 3000)).toEqual([]);
    });
  });

  describe('findPidForInodes', () => {
    it('finds the pid whose fd points at the socket inode', () => {
      const root = tmp();
      mkdirSync(join(root, '77/fd'), { recursive: true });
      mkdirSync(join(root, '88/fd'), { recursive: true });
      symlinkSync('socket:[4242]', join(root, '88/fd/12'));
      symlinkSync('/dev/null', join(root, '77/fd/3'));
      expect(findPidForInodes(['4242'], root)).toBe(88);
    });

    it('returns null when nothing owns the inode, or when /proc is unreadable', () => {
      const root = tmp();
      mkdirSync(join(root, '77/fd'), { recursive: true });
      expect(findPidForInodes(['4242'], root)).toBeNull();
      expect(findPidForInodes([], root)).toBeNull();
      expect(findPidForInodes(['4242'], join(root, 'nope'))).toBeNull();
    });
  });
});

describe('sampleMemory against this machine', () => {
  // The fixtures above prove the parsing; this proves the WIRING — that the
  // port -> socket inode -> /proc/<pid>/fd walk actually resolves a real
  // listener on a real kernel. Without it the CI series would silently carry
  // `serverPid: null` forever and the webServer's own footprint (the number the
  // whole card is about) would never be recorded.
  it.skipIf(!existsSync('/proc/meminfo'))(
    'resolves the pid and RSS of a live listener',
    async () => {
      const server = await startServer();
      try {
        const sample = sampleMemory(server.port);
        expect(sample).not.toBeNull();
        expect(sample?.memAvailableKb).toBeGreaterThan(0);
        expect(sample?.serverPid).toBe(server.pid);
        expect(sample?.serverRssKb).toBeGreaterThan(0);
      } finally {
        server.kill();
      }
    },
  );
});

describe('probeServerAlive against a real server', () => {
  it('reports a live server alive, then reports it dead once it is KILLED', async () => {
    const server = await startServer();
    const url = `http://127.0.0.1:${server.port}/`;

    const before = await probeServerAlive({ url, attempts: 2, timeoutMs: 2_000, delayMs: 10 });
    expect(before.alive, before.detail).toBe(true);
    expect(before.detail).toContain('200');

    server.kill();
    // Wait for the socket to actually go away — a SIGKILL is not instant.
    await vi.waitFor(
      async () => {
        const v = await probeServerAlive({ url, attempts: 1, timeoutMs: 1_000, delayMs: 10 });
        expect(v.alive).toBe(false);
      },
      { timeout: 5_000, interval: 100 },
    );

    const after = await probeServerAlive({ url, attempts: 2, timeoutMs: 1_000, delayMs: 10 });
    expect(after.alive).toBe(false);
    expect(after.detail).toContain(url);
    expect(after.detail).toContain('attempt 2/2');
  });

  it('treats a 500 as ALIVE — a product bug must fail as a test, not abort the shard', async () => {
    const get = vi.fn().mockResolvedValue({ status: 500 });
    const verdict = await probeServerAlive({ url: 'http://x/', get, attempts: 3 });
    expect(verdict.alive).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('retries a hanging probe up to `attempts` before calling it dead', async () => {
    const get = vi.fn().mockResolvedValue({ status: 0 });
    const verdict = await probeServerAlive({ url: 'http://x/', get, attempts: 3, delayMs: 1 });
    expect(verdict.alive).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('degradedServerMessage', () => {
  const message = degradedServerMessage({
    legId: 'bulk-4',
    specFile: 'project-square-flow.spec.ts',
    testTitle: 'the project square',
    detail: 'GET http://localhost:3000/sign-up -> no response within 5000ms (attempt 2/2)',
    sample: SAMPLE,
  });

  it('names the webServer, the leg and the spec that was merely holding the bag', () => {
    expect(message).toContain('THE WEBSERVER IS DEAD');
    expect(message).toContain('bulk-4');
    expect(message).toContain('project-square-flow.spec.ts');
    expect(message).toContain('NOT a regression in the code under test');
  });

  it('quotes the last memory sample, which is the cliff a triager wants', () => {
    expect(message).toContain('MemAvailable=391MB');
    expect(message).toContain('webServer RSS=6348MB (pid 42)');
  });

  it('omits the memory clause when nothing was sampled', () => {
    const bare = degradedServerMessage({
      legId: 'bulk-1',
      specFile: 'a.spec.ts',
      testTitle: 't',
      detail: 'd',
      sample: null,
    });
    expect(bare).not.toContain('MemAvailable');
    expect(bare).toContain('THE WEBSERVER IS DEAD');
  });
});

describe('appendSeriesRecord', () => {
  it('appends one JSON object per line, creating the directory', () => {
    const file = join(tmp(), 'nested/series.jsonl');
    appendSeriesRecord(file, { kind: 'sample', memAvailableKb: 1 });
    appendSeriesRecord(file, { kind: 'sample', memAvailableKb: 2 });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as { memAvailableKb: number })).toEqual([
      { kind: 'sample', memAvailableKb: 1 },
      { kind: 'sample', memAvailableKb: 2 },
    ]);
  });
});

describe('HarnessWatchdogReporter', () => {
  const build = (
    over: Partial<ConstructorParameters<typeof HarnessWatchdogReporter>[0]> = {},
  ): {
    reporter: HarnessWatchdogReporter;
    abort: ReturnType<typeof vi.fn>;
    probe: ReturnType<typeof vi.fn>;
    file: string;
  } => {
    const file = join(tmp(), 'harness.jsonl');
    const abort = vi.fn();
    const probe = vi.fn().mockResolvedValue({ alive: false, detail: 'no response' });
    const reporter = new HarnessWatchdogReporter({
      legId: 'bulk-4',
      outputFile: file,
      sample: () => SAMPLE,
      probe: probe as never,
      abort,
      log: () => {},
      ...over,
    });
    return { reporter, abort, probe, file };
  };

  const read = (file: string): Array<Record<string, unknown>> =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('records a run-start sample and one record per test', () => {
    const { reporter, file } = build();
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(testCase('/r/tests/e2e/board-ui.spec.ts', 'renders'), testResult({}));
    const records = read(file);
    expect(records[0]).toMatchObject({ kind: 'run-start', memAvailableKb: SAMPLE.memAvailableKb });
    expect(records[1]).toMatchObject({
      kind: 'test',
      spec: 'board-ui.spec.ts',
      title: 'renders',
      status: 'passed',
      durationMs: 1_000,
      serverRssKb: SAMPLE.serverRssKb,
    });
    expect(records.every((r) => typeof r['t'] === 'string')).toBe(true);
  });

  it('aborts with the named error when a test fails and the server is dead', async () => {
    const { reporter, abort, probe, file } = build();
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(
      testCase('/r/tests/e2e/project-square-flow.spec.ts', 'the project square'),
      testResult({ status: 'timedOut' }),
    );
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]?.[0]).toContain('THE WEBSERVER IS DEAD');
    expect(abort.mock.calls[0]?.[0]).toContain('bulk-4');
    expect(read(file).some((r) => r['kind'] === 'harness-degraded')).toBe(true);
  });

  it('does NOT abort when the server is still answering — that is a real failure', async () => {
    const probe = vi.fn().mockResolvedValue({ alive: true, detail: 'GET -> 200' });
    const { reporter, abort, file } = build({ probe: probe as never });
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(testCase('/r/tests/e2e/a.spec.ts', 't'), testResult({ status: 'failed' }));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(abort).not.toHaveBeenCalled();
    expect(read(file).some((r) => r['kind'] === 'liveness' && r['alive'] === true)).toBe(true);
  });

  it('does not probe on a pass, and never probes the RETRY of a failure', async () => {
    const { reporter, probe } = build();
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(testCase('/r/tests/e2e/a.spec.ts', 't'), testResult({ status: 'passed' }));
    reporter.onTestEnd(
      testCase('/r/tests/e2e/a.spec.ts', 't'),
      testResult({ status: 'failed', retry: 1 }),
    );
    await Promise.resolve();
    expect(probe).not.toHaveBeenCalled();
  });

  it('aborts at most once, however many later specs fail', async () => {
    const { reporter, abort } = build();
    reporter.onBegin({ workers: 1 } as never);
    for (const spec of ['a', 'b', 'c']) {
      reporter.onTestEnd(
        testCase(`/r/tests/e2e/${spec}.spec.ts`, 't'),
        testResult({ status: 'failed' }),
      );
    }
    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('records nothing but stays armed on a platform without /proc', async () => {
    const { reporter, abort, file } = build({ sample: () => null });
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(testCase('/r/tests/e2e/a.spec.ts', 't'), testResult({ status: 'failed' }));
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('records only, never aborts, when abortOnDeadServer is off', async () => {
    const { reporter, abort, probe } = build({ abortOnDeadServer: false });
    reporter.onBegin({ workers: 1 } as never);
    reporter.onTestEnd(testCase('/r/tests/e2e/a.spec.ts', 't'), testResult({ status: 'failed' }));
    await Promise.resolve();
    expect(probe).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps the shard green when the series cannot be written', () => {
    const dir = tmp();
    // A FILE where the series directory should be: every write now throws.
    writeFileSync(join(dir, 'blocked'), '');
    const { reporter } = build({ outputFile: join(dir, 'blocked/series.jsonl') });
    expect(() => reporter.onBegin({ workers: 1 } as never)).not.toThrow();
    expect(() =>
      reporter.onTestEnd(testCase('/r/tests/e2e/a.spec.ts', 't'), testResult({})),
    ).not.toThrow();
  });

  it('does not claim stdio — the list reporter owns the terminal', () => {
    expect(build().reporter.printsToStdio()).toBe(false);
  });
});
