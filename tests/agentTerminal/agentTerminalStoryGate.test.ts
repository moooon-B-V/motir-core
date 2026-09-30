import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { format } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import '@/lib/jobs/definitions/agentInstanceIdleCheck';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceActivityService } from '@/lib/services/agentInstanceActivityService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentTerminalRelayService as relayService } from '@/lib/services/agentTerminalRelayService';
import { agentTerminalService } from '@/lib/services/agentTerminalService';
import { adminDb } from '../helpers/adminDb';
import { ensureCliBuilt } from '../helpers/cliHarness';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import {
  MIN,
  clock,
  fleet,
  fx,
  setUpHarness,
  stub,
  tearDownHarness,
} from '../agentInstances/_harness';

// THE AGENT-TERMINAL STORY GATE, motir-core (Story MOTIR-6861 · MOTIR-6942,
// `docs/decisions/agent-terminal.md`).
//
// Each build card tested its own piece: the terminal server against a fake PTY
// (MOTIR-6938), the relay against a fake terminal server (MOTIR-6940), the panel
// against a fake socket (MOTIR-6941). This file tests the ASSEMBLED path:
//
//   the real ticket ROUTE → the real RELAY (in-process, wired exactly as
//   `scripts/relay.ts` wires it: the real services, the real activity door) →
//   the fake fleet's `terminalEndpoint` → the REAL `motir agent-terminal serve`,
//   spawned from the built CLI as a separate process, with the machine env the
//   lifecycle gives it (the derived key, the instance id, the machine id) →
//   a shell.
//
// THE PTY. node-pty is compiled into the agent image only (Q4) and is not built
// in CI. So the server process loads it from MOTIR_TERMINAL_MODULE_DIR when that
// names a built node-pty (the image, or a local build) — then this suite drives a
// REAL PTY and a real `bash -l` — and otherwise from a temp dir holding
// `fixtures/fake-node-pty.cjs`: a real `bash` over pipes with a shimmed `stty`.
// Either way it is the real server process, its real token check, its real
// session table and its real sign-in stat that are under test.
//
// Every guard carries a negative control, so a guard that could never fail cannot
// pass: the no-logging guard is shown to catch the marker in each encoding a
// `console.log(payload)` would print it in, and the architecture guards are shown
// to catch the imports and reads they forbid.

// ── Mocks (the session only, as the repo's rule allows) ─────────────────────

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const ticketRoute = await import('@/app/api/projects/[key]/instances/[id]/terminal-ticket/route');
const wakeRoute = await import('@/app/api/projects/[key]/instances/[id]/wake/route');

const MASTER = 'story-gate-6942-master-key-'.padEnd(48, 'k');
const ORIGIN = 'https://motir.test';
const MARKER = 'MARKER-6942-never-in-a-log-c41b';
const REPO = resolve(__dirname, '..', '..');

// ── The PTY the server process loads ────────────────────────────────────────

const REAL_PTY_DIR = process.env['MOTIR_TERMINAL_MODULE_DIR']?.trim() || '/opt/motir-terminal';
const REAL_PTY = existsSync(join(REAL_PTY_DIR, 'node_modules', 'node-pty'));
let ptyDir: string;
let cliEntry: string;

beforeAll(() => {
  cliEntry = ensureCliBuilt();
  if (REAL_PTY) {
    ptyDir = REAL_PTY_DIR;
  } else {
    ptyDir = mkdtempSync(join(tmpdir(), 'motir-gate-pty-'));
    const mod = join(ptyDir, 'node_modules', 'node-pty');
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(ptyDir, 'package.json'), '{"private":true}\n');
    writeFileSync(join(mod, 'package.json'), '{"name":"node-pty","main":"index.js"}\n');
    copyFileSync(join(__dirname, 'fixtures', 'fake-node-pty.cjs'), join(mod, 'index.js'));
  }
}, 180_000);

