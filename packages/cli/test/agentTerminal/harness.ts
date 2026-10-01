import { EventEmitter } from 'node:events';
import type {
  ChatAdapter,
  ChatContext,
  ChatSupport,
  TranscriptMapper,
  TurnCommand,
} from '../../src/agentTerminal/chat/adapter.js';
import type {
  ChatErrorCode,
  ChatSessionSummary,
  TranscriptEvent,
} from '../../src/agentTerminal/chat/protocol.js';
import type {
  ChatProcess,
  ChatProcessExit,
  ChatSignal,
  ChatSpawnOptions,
  SpawnChat,
} from '../../src/agentTerminal/chat/turns.js';
import type { PtyProcess, PtySpawnOptions, SpawnPty } from '../../src/agentTerminal/pty.js';
import {
  newNonce,
  relayAuthorizationHeader,
  signRelayToken,
  type RelayTokenPayload,
} from '../../src/agentTerminal/relayToken.js';
import {
  createTerminalServer,
  type TerminalServer,
  type TerminalServerOptions,
} from '../../src/agentTerminal/server.js';

// Shared test harness for the terminal server (MOTIR-6938): a FAKE PTY behind
// the adapter interface, and a WebSocket client built on Node's own (undici)
// implementation — an independent RFC 6455 peer for the hand-written server.

export const KEY = 'dGVzdC1pbnN0YW5jZS1rZXktMzItYnl0ZXMtbG9uZyEh';
export const INSTANCE = 'inst_test_1';
export const MACHINE = 'mach_test_1';

export class FakePty implements PtyProcess {
  readonly pid: number;
  readonly written: Buffer[] = [];
  readonly sizes: { cols: number; rows: number }[] = [];
  killed = false;
  private readonly events = new EventEmitter();

  constructor(
    readonly options: PtySpawnOptions,
    pid: number,
  ) {
    this.pid = pid;
    this.sizes.push({ cols: options.cols, rows: options.rows });
  }

  onData(listener: (data: Buffer) => void): void {
    this.events.on('data', listener);
  }
  onExit(listener: (exit: { exitCode: number | null; signal: number | null }) => void): void {
    this.events.on('exit', listener);
  }
  write(data: Buffer): void {
    this.written.push(Buffer.from(data));
    // Echo, like a terminal would, so input round-trips to the client.
    this.emitData(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exit(null, 1);
  }
  /** Output from the "shell". */
  emitData(data: Buffer | string): void {
    this.events.emit('data', Buffer.from(data));
  }
  exit(exitCode: number | null, signal: number | null): void {
    this.events.emit('exit', { exitCode, signal });
  }
  get input(): string {
    return Buffer.concat(this.written).toString('utf8');
  }
}

export function fakeSpawner(): { spawn: SpawnPty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn: SpawnPty = (options) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

export interface Harness {
  terminal: TerminalServer;
  port: number;
  ptys: FakePty[];
  /** Chat turn processes the server spawned (a fake spawn unless a test passes one). */
  chatProcs: FakeChatProcess[];
  logs: string[];
  token(overrides?: Partial<RelayTokenPayload>): string;
  connect(
    overrides?: Partial<RelayTokenPayload> | { authorization: string | null },
  ): Promise<Client>;
  /** The same, at `/v1/chat` (MOTIR-7012). */
  connectChat(
    overrides?: Partial<RelayTokenPayload> | { authorization: string | null },
  ): Promise<Client>;
}

export async function startHarness(options: Partial<TerminalServerOptions> = {}): Promise<Harness> {
  const { spawn, ptys } = fakeSpawner();
  const chat = fakeChatSpawner();
  const logs: string[] = [];
  const terminal = createTerminalServer({
    instanceKey: KEY,
    instanceId: INSTANCE,
    machineId: MACHINE,
    spawnPty: spawn,
    spawnChat: chat.spawn,
    env: { HOME: '/nonexistent-home', MOTIR_SANDBOX_AGENT: 'kimi' },
    log: (line) => logs.push(line),
    ...options,
  });
  const port = await terminal.listen(0, '127.0.0.1');
  const authorizationFor = (
    overrides: Partial<RelayTokenPayload> | { authorization: string | null },
  ): string | null =>
    'authorization' in overrides
      ? overrides.authorization
      : relayAuthorizationHeader(token(overrides as Partial<RelayTokenPayload>));
  const token = (overrides: Partial<RelayTokenPayload> = {}): string =>
    signRelayToken(KEY, {
      instanceId: INSTANCE,
      machineId: MACHINE,
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: newNonce(),
      ...overrides,
    });
  return {
    terminal,
    port,
    ptys,
    chatProcs: chat.procs,
    logs,
    token,
    connect: (overrides = {}) => Client.connect(port, authorizationFor(overrides)),
    connectChat: (overrides = {}) => Client.connect(port, authorizationFor(overrides), '/v1/chat'),
  };
}

export type Frame = Record<string, unknown>;

/** A WebSocket client over Node's built-in implementation. */
export class Client {
  readonly frames: Frame[] = [];
  readonly binary: Buffer[] = [];
  /** Every message, in arrival order: a parsed frame or a Buffer. */
  readonly sequence: (Frame | Buffer)[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data) as Frame;
        this.frames.push(frame);
        this.sequence.push(frame);
      } else {
        const buf = Buffer.from(event.data as ArrayBuffer);
        this.binary.push(buf);
        this.sequence.push(buf);
      }
      this.notify();
    });
    ws.addEventListener('close', (event) => {
      this.closeCode = event.code;
      this.notify();
    });
  }

  static connect(
    port: number,
    authorization: string | null,
    path = '/v1/terminal',
  ): Promise<Client> {
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
    // Node's WebSocket accepts `headers` in its init dictionary (undici).
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers,
    } as unknown as string[]);
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(client), { once: true });
      ws.addEventListener('error', () => reject(new Error('refused')), { once: true });
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolve once `check` holds, re-evaluated on every message. */
  async until<T>(check: () => T | undefined | null | false, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for the client');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  frame(t: string, index = 0): Promise<Frame> {
    return this.until(() => this.frames.filter((frame) => frame['t'] === t)[index]);
  }

  output(): string {
    return Buffer.concat(this.binary).toString('utf8');
  }

  sendJson(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendBytes(text: string): void {
    this.ws.send(Buffer.from(text));
  }

  closed(): Promise<number> {
    return this.until(() => (this.closeCode === null ? null : this.closeCode));
  }

  close(): void {
    this.ws.close();
  }
}

