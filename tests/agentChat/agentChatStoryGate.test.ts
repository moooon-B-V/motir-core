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
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { format } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';
import {
  CHAT_PING_INACTIVE,
  CHAT_PONG,
  TERMINAL_CLOSE,
  type AgentTerminalChannel,
} from '@/lib/agentTerminal/protocol';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import { scrubbedError } from '@/lib/agentTerminal/relay/monitoring';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import '@/lib/jobs/definitions/agentInstanceIdleCheck';
import { agentInstanceActivityService } from '@/lib/services/agentInstanceActivityService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentTerminalRelayService as relayService } from '@/lib/services/agentTerminalRelayService';
import {
  createTerminalServer,
  type TerminalServer,
} from '../../packages/cli/src/agentTerminal/server';
import type { ChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapter';
import {
  createClaudeChatAdapter,
  createClaudeMapper,
} from '../../packages/cli/src/agentTerminal/chat/adapters/claude';
import {
  boundEvent,
  encodeChatServerFrame,
  type ChatServerFrame,
  type TranscriptEvent,
} from '../../packages/cli/src/agentTerminal/chat/protocol';
import {
  spawnChatProcess,
  type ChatSpawnOptions,
  type SpawnChat,
} from '../../packages/cli/src/agentTerminal/chat/turns';
import {
  FakeChatAdapter,
  fakeChatSpawner,
  fakePtySpawner,
  type FakeChatProcess,
} from './_chatFakes';
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

// THE AGENT-CHAT STORY GATE, motir-core (Story MOTIR-6863 · MOTIR-7018,
// `docs/decisions/agent-chat.md`).
//
// Each build card tested its own piece against a stand-in for its neighbour: the
// in-agent chat server against a fake adapter (MOTIR-7012), each adapter against
// its fixtures through a fake process (MOTIR-7014/7015/7016/7034/7035), the
// relay's chat channel against a fake machine that echoes (MOTIR-7013), the tab
// against a fake socket (MOTIR-7017). This file tests the ASSEMBLED path:
//
//   the real ticket ROUTE (`{"channel":"chat"}`) → the real RELAY, wired exactly
//   as `scripts/relay.ts` wires it (the real services, the one activity door, its
//   error reporter handing Sentry) → the fake fleet's endpoint → the REAL
//   in-agent server (`createTerminalServer`, what `motir agent-terminal serve`
//   runs; in-process here, and as the BUILT BINARY for the never-logged guard) →
//   the real turn runner → a real `spawn` of a stand-in `claude` on a PATH this
//   file controls, which replays the recorded Claude Code stream.
//
// ⚠️ NO MODEL IS CALLED, AND NOTHING COULD BE. Every PATH handed to a server here
// is a temp dir of stand-ins plus `/usr/bin:/bin` — never the host's own PATH,
// which on a developer machine can hold a real, signed-in `claude`.
//
// The tab's half — each adapter's stream, over the real socket, drawn by the
// Chat tab — is `agentChatTabGate.test.tsx` (it needs a DOM).
//
// Every guard carries a negative control, so a guard that could never fail cannot
// pass.

// ── Mocks: the session (the repo's one allowed mock), and Sentry's recorder ──

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
// Sentry is an EXTERNAL sink, so it is recorded at its module boundary rather
// than sent: every event and breadcrumb anything in this process hands it.
const sentry = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@sentry/nextjs', () => {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      sentry.calls.push([name, ...args]);
    };
  return {
    addBreadcrumb: record('addBreadcrumb'),
    captureException: record('captureException'),
    captureMessage: record('captureMessage'),
    captureEvent: record('captureEvent'),
    setContext: record('setContext'),
    setExtra: record('setExtra'),
    withScope: record('withScope'),
    init: record('init'),
    flush: async () => true,
  };
});
const Sentry = await import('@sentry/nextjs');

const ticketRoute = await import('@/app/api/projects/[key]/instances/[id]/terminal-ticket/route');

const MASTER = 'story-gate-7018-master-key-'.padEnd(48, 'k');
const ORIGIN = 'https://motir.test';
const REPO = resolve(__dirname, '..', '..');
const FIXTURES = join(
  REPO,
  'packages',
  'cli',
  'test',
  'agentTerminal',
  'fixtures',
  'chat',
  'claude',
);

/** Three sentinels: typed by the developer, printed by a tool, written by the CLI to stderr. */
const PROMPT = 'PROMPT-7018-sentinel-never-logged-9f3a';
const OUTPUT = 'OUTPUT-7018-sentinel-never-logged-b27c';
const STDERR = 'STDERR-7018-sentinel-never-logged-4d1e';

// ── The stand-in `claude` ────────────────────────────────────────────────────

let bin: string;
let marks: string;
/** The recorded Bash turn, its tool output replaced by the OUTPUT sentinel. */
let bashStream: string;