afterAll(async () => {
  if (!REAL_PTY) rmSync(ptyDir, { recursive: true, force: true });
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The real terminal server, as a process ──────────────────────────────────

interface ServerProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  home: string;
  /** Everything the process wrote to stdout and stderr (Fly ships both). */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

async function startServer(instanceId: string): Promise<ServerProcess> {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const home = mkdtempSync(join(tmpdir(), 'motir-gate-home-'));
  mkdirSync(join(home, 'workspace'));
  // The image's login-shell hook runs a one-time agent-config setup for a fresh
  // HOME; its own sentinel says "done" for this throwaway one (as realPty.test.ts).
  mkdirSync(join(home, '.motir-sandbox', 'agent-config'), { recursive: true });
  writeFileSync(join(home, '.motir-sandbox', 'agent-config', '.setup-done'), '');
  const port = await freePort();
  const chunks: Buffer[] = [];
  const child = spawn(
    process.execPath,
    [cliEntry, 'agent-terminal', 'serve', '--port', `${port}`],
    {
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_ENV: 'production',
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: home,
        // What the machine config sets (MOTIR-6939) and Fly adds.
        MOTIR_TERMINAL_KEY: deriveTerminalKey(MASTER, instanceId),
        MOTIR_INSTANCE_ID: instanceId,
        FLY_MACHINE_ID: row.machineId!,
        // What the image and its entrypoint set (Context 7).
        MOTIR_SANDBOX_AGENT: 'claude',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        MOTIR_TERMINAL_MODULE_DIR: ptyDir,
      },
    },
  );
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  child.stderr.on('data', (c: Buffer) => chunks.push(c));
  const output = () => Buffer.concat(chunks).toString('utf8');
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  await until(() => output().includes(`listening on`) || child.exitCode !== null, 20_000);
  if (child.exitCode !== null) throw new Error(`the terminal server exited: ${output()}`);
  fleet.setTerminalAddress(`ws://127.0.0.1:${port}`);
  const server: ServerProcess = {
    child,
    port,
    home,
    output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
  servers.push(server);
  return server;
}

// ── The relay, wired as `scripts/relay.ts` wires it ─────────────────────────

/** This relay's id on its connection rows — `relayMachineId()` in `scripts/relay.ts`. */
const RELAY_MACHINE_ID = 'relay-story-gate';
let relay: TerminalRelay;
let relayUrl: string;
const relayLogs: string[] = [];
const reported: Error[] = [];
const consoleLines: string[] = [];
const servers: ServerProcess[] = [];
let failTouch = false;

async function startRelay(): Promise<void> {
  relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: (ticket) => relayService.authorizeConnection(ticket),
    openConnection: (input) =>
      relayService.openConnection({ ...input, relayMachineId: RELAY_MACHINE_ID }),
    closeConnection: (input) => relayService.closeConnection(input),
    touchActivity: async (instanceId) => {
      if (failTouch) throw new Error(`touch failed while carrying ${MARKER}`);
      await agentInstanceActivityService.touchActivity(instanceId);
    },
    heartbeat: async (connections) => {
      await relayService.heartbeatConnections({ relayMachineId: RELAY_MACHINE_ID, connections });
    },
    log: (line) => relayLogs.push(line),
    // The error-reporter stub: what `scripts/relay.ts` hands Sentry.
    reportError: (err) => reported.push(err),
    now: () => clock.now().getTime(),
    authTimeoutMs: 1_000,
  });
  await new Promise<void>((ok) => relay.server.listen(0, '127.0.0.1', ok));
  relayUrl = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/terminal`;
}

/** What a failing wait prints: ids and lifecycle lines only, like the sinks themselves. */
function diagnostics(): string {
  return JSON.stringify({ relay: relayLogs, servers: servers.map((s) => s.output()) });
}

/** Every console line in THIS process (the relay's and the route's), as console would print it. */
function captureConsole(): void {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(format(...args));
      // A Buffer or Error argument, decoded too — `String(buffer)` is its UTF-8.
      consoleLines.push(
        args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '),
      );
    });
  }
}

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.stubEnv('MOTIR_RELAY_URL', '');
  // The ticket and relay-token clock stays REAL: the relay token crosses a process
  // boundary, and the terminal server checks its `exp` against its own wall clock.
  // The activity path (the lifecycle's clock, the relay's throttle) runs virtual.
  relayLogs.length = 0;
  reported.length = 0;
  consoleLines.length = 0;
  failTouch = false;
  captureConsole();
  await actAs(fx.ownerId);
  await startRelay();
});

afterEach(async () => {
  await relay.close();
  for (const s of servers.splice(0)) await s.stop();
  fleet.setTerminalAddress(null);
  await tearDownHarness();
});

// ── Browser helpers ─────────────────────────────────────────────────────────

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

async function until(done: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const params = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
const postTicket = (id: string) =>
  ticketRoute.POST(
    new Request(
      `http://test/api/projects/${fx.projectIdentifier}/instances/${id}/terminal-ticket`,
      {
        method: 'POST',
      },
    ),
    params(id),
  );
