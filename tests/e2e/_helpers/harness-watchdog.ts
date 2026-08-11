// E2E harness watchdog — the memory series + the dead-webServer check
// (MOTIR-2617).
//
// The failure this exists for: partway through a bulk shard the Playwright
// `webServer` (`next start`) crosses a memory/CPU cliff and stops answering, so
// the navigation that happens to be in flight hangs for the FULL 180 s test
// timeout. Playwright then retries that test — against the SAME dead server —
// and it hangs for another 180 s. The shard reds after ~6 minutes with a failure
// that looks deterministic (same spec, same line, twice) and is not: the second
// failure carries no independent information, because the harness died before
// either attempt started. Three occurrences on innocent diffs, ~30 minutes of
// triage each (PRs #1636 / #1912 / #2014).
//
// Two jobs, both aimed at the harness rather than at any spec:
//
//   1. RECORD. Sample `/proc/meminfo` plus the webServer's own RSS on a timer
//      and at every test boundary, into a JSONL series CI uploads with the leg's
//      artifacts. A recurrence then NAMES the cliff instead of needing the whole
//      diagnosis again.
//   2. FAIL FAST. When a test fails, re-probe the server. If it is not
//      answering, the run is over — say so in one named error and stop, rather
//      than spending a second 180 s timeout proving it again.
//
// `readiness.ts` is the sibling of this file: it gates the harness BEFORE the
// first spec (MOTIR-1565); this watches it DURING the shard. Same posture —
// dependency-free (node:fs + readiness's `httpGet`), so it can be unit-tested in
// isolation (tests/e2e-harness-watchdog.test.ts) and cannot drag app code into
// the reporter process.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { httpGet } from './readiness';

/** Where the `/proc` filesystem is rooted — overridable so tests can fixture it. */
export const PROC_ROOT = '/proc';

export interface MemInfo {
  memTotalKb: number;
  memAvailableKb: number;
  memFreeKb: number;
}

/**
 * Parse `/proc/meminfo`. Returns `null` when the text carries neither MemTotal
 * nor MemAvailable — i.e. it isn't meminfo — so a caller can degrade to "no
 * series" rather than record zeroes that read as a machine with no memory.
 */
export function parseMemInfo(text: string): MemInfo | null {
  const field = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m?.[1] ? Number(m[1]) : null;
  };
  const memTotalKb = field('MemTotal');
  const memAvailableKb = field('MemAvailable');
  if (memTotalKb === null && memAvailableKb === null) return null;
  return {
    memTotalKb: memTotalKb ?? 0,
    memAvailableKb: memAvailableKb ?? 0,
    memFreeKb: field('MemFree') ?? 0,
  };
}

/** Parse a process's resident set size (kB) out of `/proc/<pid>/status`. */
export function parseVmRssKb(statusText: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(statusText);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * The socket inodes LISTENING on `port`, read out of a `/proc/net/tcp[6]` table.
 *
 * The table's columns are `sl local_address rem_address st … inode`; the address
 * is `HEXIP:HEXPORT` and `st` is `0A` for LISTEN. Matching on the port alone
 * would also catch established connections TO that port from this machine, which
 * is why the state is checked too.
 */
export function parseListeningInodes(procNetTcpText: string, port: number): string[] {
  const wantPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes: string[] = [];
  for (const line of procNetTcpText.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [, local, , state] = cols;
    if (state !== '0A') continue;
    if (local?.split(':')[1]?.toUpperCase() !== wantPort) continue;
    const inode = cols[9];
    if (inode && inode !== '0') inodes.push(inode);
  }
  return inodes;
}

/**
 * Resolve the PID holding any of `inodes` by walking `/proc/<pid>/fd`. Returns
 * `null` when nothing owns them (a server in another PID namespace, or a
 * `/proc` we cannot read) — the caller then records the meminfo series alone
 * rather than failing, since system memory is the signal that matters most.
 */
export function findPidForInodes(inodes: readonly string[], procRoot = PROC_ROOT): number | null {
  if (inodes.length === 0) return null;
  const wanted = new Set(inodes.map((i) => `socket:[${i}]`));
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`${procRoot}/${pid}/fd`);
    } catch {
      continue; // a process we don't own, or one that exited mid-scan
    }
    for (const fd of fds) {
      try {
        if (wanted.has(readlinkSync(`${procRoot}/${pid}/fd/${fd}`))) return Number(pid);
      } catch {
        // the fd closed between readdir and readlink — keep scanning
      }
    }
  }
  return null;
}