/**
 * `claude auth status --json` prints `$FAKE_CLAUDE_AUTH`. A turn (`claude -p …`)
 * marks that it ran, copies its stdin — the PROMPT — to stderr, writes the STDERR
 * sentinel there too, then replays `$FAKE_CLAUDE_STREAM` on stdout; with
 * `$FAKE_CLAUDE_HANG` set it then waits, as a turn does until it is killed.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = auth ]; then cat "$FAKE_CLAUDE_AUTH"; exit 0; fi
: > "$FAKE_CLAUDE_MARKS/turn-$$"
cat >&2
printf '%s\\n' "$FAKE_CLAUDE_STDERR" >&2
: > "$FAKE_CLAUDE_MARKS/stderr-written-$$"
cat "$FAKE_CLAUDE_STREAM"
if [ -n "$FAKE_CLAUDE_HANG" ]; then exec sleep 60; fi
exit 0
`;

function fakeClaudeEnv(auth: string, stream: string, hang = false): Record<string, string> {
  return {
    FAKE_CLAUDE_AUTH: join(FIXTURES, auth),
    FAKE_CLAUDE_STREAM: stream,
    FAKE_CLAUDE_MARKS: marks,
    FAKE_CLAUDE_STDERR: STDERR,
    ...(hang ? { FAKE_CLAUDE_HANG: '1' } : {}),
  };
}

const turnMarks = () => readdirSync(marks).filter((name) => name.startsWith('turn-'));

// ── The PTY the BUILT server process loads (the terminal gate's stand-in) ────

let ptyDir: string;
let cliEntry: string;

beforeAll(() => {
  cliEntry = ensureCliBuilt();
  bin = mkdtempSync(join(tmpdir(), 'motir-chat-gate-bin-'));
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  marks = mkdtempSync(join(tmpdir(), 'motir-chat-gate-marks-'));
  const bash = readFileSync(join(FIXTURES, 'bash.jsonl'), 'utf8');
  // The negative control for the output sentinel: the recorded output is really there to replace.
  expect(bash).toContain('"content":"a.txt\\nb.md"');
  const streamPath = join(bin, 'bash-sentinel.jsonl');
  writeFileSync(streamPath, bash.replace('"content":"a.txt\\nb.md"', `"content":"${OUTPUT}"`));
  bashStream = streamPath;
  ptyDir = mkdtempSync(join(tmpdir(), 'motir-chat-gate-pty-'));
  const mod = join(ptyDir, 'node_modules', 'node-pty');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(ptyDir, 'package.json'), '{"private":true}\n');
  writeFileSync(join(mod, 'package.json'), '{"name":"node-pty","main":"index.js"}\n');
  copyFileSync(
    join(REPO, 'tests', 'agentTerminal', 'fixtures', 'fake-node-pty.cjs'),
    join(mod, 'index.js'),
  );
}, 180_000);

afterAll(async () => {
  for (const dir of [bin, marks, ptyDir]) rmSync(dir, { recursive: true, force: true });
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The real chat server, in-process ────────────────────────────────────────

interface ChatServer {
  terminal: TerminalServer;
  home: string;
  logs: string[];
  /** Every turn process the runner asked for — the spawn seam. */
  spawns: ChatSpawnOptions[];
  stop(): Promise<void>;
}
const servers: ChatServer[] = [];

async function startChatServer(
  instanceId: string,
  options: { adapters?: ChatAdapter[]; spawn?: SpawnChat; env?: Record<string, string> } = {},
): Promise<ChatServer> {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const home = mkdtempSync(join(tmpdir(), 'motir-chat-gate-home-'));
  mkdirSync(join(home, 'workspace'));
  const logs: string[] = [];
  const spawns: ChatSpawnOptions[] = [];
  const inner = options.spawn ?? spawnChatProcess;
  const terminal = createTerminalServer({
    instanceKey: deriveTerminalKey(MASTER, instanceId),
    instanceId,
    machineId: row.machineId!,
    spawnPty: fakePtySpawner().spawn,
    spawnChat: (o) => {
      spawns.push(o);
      return inner(o);
    },
    ...(options.adapters ? { chatAdapters: options.adapters } : {}),
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      MOTIR_SANDBOX_AGENT: 'claude',
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      MOTIR_TERMINAL_KEY: deriveTerminalKey(MASTER, instanceId),
      ...options.env,
    } as unknown as NodeJS.ProcessEnv,
    log: (line) => logs.push(line),
  });
  const port = await terminal.listen(0, '127.0.0.1');
  fleet.setTerminalAddress(`ws://127.0.0.1:${port}`);
  const server: ChatServer = {
    terminal,
    home,
    logs,
    spawns,
    async stop() {
      await terminal.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
  servers.push(server);
  return server;
}

// ── The relay, wired as `scripts/relay.ts` wires it ─────────────────────────

const RELAY_MACHINE_ID = 'relay-chat-story-gate';
let relay: TerminalRelay;
let relayBase: string;
const relayLogs: string[] = [];
const consoleLines: string[] = [];
const processWrites: string[] = [];
const touches: string[] = [];
let failTouch = false;

const pendingTouches = new Set<Promise<void>>();

async function startRelay(): Promise<void> {
  relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: (ticket, channel) => relayService.authorizeConnection(ticket, channel),
    openConnection: (input) =>
      relayService.openConnection({ ...input, relayMachineId: RELAY_MACHINE_ID }),
    closeConnection: (input) => relayService.closeConnection(input),
    touchActivity: (instanceId) => {
      touches.push(instanceId);
      const work = (async () => {
        if (failTouch) throw new Error(`touch failed while carrying ${PROMPT} and ${OUTPUT}`);
        await agentInstanceActivityService.touchActivity(instanceId);
      })();
      // The relay fires this and moves on; the test settles it before teardown.
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      pendingTouches.add(settled);
      void settled.then(() => pendingTouches.delete(settled));
      return work;
    },
    heartbeat: async (connections) => {
      await relayService.heartbeatConnections({ relayMachineId: RELAY_MACHINE_ID, connections });
    },
    log: (line) => relayLogs.push(line),
    // Exactly `scripts/relay.ts`'s reporter: a console line, and Sentry.
    reportError: (err) => {
      console.error(`[relay] ${err.message}`);
      Sentry.captureException(err);
    },
    now: () => clock.now().getTime(),
    authTimeoutMs: 1_000,
  });
  await new Promise<void>((ok) => relay.server.listen(0, '127.0.0.1', ok));
  relayBase = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
}

