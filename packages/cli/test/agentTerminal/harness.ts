import { EventEmitter } from 'node:events';
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
  logs: string[];
  token(overrides?: Partial<RelayTokenPayload>): string;
  connect(
    overrides?: Partial<RelayTokenPayload> | { authorization: string | null },
  ): Promise<Client>;
}

export async function startHarness(options: Partial<TerminalServerOptions> = {}): Promise<Harness> {
  const { spawn, ptys } = fakeSpawner();
  const logs: string[] = [];
  const terminal = createTerminalServer({
    instanceKey: KEY,
    instanceId: INSTANCE,
    machineId: MACHINE,
    spawnPty: spawn,
    env: { HOME: '/nonexistent-home', MOTIR_SANDBOX_AGENT: 'kimi' },
    log: (line) => logs.push(line),
    ...options,
  });
  const port = await terminal.listen(0, '127.0.0.1');
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
    logs,
    token,
    connect: (overrides = {}) => {
      const authorization =
        'authorization' in overrides
          ? overrides.authorization
          : relayAuthorizationHeader(token(overrides as Partial<RelayTokenPayload>));
      return Client.connect(port, authorization);
    },
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

  static connect(port: number, authorization: string | null): Promise<Client> {
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
    // Node's WebSocket accepts `headers` in its init dictionary (undici).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/terminal`, {
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