// ── The chat (MOTIR-7012) ───────────────────────────────────────────────────
// A FAKE turn process behind the `SpawnChat` seam, and a FAKE adapter whose
// "CLI" speaks a tiny JSON-lines dialect, so the runner's rules — order, Stop,
// the per-agent limit, the ring, takeover, the gates — are proved without any
// vendor binary. The real adapters are their own cards.

export class FakeChatProcess implements ChatProcess {
  readonly signals: ChatSignal[] = [];
  exited = false;
  private readonly events = new EventEmitter();

  constructor(
    readonly options: ChatSpawnOptions,
    readonly pid: number,
    /** Exit by itself on SIGKILL (as a real process must). SIGINT is up to the test. */
    private readonly exitOnKill = true,
  ) {}

  onStdout(listener: (chunk: Buffer) => void): void {
    this.events.on('stdout', listener);
  }
  onExit(listener: (exit: ChatProcessExit) => void): void {
    this.events.on('exit', listener);
  }
  signal(signal: ChatSignal): void {
    this.signals.push(signal);
    if (signal === 'SIGKILL' && this.exitOnKill) this.exit(null, 'SIGKILL');
  }
  /** One stdout line from the "CLI". */
  line(value: Record<string, unknown> | string): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.events.emit('stdout', Buffer.from(`${text}\n`));
  }
  raw(text: string | Buffer): void {
    this.events.emit('stdout', Buffer.from(text));
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', { code, signal });
  }
}

export function fakeChatSpawner(): { spawn: SpawnChat; procs: FakeChatProcess[] } {
  const procs: FakeChatProcess[] = [];
  const spawn: SpawnChat = (options) => {
    const proc = new FakeChatProcess(options, 2000 + procs.length);
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

/**
 * The fake CLI's dialect, one JSON object per line:
 *   {"type":"session","id"}           reveals the session id
 *   {"type":"text","id","text"}       assistant text
 *   {"type":"tool","id","command","output"}   a command and its output
 *   {"type":"end"}                    the end-of-turn marker
 *   {"type":"no_key"}                 Q2's backstop: asks for a kill
 *   {"type":<anything else>}          an unmapped event → `other`
 * A line that is not JSON is dropped.
 */
export class FakeChatAdapter implements ChatAdapter {
  answer: ChatSupport = { supported: true };
  sessions: ChatSessionSummary[] = [];
  history: { events: TranscriptEvent[]; truncated: boolean } | { unavailable: true } = {
    events: [],
    truncated: false,
  };
  command: Partial<TurnCommand> = {};
  readonly commands: { prompt: string; sessionId: string | null }[] = [];
  readonly listed: number[] = [];
  readonly histories: { sessionId: string; budgetBytes: number }[] = [];
  /** Resolve `readHistory` only when the test says so. */
  historyGate: Promise<void> | null = null;

  constructor(readonly profile: string) {}

  async support(): Promise<ChatSupport> {
    return this.answer;
  }

  turnCommand(input: { prompt: string; sessionId: string | null }): TurnCommand {
    this.commands.push({ prompt: input.prompt, sessionId: input.sessionId });
    return {
      file: 'fake-agent',
      args: input.sessionId ? ['--resume', input.sessionId] : [],
      stdin: input.prompt,
      ...this.command,
    };
  }

  createMapper(): TranscriptMapper {
    let session: string | null = null;
    let ended = false;
    let kill: ChatErrorCode | null = null;
    return {
      onLine: (line) => {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return [];
        }
        switch (value['type']) {
          case 'session':
            session = value['id'] as string;
            return [];
          case 'text':
            return [{ k: 'text', id: value['id'] as string, delta: value['text'] as string }];
          case 'tool':
            return [
              {
                k: 'tool_call',
                id: value['id'] as string,
                kind: 'command',
                name: 'Bash',
                title: value['command'] as string,
                command: value['command'] as string,
              },
              {
                k: 'tool_result',
                id: value['id'] as string,
                ok: true,
                output: value['output'] as string,
                exitCode: 0,
                truncated: false,
              },
            ];
          case 'end':
            ended = true;
            // An adapter never writes turn_end; the runner drops one if it tries.
            return [{ k: 'turn_end', reason: 'completed' }];
          case 'no_key':
            kill = 'subscription_signin';
            return [];
          default:
            return [{ k: 'other', name: String(value['type']) }];
        }
      },
      sessionId: () => session,
      sawEnd: () => ended,
      killCode: () => kill,
    };
  }

  async listSessions(_ctx: ChatContext, limit: number): Promise<ChatSessionSummary[]> {
    this.listed.push(limit);
    return this.sessions;
  }

  async readHistory(
    _ctx: ChatContext,
    sessionId: string,
    budgetBytes: number,
  ): Promise<{ events: TranscriptEvent[]; truncated: boolean } | { unavailable: true }> {
    this.histories.push({ sessionId, budgetBytes });
    if (this.historyGate) await this.historyGate;
    return this.history;
  }
}