/** Every console line and every raw stdout/stderr write in THIS process. */
function captureOutput(): void {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(format(...args));
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      processWrites.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
}

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.stubEnv('MOTIR_RELAY_URL', '');
  relayLogs.length = 0;
  consoleLines.length = 0;
  processWrites.length = 0;
  touches.length = 0;
  sentry.calls.length = 0;
  failTouch = false;
  for (const name of readdirSync(marks)) rmSync(join(marks, name));
  captureOutput();
  await actAs(fx.ownerId);
  await startRelay();
});

afterEach(async () => {
  await relay.close();
  // Every activity write the relay fired is awaited before the database resets.
  await Promise.all([...pendingTouches]);
  for (const s of servers.splice(0)) await s.stop();
  for (const p of processes.splice(0)) await p.stop();
  fleet.setTerminalAddress(null);
  await tearDownHarness();
});

// ── Browser helpers ─────────────────────────────────────────────────────────

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

/** Wait on an authoritative condition (a received frame, a committed row), never a guess. */
async function until(done: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; relay=${JSON.stringify(relayLogs)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const params = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
const postTicket = (id: string, channel?: AgentTerminalChannel) =>
  ticketRoute.POST(
    new Request(
      `http://test/api/projects/${fx.projectIdentifier}/instances/${id}/terminal-ticket`,
      {
        method: 'POST',
        ...(channel ? { body: JSON.stringify({ channel }) } : {}),
      },
    ),
    params(id),
  );

/** A ticket, as the tab gets it: through the real route. */
async function ticketFor(id: string, channel?: AgentTerminalChannel): Promise<string> {
  const res = await postTicket(id, channel);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string; channel: string };
  expect(body.channel).toBe(channel ?? 'terminal');
  return body.ticket;
}

interface Browser {
  ws: WebSocket;
  /** Every text frame, exactly as it arrived. */
  raw: string[];
  closed: Promise<number>;
  frames(): Record<string, unknown>[];
  frame(t: string, index?: number): Promise<Record<string, unknown>>;
  sendRaw(text: string): void;
}

async function browser(path: '/v1/chat' | '/v1/terminal' = '/v1/chat'): Promise<Browser> {
  const ws = new WebSocket(`${relayBase}${path}`, { origin: ORIGIN });
  const b: Browser = {
    ws,
    raw: [],
    closed: new Promise((ok) => ws.on('close', (code) => ok(code))),
    frames: () => b.raw.map((text) => JSON.parse(text) as Record<string, unknown>),
    async frame(t, index = 0) {
      let found: Record<string, unknown> | undefined;
      await until(() => {
        found = b.frames().filter((f) => f['t'] === t)[index];
        return found !== undefined;
      });
      return found!;
    },
    sendRaw: (text) => ws.send(text),
  };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) b.raw.push(Buffer.from(data as Buffer).toString('utf8'));
  });
  await new Promise<void>((ok, fail) => {
    ws.once('open', () => ok());
    ws.once('error', fail);
  });
  return b;
}

/** A chat through the relay: auth with a real chat ticket, and the server's `hello`. */
async function chat(id: string): Promise<Browser> {
  const b = await browser('/v1/chat');
  b.sendRaw(JSON.stringify({ t: 'auth', ticket: await ticketFor(id, 'chat') }));
  await b.frame('hello');
  return b;
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

/** What the runner sends for one recorded Claude Code stream: its `session` and `event` frames, in order. */
function expectedTurnFrames(stream: string, prompt: string, turn = 1): string[] {
  const mapper = createClaudeMapper();
  const ev = (e: TranscriptEvent) => encodeChatServerFrame({ t: 'event', turn, e: boundEvent(e) });
  const out = [ev({ k: 'user', text: prompt })];
  let revealed: string | null = null;
  for (const raw of stream.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) continue;
    const events = mapper.onLine(line);
    const id = mapper.sessionId();
    if (id !== null && id !== revealed) {
      revealed = id;
      out.push(encodeChatServerFrame({ t: 'session', id } as ChatServerFrame));
    }
    for (const e of events) if (e.k !== 'turn_end') out.push(ev(e));
  }
  expect(mapper.sawEnd()).toBe(true);
  out.push(ev({ k: 'turn_end', reason: 'completed' }));
  return out;
}