/** The PID listening on `port`, or `null` when it cannot be resolved. */
export function findListeningPid(port: number, procRoot = PROC_ROOT): number | null {
  const inodes: string[] = [];
  for (const table of ['tcp', 'tcp6']) {
    try {
      inodes.push(...parseListeningInodes(readFileSync(`${procRoot}/net/${table}`, 'utf8'), port));
    } catch {
      // no such table on this kernel — try the other one
    }
  }
  return findPidForInodes(inodes, procRoot);
}

export interface MemorySample {
  memTotalKb: number;
  memAvailableKb: number;
  memFreeKb: number;
  /** The webServer's PID, or `null` when it could not be resolved. */
  serverPid: number | null;
  /** The webServer's resident set size in kB, or `null` when unresolved. */
  serverRssKb: number | null;
}

/**
 * One sample of the machine's memory plus the webServer's own footprint.
 * Returns `null` on a platform without `/proc` (macOS locally), which is the
 * signal the reporter uses to record nothing rather than a series of zeroes.
 */
export function sampleMemory(port: number, procRoot = PROC_ROOT): MemorySample | null {
  let mem: MemInfo | null = null;
  try {
    mem = parseMemInfo(readFileSync(`${procRoot}/meminfo`, 'utf8'));
  } catch {
    return null;
  }
  if (!mem) return null;
  const serverPid = findListeningPid(port, procRoot);
  let serverRssKb: number | null = null;
  if (serverPid !== null) {
    try {
      serverRssKb = parseVmRssKb(readFileSync(`${procRoot}/${serverPid}/status`, 'utf8'));
    } catch {
      serverRssKb = null;
    }
  }
  return { ...mem, serverPid, serverRssKb };
}

export interface AliveVerdict {
  alive: boolean;
  detail: string;
}

/**
 * Is the webServer still ANSWERING? Bounded, cheap, and deliberately narrow: any
 * HTTP response at all — including a 500 — counts as alive, because the failure
 * being guarded is a server that has stopped responding entirely. A product bug
 * that 500s must still fail as a normal test failure, not as a harness abort.
 */
export async function probeServerAlive(opts: {
  url: string;
  attempts?: number;
  timeoutMs?: number;
  delayMs?: number;
  get?: (url: string, timeoutMs: number) => Promise<{ status: number }>;
}): Promise<AliveVerdict> {
  const attempts = opts.attempts ?? 2;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const delayMs = opts.delayMs ?? 500;
  const get = opts.get ?? httpGet;
  let last = 'no attempt made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { status } = await get(opts.url, timeoutMs);
    if (status > 0) {
      return { alive: true, detail: `GET ${opts.url} -> ${status} (attempt ${attempt})` };
    }
    last = `GET ${opts.url} -> no response within ${timeoutMs}ms (attempt ${attempt}/${attempts})`;
    if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { alive: false, detail: last };
}

/**
 * The one error a degraded shard should print. It names the webServer as the
 * thing that died, the leg it died on, and the spec that was merely holding the
 * bag — the three facts a triager otherwise spends half an hour reconstructing.
 */
export function degradedServerMessage(input: {
  legId: string;
  specFile: string;
  testTitle: string;
  detail: string;
  sample?: MemorySample | null;
}): string {
  const mem = input.sample
    ? ` Last memory sample: MemAvailable=${Math.round(input.sample.memAvailableKb / 1024)}MB` +
      (input.sample.serverRssKb === null
        ? ''
        : `, webServer RSS=${Math.round(input.sample.serverRssKb / 1024)}MB (pid ${String(input.sample.serverPid)})`) +
      '.'
    : '';
  return (
    `[e2e-watchdog] THE WEBSERVER IS DEAD — aborting the ${input.legId} shard.\n` +
    `  ${input.detail}\n` +
    `  The failure reported against "${input.specFile} › ${input.testTitle}" is the harness dying, ` +
    `NOT a regression in the code under test: that spec was simply the one navigating when the ` +
    `server stopped answering.${mem}\n` +
    `  Aborting now instead of letting Playwright retry against the same dead server ` +
    `(the retry is what made this look deterministic — MOTIR-2617).\n` +
    `  The memory series for this shard is in the leg's out/e2e-harness artifact.`
  );
}

/** Append one JSON record as a line to `file`, creating its directory. */
export function appendSeriesRecord(file: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}