const postWake = (id: string) =>
  wakeRoute.POST(
    new Request(`http://test/api/projects/${fx.projectIdentifier}/instances/${id}/wake`, {
      method: 'POST',
    }),
    params(id),
  );

/** The ticket, as the panel gets it: through the real route. */
async function ticketFor(id: string): Promise<string> {
  const res = await postTicket(id);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

interface Browser {
  ws: WebSocket;
  inbox: { isBinary: boolean; data: Buffer }[];
  closed: Promise<number>;
  texts(): Record<string, unknown>[];
  output(): string;
  frame(t: string, index?: number): Promise<Record<string, unknown>>;
}

async function browser(): Promise<Browser> {
  const ws = new WebSocket(relayUrl, { origin: ORIGIN });
  const b: Browser = {
    ws,
    inbox: [],
    closed: new Promise((ok) => ws.on('close', (code) => ok(code))),
    texts: () =>
      b.inbox
        .filter((m) => !m.isBinary)
        .map((m) => JSON.parse(m.data.toString('utf8')) as Record<string, unknown>),
    output: () =>
      Buffer.concat(b.inbox.filter((m) => m.isBinary).map((m) => m.data)).toString('utf8'),
    async frame(t, index = 0) {
      let found: Record<string, unknown> | undefined;
      await until(() => {
        found = b.texts().filter((f) => f['t'] === t)[index];
        return found !== undefined;
      }).catch(() => {
        throw new Error(`no "${t}" frame; ${diagnostics()}`);
      });
      return found!;
    },
  };
  ws.on('message', (data, isBinary) =>
    b.inbox.push({ isBinary, data: Buffer.from(data as Buffer) }),
  );
  await new Promise<void>((ok, fail) => {
    ws.once('open', () => ok());
    ws.once('error', fail);
  });
  return b;
}

/** Authenticate with a ticket and send `open`; resolves once `ready` arrives. */
async function openTerminal(ticket: string, session?: string): Promise<Browser> {
  const b = await browser();
  b.ws.send(JSON.stringify({ t: 'auth', ticket }));
  b.ws.send(JSON.stringify({ t: 'open', cols: 80, rows: 24, ...(session ? { session } : {}) }));
  await b.frame('ready');
  return b;
}

let seq = 0;
/** Type a command and wait for its unique end marker (`END-n-2` — the echo shows `$((1+1))`). */
async function run(b: Browser, command: string): Promise<string> {
  seq += 1;
  const before = b.output().length;
  b.ws.send(Buffer.from(`${command}; echo END-${seq}-$((1+1))\r`), { binary: true });
  await until(() => b.output().slice(before).includes(`END-${seq}-2`), 20_000).catch(() => {
    throw new Error(
      `no output for ${command}: ${JSON.stringify(b.output().slice(-400))}; ${diagnostics()}`,
    );
  });
  return b.output().slice(before);
}

const runningAgent = async (name = 'yue-claude') => {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  expect(dto.terminalServer).toBe('present');
  return dto.id;
};

const connections = () =>
  adminDb.agentTerminalConnection.findMany({ orderBy: { openedAt: 'asc' } });
const instanceRow = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const idleTimer = (id: string) =>
  adminDb.jobQueueRun.findFirst({
    where: { jobId: 'agent-instance/idle-check', debounceKey: id, state: 'pending' },
  });

// ── 1 · The seam ────────────────────────────────────────────────────────────

describe(`1 · the seam: route → relay → the real terminal server (${REAL_PTY ? 'real node-pty' : 'stand-in PTY'})`, () => {
  it('a typed command returns its output, a resize changes `stty size`, and a dropped socket re-opened finds the same shell', async () => {
    const id = await runningAgent();
    const server = await startServer(id);

    const b = await openTerminal(await ticketFor(id));
    const ready = await b.frame('ready');
    expect(ready).toMatchObject({ t: 'ready', resumed: false });
    const sessionId = ready['session'] as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // A command typed returns its output — from a shell in $HOME/workspace, without the key.
    const facts = await run(b, 'echo HELLO-$((6*7)); pwd; echo KEY=${MOTIR_TERMINAL_KEY:-absent}');
    expect(facts).toContain('HELLO-42');
    expect(facts).toContain(join(server.home, 'workspace'));
    expect(facts).toContain('KEY=absent');

    // A resize changes `stty size` (rows cols).
    b.ws.send(JSON.stringify({ t: 'resize', cols: 101, rows: 33 }));
    await until(async () => (await run(b, 'stty size')).includes('33 101'));

    // State the shell keeps, then the socket drops.
    await run(b, 'export KEPT=still-here-6942');
    const pid = /PID=(\d+)/.exec(await run(b, 'echo PID=$$'))![1];
    b.ws.terminate();
    await until(async () => (await connections())[0]?.closedAt != null);

    // Re-opened inside the window, with a NEW ticket and the session id: the same shell.
    const again = await openTerminal(await ticketFor(id), sessionId);
    expect(await again.frame('ready')).toEqual({ t: 'ready', session: sessionId, resumed: true });
    expect(await run(again, 'echo VAR=$KEPT')).toContain('VAR=still-here-6942');
    expect(await run(again, 'echo PID=$$')).toContain(`PID=${pid}`);

    // Two connections, two rows; the first closed by the browser, the second still open.
    const rows = await connections();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      closeReason: 'browser_closed',
    });
    expect(rows[1]).toMatchObject({ closedAt: null });

    // The shell exits: the relay passes it through and records it.
    again.ws.send(Buffer.from('exit\r'), { binary: true });
    expect(await again.frame('exit')).toMatchObject({ t: 'exit', code: 0 });
    expect(await again.closed).toBe(1000);
    await until(async () => (await connections())[1]?.closedAt != null);
    expect((await connections())[1]).toMatchObject({ closeReason: 'terminal_closed' });
  }, 90_000);
});