const transcriptFrames = (b: Browser) =>
  b.raw.filter((text) => {
    const t = (JSON.parse(text) as { t: string }).t;
    return t === 'event' || t === 'session';
  });

// ── The sinks ───────────────────────────────────────────────────────────────

/** Every way a sink could hold a marker: as text, and as `console.log(buffer)` prints bytes. */
function leaks(sink: string, marker: string): boolean {
  const bytes = Buffer.from(marker, 'utf8');
  const hexSpaced = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return sink.includes(marker) || sink.includes(hexSpaced) || sink.includes(bytes.toString('hex'));
}

/** Every base table in the database. */
async function tables(): Promise<string[]> {
  const rows = await adminDb.$queryRawUnsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.name);
}

/** Row counts of every table — the diff says exactly which tables a run wrote to. */
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await tables()) {
    const [row] = await adminDb.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${name}"`,
    );
    out[name] = row!.n;
  }
  return out;
}

/** The tables holding any row whose text contains the marker — the whole database, every column. */
async function tablesHolding(marker: string): Promise<string[]> {
  const hits: string[] = [];
  for (const name of await tables()) {
    const [row] = await adminDb.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${name}" t WHERE t::text LIKE $1`,
      `%${marker}%`,
    );
    if (row!.n > 0) hits.push(name);
  }
  return hits;
}

function changed(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.keys(after)
    .filter((name) => after[name] !== before[name])
    .sort();
}

// ── 1 · The seam ────────────────────────────────────────────────────────────

