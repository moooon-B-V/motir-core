import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// THE TWO-INSTANCE HARNESS (Story MOTIR-8547 · MOTIR-8616).
//
// Production runs two `app` machines on one Postgres, and Fly's proxy may send a
// request to one and its follow-up to the other. This harness reproduces that
// with no proxy and no stickiness: it starts TWO Node processes from one build
// on two ports against one `DATABASE_URL`, and the CLIENT picks the process —
// `sendTo('A' | 'B', …)` — so a test says exactly which machine served which
// request.
//
// ⚠️ THE PATTERN DELIBERATELY NOT FOLLOWED is a second instance mocked
// in-process. Two module graphs in one process can share a module-level `Map`
// through the module cache; two processes cannot. Only real processes can show
// the defect this lane exists to catch.
//
// ⚠️ A VACUOUS PASS IS THE FAILURE TO DESIGN AGAINST. Every case that crosses
// machines is worthless if both "machines" are one process, so each instance
// records the pid it spawned and the port that pid announced it listens on, and
// the smoke case asserts they differ (`harness.spec.ts`).
//
// Teardown: each child is spawned DETACHED, as the leader of its own process
// group, and stopped by signalling the GROUP — `next start` may fork, and a
// signal to the leader alone can leave a child holding the port. SIGTERM first,
// SIGKILL after a grace period, and the process `exit` hook kills whatever is
// left even if the run dies without reaching teardown.

export type InstanceName = 'A' | 'B';

export interface Instance {
  readonly name: InstanceName;
  readonly port: number;
  readonly origin: string;
  /** The pid the harness spawned — the process-group leader. */
  readonly pid: number;
  /** The port the process announced on stdout, read back, not assumed. */
  announcedPort: number | null;
  readonly child: ChildProcess;
  /** The process's combined output, for a failure message. */
  readonly log: string[];
}

export interface InstancePair {
  readonly A: Instance;
  readonly B: Instance;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The command and arguments that start ONE instance; `{port}` is substituted. */
  readonly command: readonly string[];
  /** The env BOTH instances share — one `DATABASE_URL`, one secret. */
  readonly env: NodeJS.ProcessEnv;
  /** The path that answers once an instance can serve. */
  readonly readyPath: string;
  /** How long one instance may take to answer `readyPath`. */
  readonly readyTimeoutMs?: number;
  /** A line on stdout that carries the port the process bound, as group 1. */
  readonly announcePattern?: RegExp;
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of live) killGroup(child, 'SIGKILL');
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** A free TCP port, from the OS. */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Whether something accepts a TCP connection on `port`. */
export async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolveUse) => {
    const server = createServer();
    server.once('error', () => resolveUse(true));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveUse(false)));
  });
}

async function waitReady(instance: Instance, path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(
        `instance ${instance.name} exited (${instance.child.exitCode ?? instance.child.signalCode}) ` +
          `before it was ready:\n${instance.log.join('').slice(-4000)}`,
      );
    }
    try {
      const res = await fetch(instance.origin + path, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `instance ${instance.name} was not ready on ${path} within ${timeoutMs} ms (${last}):\n` +
      instance.log.join('').slice(-4000),
  );
}

function spawnInstance(name: InstanceName, port: number, options: StartOptions): Instance {
  const [cmd, ...args] = options.command.map((part) => part.replaceAll('{port}', String(port)));
  if (!cmd) throw new Error('empty command');
  const child = spawn(cmd, args, {
    cwd: resolve(__dirname, '../..'),
    env: { ...options.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) throw new Error(`instance ${name} did not spawn`);
  live.add(child);
  child.on('exit', () => live.delete(child));

  const instance: Instance = {
    name,
    port,
    origin: `http://127.0.0.1:${port}`,
    pid: child.pid,
    announcedPort: null,
    child,
    log: [],
  };
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    instance.log.push(text);
    if (instance.log.length > 400) instance.log.shift();
    const match = options.announcePattern?.exec(text);
    if (match?.[1]) instance.announcedPort = Number(match[1]);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return instance;
}

async function stopInstance(instance: Instance, graceMs = 10_000): Promise<void> {
  const { child } = instance;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  killGroup(child, 'SIGTERM');
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}

/**
 * Start A and B from one command on two free ports, against the same env, and
 * wait until both answer. Stops BOTH if either fails to come up.
 */
export async function startInstances(options: StartOptions): Promise<InstancePair> {
  installExitHook();
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();

  const A = spawnInstance('A', portA, options);
  const B = spawnInstance('B', portB, options);
  const pair: InstancePair = {
    A,
    B,
    async stop() {
      await Promise.all([stopInstance(A), stopInstance(B)]);
    },
  };
  try {
    const timeout = options.readyTimeoutMs ?? 120_000;
    await Promise.all([
      waitReady(A, options.readyPath, timeout),
      waitReady(B, options.readyPath, timeout),
    ]);
  } catch (err) {
    await pair.stop();
    throw err;
  }
  return pair;
}

/** Where a pair's instances can be reached — what a test needs, serialisable. */
export interface PairAddress {
  readonly A: { origin: string; pid: number; port: number; announcedPort: number | null };
  readonly B: { origin: string; pid: number; port: number; announcedPort: number | null };
}

export function addressOf(pair: InstancePair): PairAddress {
  const one = (i: Instance) => ({
    origin: i.origin,
    pid: i.pid,
    port: i.port,
    announcedPort: i.announcedPort,
  });
  return { A: one(pair.A), B: one(pair.B) };
}

/** A client bound to one pair: the CALLER chooses the machine for every request. */
export interface TwoInstanceClient {
  sendTo(name: InstanceName, path: string, init?: RequestInit): Promise<Response>;
  /** Request N goes to A, request N+1 to B, alternating, starting from `first`. */
  alternate(
    requests: ReadonlyArray<{ path: string; init?: RequestInit }>,
    first?: InstanceName,
  ): Promise<Array<{ served: InstanceName; response: Response }>>;
}

export function clientFor(address: PairAddress): TwoInstanceClient {
  const sendTo = (name: InstanceName, path: string, init?: RequestInit) =>
    fetch(address[name].origin + path, { redirect: 'manual', ...init });
  return {
    sendTo,
    async alternate(requests, first = 'A') {
      const out: Array<{ served: InstanceName; response: Response }> = [];
      for (const [i, request] of requests.entries()) {
        const served: InstanceName = (i % 2 === 0) === (first === 'A') ? 'A' : 'B';
        out.push({ served, response: await sendTo(served, request.path, request.init) });
      }
      return out;
    },
  };
}