// ── 2 · Owner-only, against the real database ───────────────────────────────

describe('2 · owner-only, against the real database', () => {
  it('a manager of the same project gets no ticket and no socket; a forged or replayed ticket is refused by the relay', async () => {
    const id = await runningAgent();
    const server = await startServer(id);

    // Another member of the same workspace, with a manager role.
    const manager = await adminDb.user.create({
      data: { name: 'Manager', email: `mgr-${Date.now()}-${Math.random()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: manager.id, workspaceRole: 'member' },
    });
    await setWorkspaceRoleFor(manager.id, fx.workspaceId, 'admin');
    await actAs(manager.id);
    const refused = await postTicket(id);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'not_owner' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);

    // No socket either: without a ticket of their own, anything they present is forged.
    const forged = await browser();
    forged.ws.send(JSON.stringify({ t: 'auth', ticket: 'A'.repeat(43) }));
    expect(await forged.closed).toBe(TERMINAL_CLOSE.badTicket);

    // The owner's ticket works ONCE; its replay is refused.
    await actAs(fx.ownerId);
    const ticket = await ticketFor(id);
    const first = await openTerminal(ticket);
    expect(await run(first, 'echo OWNER-$((2+3))')).toContain('OWNER-5');
    const replay = await browser();
    replay.ws.send(JSON.stringify({ t: 'auth', ticket }));
    expect(await replay.closed).toBe(TERMINAL_CLOSE.badTicket);

    // Only the owner's one connection was ever recorded or reached the machine.
    expect(await connections()).toHaveLength(1);
    expect((await connections())[0]).toMatchObject({ userId: fx.ownerId });
    expect(server.output().match(/connection opened/g)).toHaveLength(1);
    first.ws.close();
  }, 60_000);

  it('an unexpected failure behind the route is not dressed up as a refusal — it propagates', async () => {
    const id = await runningAgent();
    vi.spyOn(agentTerminalService, 'issueTicket').mockRejectedValueOnce(new Error('boom'));
    await expect(postTicket(id)).rejects.toThrow('boom');
  });
});

// ── 3 · Wake on open ────────────────────────────────────────────────────────

describe('3 · wake on open', () => {
  it('a hibernated agent opened through the route goes waking → running via the lifecycle, then connects', async () => {
    const id = await runningAgent();
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    expect((await instanceRow(id)).state).toBe('hibernated');
    // The ticket route never wakes (Q6): not_running first.
    const early = await postTicket(id);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'not_running' });

    const transitions = vi.spyOn(agentInstanceRepository, 'transition');
    const woke = await postWake(id);
    expect(woke.status).toBe(200);
    expect(((await woke.json()) as { instance: { state: string } }).instance.state).toBe('running');
    const states = transitions.mock.calls.map((call) => call[2]);
    expect(states.indexOf('waking')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('running')).toBeGreaterThan(states.indexOf('waking'));

    await startServer(id);
    const b = await openTerminal(await ticketFor(id));
    expect(await run(b, 'echo AWAKE-$((1+2))')).toContain('AWAKE-3');
    b.ws.close();
  }, 60_000);

  it('a credit-refused wake connects nothing', async () => {
    const id = await runningAgent();
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    // A late bump (a close the relay records after the stop) moves the signal but
    // arms no idle timer for an agent that is not running.
    const timerBefore = await idleTimer(id);
    await agentInstanceActivityService.touchActivity(id);
    expect((await idleTimer(id))?.eventId).toBe(timerBefore?.eventId);

    stub.mayRun = false;
    const woke = await postWake(id);
    expect(woke.status).toBeGreaterThanOrEqual(400);
    expect((await instanceRow(id)).state).toBe('hibernated');

    const res = await postTicket(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_running' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
    expect(await connections()).toEqual([]);
  });
});

// ── 4 · Activity ────────────────────────────────────────────────────────────

describe('4 · activity', () => {
  it('a live session keeps lastActivityAt moving and re-arms the idle timer; after close the idle check hibernates at the window', async () => {
    const id = await runningAgent();
    await startServer(id);
    const armedAtCreate = (await idleTimer(id))!.eventId;
    clock.advance(MIN);
    const b = await openTerminal(await ticketFor(id));
    // The open bumped it, and re-armed the timer the create armed.
    await until(async () => (await idleTimer(id))!.eventId !== armedAtCreate);
    expect((await instanceRow(id)).lastActivityAt!.getTime()).toBe(clock.now().getTime());

    // Twenty minutes of a live terminal, a keystroke a minute and more: it moves every time.
    let armedBy = (await idleTimer(id))!.eventId;
    for (let minute = 1; minute <= 20; minute += 1) {
      clock.advance(MIN + 1_000);
      await run(b, `echo tick-${minute}`);
      await until(
        async () => (await instanceRow(id)).lastActivityAt!.getTime() === clock.now().getTime(),
      );
      // Re-armed: the debounce took a new event.
      await until(async () => (await idleTimer(id))!.eventId !== armedBy);
      armedBy = (await idleTimer(id))!.eventId;
    }
    expect(
      await adminDb.jobQueueRun.count({
        where: { jobId: 'agent-instance/idle-check', debounceKey: id, state: 'pending' },
      }),
    ).toBe(1);

    // After close, the idle check — the real job handler — waits out the window.
    clock.advance(MIN + 1_000);
    b.ws.close();
    await until(async () => (await connections())[0]?.closedAt != null);
    await until(
      async () => (await instanceRow(id)).lastActivityAt!.getTime() === clock.now().getTime(),
    );
    const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
    const idleCheck = () =>
      engineJob('agent-instance/idle-check')!.handler(
        { step, event: { data: { workspaceId: fx.workspaceId, instanceId: id } } } as never,
        jobServices as never,
      );
    clock.advance(29 * MIN);
    expect(await idleCheck()).toBe('active');
    clock.advance(2 * MIN);
    expect(await idleCheck()).toBe('idle');
    await lifecycle.settleStop(id, 'idle');
    expect((await instanceRow(id)).state).toBe('hibernated');
  }, 120_000);
});

// ── 5 · Sign-in status ──────────────────────────────────────────────────────

describe('5 · sign-in status', () => {
  it('reads not signed in, then signed in once the credential file exists — without reading it', async () => {
    const id = await runningAgent();
    const server = await startServer(id);
    const b = await openTerminal(await ticketFor(id));
    expect(await b.frame('signin')).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_out',
    });

    // The vendor's flow writes the credential. Mode 000: a server that OPENED it
    // would fail; the stat the decision allows still sees a non-empty regular file.
    const dir = join(server.home, '.claude');
    mkdirSync(dir, { recursive: true });
    const credential = join(dir, '.credentials.json');
    writeFileSync(credential, `{"secret":"${MARKER}"}`);
    chmodSync(credential, 0o000);
    const signedIn = await (async () => {
      await until(() => b.texts().filter((f) => f['t'] === 'signin').length >= 2, 15_000);
      return b.texts().filter((f) => f['t'] === 'signin')[1];
    })();
    // The frame is the state only: no path, no size, no time, no content.
    expect(signedIn).toEqual({ t: 'signin', profile: 'claude', state: 'signed_in' });
    expect(JSON.stringify(b.texts())).not.toContain(MARKER);
    expect(server.output()).not.toContain(MARKER);
    expect(server.output()).not.toContain('.credentials');
    chmodSync(credential, 0o600);
    b.ws.close();
  }, 60_000);
});

// ── 6 · The no-logging guard ────────────────────────────────────────────────

/** Every way a sink could hold the marker: as text, and as `console.log(buffer)` prints bytes. */
function leaks(sink: string, marker: string): boolean {
  const bytes = Buffer.from(marker, 'utf8');
  const hexSpaced = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return sink.includes(marker) || sink.includes(hexSpaced) || sink.includes(bytes.toString('hex'));
}

describe('6 · the no-logging guard', () => {
  it('the guard sees the marker in every form a logged payload would take (negative control)', () => {
    const frame = Buffer.from(`echo ${MARKER}\r`);
    expect(leaks(format(frame), MARKER)).toBe(true); // console.log(buffer): <Buffer 65 63 …>
    expect(leaks(String(frame), MARKER)).toBe(true);
    expect(leaks(frame.toString('hex'), MARKER)).toBe(true);
    expect(leaks(format(JSON.stringify({ t: 'resize', note: MARKER })), MARKER)).toBe(true);
    expect(leaks('relay: connection 1a2b opened instance=x user=y', MARKER)).toBe(false);
  });

  it('a session carrying the marker, with a forced mid-stream error, leaves it in no log and no report', async () => {
    const id = await runningAgent();
    const server = await startServer(id);
    const ticket = await ticketFor(id);
    const b = await openTerminal(ticket);

    // The marker both ways: typed in, printed back, and in a control frame.
    expect(await run(b, `echo ${MARKER}`)).toContain(MARKER);
    b.ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30, note: MARKER }));
    b.ws.send(JSON.stringify({ t: 'ping', active: true, note: MARKER }));

    // Forced errors mid-stream: every activity bump now throws with the marker in
    // its message, then the machine dies under the open connection.
    failTouch = true;
    clock.advance(MIN + 1_000);
    expect(await run(b, `echo again-${MARKER}`)).toContain(`again-${MARKER}`);
    await until(() => reported.length > 0);
    server.child.kill('SIGKILL');
    expect(await b.closed).toBe(TERMINAL_CLOSE.unreachable);
    await until(async () => (await connections())[0]?.closedAt != null);
    expect((await connections())[0]).toMatchObject({ closeReason: 'unreachable', closeCode: 4502 });

    // Each sink was live — it wrote lines — and none holds the marker, the ticket or a token.
    const sinks = {
      relay: relayLogs.join('\n'),
      server: server.output(),
      console: consoleLines.join('\n'),
      reporter: reported.map((e) => `${e.name}: ${e.message}\n${e.stack ?? ''}`).join('\n'),
    };
    expect(sinks.relay).toContain(`opened instance=${id}`);
    expect(sinks.server).toContain('connection opened');
    expect(sinks.reporter).toContain('relay: touchActivity failed (Error)');
    for (const [name, text] of Object.entries(sinks)) {
      expect({ name, leaks: leaks(text, MARKER) }).toEqual({ name, leaks: false });
      expect({ name, leaks: leaks(text, ticket) }).toEqual({ name, leaks: false });
    }
    // And the database holds nothing that flowed.
    expect(JSON.stringify(await connections())).not.toContain(MARKER);
  }, 60_000);
});

// ── 7 · Architecture guards ─────────────────────────────────────────────────

/** Code only — a comment that names a thing is not a use of it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
function specifiers(code: string): string[] {
  return [...code.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
}

/** The files under app/ and lib/ importing packages/cli/**. */
function cliCrossings(files: Array<{ file: string; code: string }>): string[] {
  return files
    .filter(({ code }) =>
      specifiers(code).some(
        (s) => /(^|\/)packages\/cli(\/|$)/.test(s) || s.startsWith('@motir/cli'),
      ),
    )
    .map(({ file }) => file);
}

const FLY_INSTANCES_READ =
  /\b(?:process\.env|env)\s*(?:\.\s*FLY_INSTANCES_|\[\s*['"`]FLY_INSTANCES_)|\{[^}]*\bFLY_INSTANCES_[A-Z_]*\b[^}]*\}\s*=\s*(?:process\.)?env\b/;

/** The relay's own import graph, from its entrypoint, over this repository's sources. */
function relayGraph(): string[] {
  const seen = new Set<string>();
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join(REPO, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return null; // a package — not a relay module
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiers(stripComments(readFileSync(file, 'utf8')))) {
      const next = resolveSpec(file, spec);
      if (next && /\.tsx?$/.test(next)) visit(next);
    }
  };
  visit(join(REPO, 'scripts', 'relay.ts'));
  return [...seen].map((f) => relative(REPO, f));
}

describe('7 · architecture guards', () => {
  it('no module under app/ or lib/ imports packages/cli/** beyond the two lib/apiDocs modules the catalog permits', () => {
    const files = [...walk(join(REPO, 'app')), ...walk(join(REPO, 'lib'))].map((f) => ({
      file: relative(REPO, f),
      code: stripComments(readFileSync(f, 'utf8')),
    }));
    expect(files.length).toBeGreaterThan(500);
    expect(cliCrossings(files).sort()).toEqual(['lib/apiDocs/cli.ts', 'lib/apiDocs/sandbox.ts']);
    // Negative control: each spelling of a crossing is caught; a comment is not one.
    expect(
      cliCrossings([
        {
          file: 'a.ts',
          code: "import { x } from '../../packages/cli/src/agentTerminal/relayToken';",
        },
        { file: 'b.ts', code: "const m = await import('@motir/cli/package.json');" },
        { file: 'c.ts', code: "export * from '../packages/cli';" },
        { file: 'd.ts', code: stripComments("// cannot import '../../packages/cli/src/x'") },
        { file: 'e.ts', code: "import { y } from '@/lib/apiDocs/cli';" },
      ]),
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('no relay module reads FLY_INSTANCES_* directly — the relay holds no Fly token (Q1)', () => {
    const graph = relayGraph();
    // The graph is the relay's real one: its transport, its services, the orchestrator seam.
    for (const expected of [
      'lib/agentTerminal/relay/terminalRelay.ts',
      'lib/services/agentTerminalRelayService.ts',
      'lib/services/agentInstanceActivityService.ts',
      'lib/orchestrator/index.ts',
    ]) {
      expect(graph).toContain(expected);
    }
    const offenders = graph.filter((f) =>
      FLY_INSTANCES_READ.test(stripComments(readFileSync(join(REPO, f), 'utf8'))),
    );
    expect(offenders).toEqual([]);
    // Negative control: a read in any spelling is caught; a word in a message is not.
    const reads = [
      "const t = process.env['FLY_INSTANCES_API_TOKEN'];",
      'const t = process.env.FLY_INSTANCES_ORG;',
      'const { FLY_INSTANCES_API_TOKEN } = process.env;',
      "const t = env['FLY_INSTANCES_API_TOKEN'];",
    ];
    for (const code of reads) expect(FLY_INSTANCES_READ.test(code)).toBe(true);
    expect(FLY_INSTANCES_READ.test("throw new Error('set FLY_INSTANCES_API_TOKEN');")).toBe(false);
  });
});