describe('1 · the seam: route → relay → the real chat server → a real turn process', () => {
  it('a chat ticket goes in; the recorded Claude Code turn arrives at the browser byte for byte, in order, ending in turn_end — and nothing calls a model or writes a charge', async () => {
    const id = await runningAgent();
    // The TEST-REGISTERED adapter: the real Claude Code adapter, its probe the recorded API-key answer.
    const adapter = createClaudeChatAdapter({
      probe: async () => readFileSync(join(FIXTURES, 'auth-status-api-key.json'), 'utf8'),
    });
    const server = await startChatServer(id, {
      adapters: [adapter],
      env: fakeClaudeEnv('auth-status-api-key.json', bashStream),
    });
    const fetchesBefore = stub.calls.length;
    const countsBefore = await rowCounts();

    const b = await chat(id);
    expect(b.frames()[0]).toEqual({
      t: 'hello',
      profile: 'claude',
      supported: true,
      signin: 'signed_in',
    });
    b.sendRaw('{"t":"open"}');
    expect(await b.frame('ready')).toEqual({ t: 'ready', session: null, resumed: false });
    b.sendRaw(JSON.stringify({ t: 'prompt', text: PROMPT }));
    await until(() =>
      b.frames().some((f) => f['t'] === 'event' && (f['e'] as { k: string }).k === 'turn_end'),
    );

    // Byte for byte and in order: exactly the frames the runner writes for that stream.
    const expected = expectedTurnFrames(readFileSync(bashStream, 'utf8'), PROMPT);
    expect(transcriptFrames(b)).toEqual(expected);
    expect(JSON.parse(expected.at(-1)!)).toEqual({
      t: 'event',
      turn: 1,
      e: { k: 'turn_end', reason: 'completed' },
    });
    // The transcript really carried the tool's output — so the sinks below are tested against it.
    expect(expected.some((f) => f.includes(OUTPUT))).toBe(true);

    // The spawn seam: ONE turn process, the vendor binary by its bare name, the
    // prompt on stdin, and the server's key not in its environment (Q3, Q11).
    expect(server.spawns).toHaveLength(1);
    const [turn] = server.spawns;
    expect(turn).toMatchObject({
      file: 'claude',
      stdin: PROMPT,
      cwd: join(server.home, 'workspace'),
    });
    expect(turn!.args.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
    expect(turn!.env).not.toHaveProperty('MOTIR_TERMINAL_KEY');
    expect(turnMarks()).toHaveLength(1);

    // Recorded as a CHAT connection.
    expect(await connections()).toEqual([
      expect.objectContaining({
        instanceId: id,
        userId: fx.ownerId,
        channel: 'chat',
        closedAt: null,
      }),
    ]);

    // NO MODEL CALL, NO TOKEN USAGE: no fetch left this process during the chat
    // (the harness's fetch stub records every one), and the only rows the chat
    // wrote are its ticket, its connection and the idle timer's re-arm.
    b.ws.close();
    await until(async () => (await connections())[0]?.closedAt != null);
    expect(stub.calls.slice(fetchesBefore)).toEqual([]);
    const wrote = changed(countsBefore, await rowCounts());
    expect(wrote.filter((t) => !CHAT_WRITES.has(t))).toEqual([]);
    expect(wrote).toEqual(
      expect.arrayContaining(['agent_terminal_connection', 'agent_terminal_ticket']),
    );
    expect(server.logs.some((line) => /turn 1 ended \(completed, \d+ ms\)/.test(line))).toBe(true);
  }, 60_000);
});

/**
 * The tables a chat may write: its ticket and its connection (Q10's one row), and
 * the job engine's idle-timer re-arm that an activity bump sends. Anything else —
 * an interval, a usage or charge row, a plan turn — would be a chat that costs
 * or records something.
 */
const CHAT_WRITES: ReadonlySet<string> = new Set([
  'agent_terminal_ticket',
  'agent_terminal_connection',
  'job_queue_run',
  'job_event',
  'job_run',
  'job_step',
]);

// ── 2 · Claude Code on a subscription ───────────────────────────────────────

describe('2 · Claude Code on a Claude subscription (Q2 option b)', () => {
  it('the REAL probe reads a subscription: hello says so, a prompt is refused with that code, NO turn process is spawned — and the terminal still connects', async () => {
    const id = await runningAgent();
    // No adapter registered by the test: the registry's own Claude Code adapter,
    // its own `claude auth status --json`, run against the stand-in binary.
    const server = await startChatServer(id, {
      env: fakeClaudeEnv('auth-status-subscription.json', bashStream),
    });

    const b = await chat(id);
    expect(b.frames()[0]).toMatchObject({
      t: 'hello',
      profile: 'claude',
      supported: false,
      reason: 'subscription_signin',
    });
    b.sendRaw('{"t":"open"}');
    await b.frame('ready');
    b.sendRaw(JSON.stringify({ t: 'prompt', text: PROMPT }));
    expect(await b.frame('error')).toEqual({ t: 'error', code: 'subscription_signin' });

    // The spawn seam saw nothing, and the stand-in never ran as a turn.
    expect(server.spawns).toEqual([]);
    expect(turnMarks()).toEqual([]);
    expect(b.frames().filter((f) => f['t'] === 'event')).toEqual([]);
    expect(server.logs).toContain('agent-chat: prompt refused (subscription_signin)');

    // The terminal beside it is untouched: a terminal ticket, the terminal path, a shell.
    const term = await browser('/v1/terminal');
    term.sendRaw(JSON.stringify({ t: 'auth', ticket: await ticketFor(id) }));
    term.sendRaw(JSON.stringify({ t: 'open', cols: 80, rows: 24 }));
    expect(await term.frame('ready')).toMatchObject({ t: 'ready', resumed: false });
    expect(server.terminal.sessionCount()).toBe(1);
    const rows = await connections();
    expect(rows.map((r) => r.channel).sort()).toEqual(['chat', 'terminal']);
    b.ws.close();
    term.ws.close();
  }, 60_000);

  it('the backstop: an auth status that passes, but a stream whose init reads apiKeySource "none", ends the turn failed with subscription_signin', async () => {
    const id = await runningAgent();
    // The recorded init line, then a process that never ends by itself: only
    // the adapter's kill can end this turn. (The recording's later lines are
    // left out on purpose: when they arrive in the same pipe read as the init,
    // the runner maps them too — reported on MOTIR-7018, not asserted here.)
    const recorded = readFileSync(join(FIXTURES, 'no-key.jsonl'), 'utf8').split('\n');
    const init = recorded.find((line) => line.includes('"subtype":"init"')) as string;
    expect(init).toContain('"apiKeySource":"none"');
    const initOnly = join(bin, 'no-key-init-only.jsonl');
    writeFileSync(initOnly, `${init}\n`);
    const server = await startChatServer(id, {
      env: fakeClaudeEnv('auth-status-api-key.json', initOnly, true),
    });
    const b = await chat(id);
    expect(b.frames()[0]).toMatchObject({ supported: true, signin: 'signed_in' });
    b.sendRaw('{"t":"open"}');
    await b.frame('ready');
    b.sendRaw(JSON.stringify({ t: 'prompt', text: PROMPT }));
    await until(() =>
      b.frames().some((f) => f['t'] === 'event' && (f['e'] as { k: string }).k === 'turn_end'),
    );
    const events = b
      .frames()
      .filter((f) => f['t'] === 'event')
      .map((f) => f['e']);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'failed', code: 'subscription_signin' });
    // Killed on the init line: the user's line and the failed end, nothing else.
    expect(events).toEqual([
      { k: 'user', text: PROMPT },
      { k: 'turn_end', reason: 'failed', code: 'subscription_signin' },
    ]);
    expect(server.spawns).toHaveLength(1);
    expect(server.logs).toContain('agent-chat: turn 1 killed by its adapter (subscription_signin)');
    expect(server.terminal.chatTurn()).toBeNull();
    b.ws.close();
  }, 60_000);
});

// ── 3 · Owner-only, against the real database ───────────────────────────────

describe('3 · owner-only, against the real database', () => {
  it('another member asking for a chat ticket is refused not_owner 403, and no ticket is minted', async () => {
    const id = await runningAgent();
    const manager = await adminDb.user.create({
      data: { name: 'Manager', email: `mgr-${Date.now()}-${Math.random()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: manager.id, workspaceRole: 'member' },
    });
    await setWorkspaceRoleFor(manager.id, fx.workspaceId, 'admin');
    await actAs(manager.id);
    const refused = await postTicket(id, 'chat');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'not_owner' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
    // Negative control: the owner's own request, the same way, is a chat ticket.
    await actAs(fx.ownerId);
    await ticketFor(id, 'chat');
    expect(await adminDb.agentTerminalTicket.findMany()).toEqual([
      expect.objectContaining({ channel: 'chat', userId: fx.ownerId }),
    ]);
  });

  it('a chat ticket on /v1/terminal, and a terminal ticket on /v1/chat, are each closed 4401 — and reach no server', async () => {
    const id = await runningAgent();
    const server = await startChatServer(id, { adapters: [new FakeChatAdapter('claude')] });
    for (const [path, channel] of [
      ['/v1/terminal', 'chat'],
      ['/v1/chat', 'terminal'],
    ] as const) {
      const b = await browser(path);
      b.sendRaw(JSON.stringify({ t: 'auth', ticket: await ticketFor(id, channel) }));
      expect(await b.closed).toBe(TERMINAL_CLOSE.badTicket);
    }
    expect(await connections()).toEqual([]);
    expect(server.logs.filter((l) => l.includes('connection opened'))).toEqual([]);
    // Negative control: a chat ticket on its own path is served.
    const ok = await chat(id);
    expect(ok.frames()[0]).toMatchObject({ t: 'hello', supported: true });
    ok.ws.close();
  }, 60_000);
});

// ── 4 · An old image ────────────────────────────────────────────────────────

describe('4 · an image with no chat server (Q8)', () => {
  it('a server that 404s /v1/chat makes the relay close the browser 4411, recorded no_chat_server — and its terminal still dials', async () => {
    const id = await runningAgent();
    const upgrades: string[] = [];
    const old = http.createServer((_req, res) => res.writeHead(404).end());
    old.on('upgrade', (req, socket) => {
      upgrades.push(req.url ?? '');
      // The terminal server as it was before the chat: /v1/terminal only.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((ok) => old.listen(0, '127.0.0.1', ok));
    fleet.setTerminalAddress(`ws://127.0.0.1:${(old.address() as AddressInfo).port}`);
    try {
      const b = await browser('/v1/chat');
      b.sendRaw(JSON.stringify({ t: 'auth', ticket: await ticketFor(id, 'chat') }));
      expect(await b.closed).toBe(TERMINAL_CLOSE.noChatServer);
      await until(async () => (await connections())[0]?.closedAt != null);
      expect((await connections())[0]).toMatchObject({
        channel: 'chat',
        closeCode: TERMINAL_CLOSE.noChatServer,
        closeReason: 'no_chat_server',
      });
      expect(upgrades).toEqual(['/v1/chat']);
      // A state, not a failure: logged, never reported.
      expect(sentry.calls).toEqual([]);
      // Negative control: the same 404 on the TERMINAL channel is 4502, not 4411.
      const term = await browser('/v1/terminal');
      term.sendRaw(JSON.stringify({ t: 'auth', ticket: await ticketFor(id) }));
      expect(await term.closed).toBe(TERMINAL_CLOSE.unreachable);
    } finally {
      await new Promise<void>((ok) => old.close(() => ok()));
    }
  }, 60_000);
});

// ── 5 · Chatting keeps the agent awake ──────────────────────────────────────

describe('5 · chatting keeps the agent awake (Q9)', () => {
  it('a streaming turn moves lastActivityAt and re-arms the idle check; a socket sending only the hidden tab’s heartbeat does not; after close the agent hibernates at the window', async () => {
    const id = await runningAgent();
    const adapter = new FakeChatAdapter('claude');
    adapter.answer = { supported: true, signedIn: true };
    const procs = fakeChatSpawner();
    await startChatServer(id, { adapters: [adapter], spawn: procs.spawn });
    const armedAtCreate = (await idleTimer(id))!.eventId;
    const lastActivity = async () => (await instanceRow(id)).lastActivityAt!.getTime();
    const settledAt = async (armedBy: string | null) => {
      await until(async () => (await lastActivity()) === clock.now().getTime());
      await until(async () => (await idleTimer(id))!.eventId !== armedBy);
      return (await idleTimer(id))!.eventId;
    };

    // The open bumps it, and re-arms the timer the create armed.
    clock.advance(MIN);
    const b = await chat(id);
    let armedBy = await settledAt(armedAtCreate);
    b.sendRaw('{"t":"open"}');
    await b.frame('ready');
    b.sendRaw(JSON.stringify({ t: 'prompt', text: 'stream for a while' }));
    await until(() => procs.procs.length === 1);
    const proc = procs.procs[0] as FakeChatProcess;

    // Ten minutes of a turn streaming — server → browser only — and it moves every minute.
    for (let minute = 1; minute <= 10; minute += 1) {
      clock.advance(MIN + 1_000);
      const before = b.raw.length;
      proc.line({ type: 'text', id: 'm1', text: `tick-${minute} ` });
      await until(() => b.raw.length > before);
      armedBy = await settledAt(armedBy);
    }
    proc.line({ type: 'end' });
    proc.exit(0);
    await until(() => b.frames().some((f) => (f['e'] as { k?: string })?.k === 'turn_end'));
    clock.advance(MIN + 1_000);
    b.ws.close();
    await until(async () => (await connections())[0]?.closedAt != null);
    armedBy = await settledAt(armedBy);

    // A second socket that only ever sends the hidden tab's heartbeat. Its open
    // counts (Q9); twenty minutes of `{"t":"ping","active":false}` and the
    // server's `{"t":"pong"}` do not.
    clock.advance(MIN + 1_000);
    const quiet = await chat(id);
    armedBy = await settledAt(armedBy);
    const openedAt = await lastActivity();
    const touchesAtOpen = touches.length;
    for (let minute = 1; minute <= 20; minute += 1) {
      clock.advance(MIN + 1_000);
      const pongs = quiet.raw.filter((text) => text === CHAT_PONG).length;
      quiet.sendRaw(CHAT_PING_INACTIVE);
      await until(() => quiet.raw.filter((text) => text === CHAT_PONG).length > pongs);
    }
    // The relay bumps synchronously as a frame passes, so by the last pong every
    // bump it would have made has been made: none.
    expect(touches.length).toBe(touchesAtOpen);
    expect(await lastActivity()).toBe(openedAt);
    expect((await idleTimer(id))!.eventId).toBe(armedBy);
    // Negative control: the SAME socket's visible-tab heartbeat counts.
    quiet.sendRaw('{"t":"ping","active":true}');
    await until(() => touches.length === touchesAtOpen + 1);
    armedBy = await settledAt(armedBy);

    // After close, the real idle-check job waits out the window, then hibernates.
    clock.advance(MIN + 1_000);
    quiet.ws.close();
    await until(async () => (await connections())[1]?.closedAt != null);
    await settledAt(armedBy);
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
    expect((await connections()).map((r) => r.channel)).toEqual(['chat', 'chat']);
  }, 180_000);
});

// ── 6 · The never-logged guards ─────────────────────────────────────────────

interface ServerProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  output(): string;
  stop(): Promise<void>;
}
const processes: ServerProcess[] = [];

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

/** The BUILT `motir agent-terminal serve`, as the machine runs it, its stdout and stderr captured. */
async function startServerProcess(instanceId: string, env: Record<string, string>) {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const home = mkdtempSync(join(tmpdir(), 'motir-chat-gate-proc-'));
  mkdirSync(join(home, 'workspace'));
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
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        MOTIR_TERMINAL_KEY: deriveTerminalKey(MASTER, instanceId),
        MOTIR_INSTANCE_ID: instanceId,
        FLY_MACHINE_ID: row.machineId!,
        MOTIR_SANDBOX_AGENT: 'claude',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        MOTIR_TERMINAL_MODULE_DIR: ptyDir,
        ...env,
      },
    },
  );
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  child.stderr.on('data', (c: Buffer) => chunks.push(c));
  const output = () => Buffer.concat(chunks).toString('utf8');
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  await until(() => output().includes('listening on') || child.exitCode !== null, 30_000);
  if (child.exitCode !== null) throw new Error(`the chat server exited: ${output()}`);
  fleet.setTerminalAddress(`ws://127.0.0.1:${port}`);
  const server: ServerProcess = {
    child,
    output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
  processes.push(server);
  return server;
}

describe('6 · what is never logged (Q10)', () => {
  it('the guard sees a marker in every form a logged payload would take (negative control)', () => {
    const frame = Buffer.from(JSON.stringify({ t: 'prompt', text: PROMPT }));
    // console.log(buffer) prints `<Buffer 7b 22 …>`, and only the first 50 bytes.
    expect(leaks(format(Buffer.from(PROMPT)), PROMPT)).toBe(true);
    expect(leaks(String(frame), PROMPT)).toBe(true);
    expect(leaks(frame.toString('hex'), PROMPT)).toBe(true);
    expect(leaks('agent-chat: turn 1 started (pid 42)', PROMPT)).toBe(false);
    // And the database scan finds a marker wherever a row holds it.
    expect(scrubbedError('relay: x', new Error(PROMPT)).message).not.toContain(PROMPT);
  });

  it('a prompt, a tool output and the CLI’s stderr — with a forced error mid-stream — reach no log, no report, no Sentry call and no database row', async () => {
    const id = await runningAgent();
    // The REAL registry, the REAL probe, the REAL spawn, in the BUILT server process.
    const server = await startServerProcess(
      id,
      fakeClaudeEnv('auth-status-api-key.json', bashStream),
    );
    const ticket = await ticketFor(id, 'chat');
    const b = await browser('/v1/chat');
    b.sendRaw(JSON.stringify({ t: 'auth', ticket }));
    expect(await b.frame('hello')).toMatchObject({ supported: true, signin: 'signed_in' });
    b.sendRaw('{"t":"open"}');
    await b.frame('ready');

    // Forced errors mid-stream: every activity bump now throws with the markers
    // in its message, while the turn streams.
    failTouch = true;
    clock.advance(MIN + 1_000);
    b.sendRaw(JSON.stringify({ t: 'prompt', text: PROMPT }));
    await until(() =>
      b.frames().some((f) => f['t'] === 'event' && (f['e'] as { k: string }).k === 'turn_end'),
    );
    await until(() => sentry.calls.length > 0);
    // The transcript the browser drew carried all it should: the prompt and the output.
    expect(b.raw.join('\n')).toContain(PROMPT);
    expect(b.raw.join('\n')).toContain(OUTPUT);
    // The stand-in really ran, and really wrote the prompt and the STDERR marker to its stderr.
    expect(turnMarks()).toHaveLength(1);
    expect(readdirSync(marks).some((name) => name.startsWith('stderr-written-'))).toBe(true);
    // A mid-stream error was reported — scrubbed.
    b.ws.close();
    await until(async () => (await connections())[0]?.closedAt != null);

    const sinks = {
      relay: relayLogs.join('\n'),
      server: server.output(),
      console: consoleLines.join('\n'),
      stdio: processWrites.join('\n'),
      sentry: JSON.stringify(
        sentry.calls.map((call) =>
          call.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : a)),
        ),
      ),
    };
    // Each sink was LIVE — it wrote lines — so its silence about the markers means something.
    expect(sinks.relay).toContain(`opened instance=${id}`);
    expect(sinks.relay).toContain('channel=chat');
    expect(sinks.server).toContain('agent-chat: connection opened');
    expect(sinks.server).toMatch(/agent-chat: turn 1 ended \(completed, \d+ ms\)/);
    expect(sinks.console).toContain('[relay] relay: touchActivity failed (Error)');
    expect(sinks.sentry).toContain('relay: touchActivity failed (Error)');
    for (const [name, text] of Object.entries(sinks)) {
      for (const marker of [PROMPT, OUTPUT, STDERR, ticket]) {
        expect({ name, marker, leaks: leaks(text, marker) }).toEqual({
          name,
          marker,
          leaks: false,
        });
      }
    }
    // Not a breadcrumb, not an event: the only Sentry calls are the scrubbed reports.
    expect(new Set(sentry.calls.map((call) => call[0]))).toEqual(new Set(['captureException']));

    // The database: every table, every column — the connection, ticket and instance rows included.
    for (const marker of [PROMPT, OUTPUT, STDERR]) {
      expect({ marker, tables: await tablesHolding(marker) }).toEqual({ marker, tables: [] });
    }
    // Negative control for the scan: it finds what a row does hold.
    expect(await tablesHolding(id)).toEqual(
      expect.arrayContaining([
        'agent_instance',
        'agent_terminal_connection',
        'agent_terminal_ticket',
      ]),
    );
  }, 120_000);
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
const crossesIntoCli = (code: string) =>
  [...code.matchAll(IMPORT_SPECIFIER)]
    .map((m) => m[1]!)
    .some((s) => /(^|\/)packages\/cli(\/|$)/.test(s) || s.startsWith('@motir/cli'));

describe('7 · architecture guards', () => {
  it('no Chat-tab or chat-protocol module in the web app imports packages/cli — the browser keeps its own mirror', () => {
    const chatFiles = [
      ...walk(join(REPO, 'app', '(authed)', 'my-agents')),
      ...walk(join(REPO, 'lib', 'agentChat')),
      ...walk(join(REPO, 'lib', 'agentTerminal')),
      join(REPO, 'lib', 'agentInstances', 'profiles.ts'),
    ];
    expect(chatFiles.map((f) => relative(REPO, f))).toEqual(
      expect.arrayContaining([
        'app/(authed)/my-agents/_components/AgentChat.tsx',
        'app/(authed)/my-agents/_components/useAgentChat.ts',
        'lib/agentChat/protocol.ts',
      ]),
    );
    const offenders = chatFiles
      .filter((f) => crossesIntoCli(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
    // Negative control: each spelling of a crossing is caught; a comment is not one.
    expect(
      crossesIntoCli("import { x } from '../../packages/cli/src/agentTerminal/chat/protocol';"),
    ).toBe(true);
    expect(crossesIntoCli("const m = await import('@motir/cli/package.json');")).toBe(true);
    expect(crossesIntoCli(stripComments("// mirrors '../../packages/cli/src/x'"))).toBe(false);
    // The whole-tree guard (app/ and lib/, beyond the two catalog modules) is the
    // terminal gate's (`tests/agentTerminal/agentTerminalStoryGate.test.ts` §7), and
    // the protocol mirror's drift test is `tests/agentChat/protocolMirror.test.ts` —
    // both run in this story's coverage lane.
    const lane = readFileSync(join(REPO, 'vitest.coverage.agent-instances.config.ts'), 'utf8');
    expect(lane).toContain("'tests/agentChat/**/*.test.{ts,tsx}'");
    expect(lane).toContain("'tests/agentTerminal/**/*.test.ts'");
    expect(existsSync(join(REPO, 'tests', 'agentChat', 'protocolMirror.test.ts'))).toBe(true);
  });
});
