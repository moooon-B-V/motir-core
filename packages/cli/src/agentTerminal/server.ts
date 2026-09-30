import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { OutputRing, REPLAY_BYTES } from './outputRing.js';
import {
  CHAT_PATH,
  TERMINAL_PATH,
  encodeServerFrame,
  parseClientFrame,
  type ServerFrame,
} from './protocol.js';
import type { PtyProcess, SpawnPty } from './pty.js';
import { NonceMemory, verifyRelayAuthorization } from './relayToken.js';
import { checkSignIn, type SignInStatus, type StatFn } from './signIn.js';
import {
  acceptWebSocket,
  isWebSocketUpgrade,
  refuseUpgrade,
  type WebSocketConnection,
} from './websocket.js';

// The in-agent terminal server (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q3, Q4, Q5, Q7, Q8).
//
// ⚠️ WHAT IS NEVER LOGGED. Fly ships this process's stdout to logs, so the
// only lines written are LIFECYCLE lines carrying ids: a session opened,
// attached, detached, reaped or exited, an upgrade refused with its reason
// CODE. Never a frame, a byte of PTY input or output, a token, the key, or an
// `Error` message built from any of them. PTY bytes travel between the PTY and
// the socket and the in-memory replay ring, and nowhere else.
//
// Everything with a side effect (the PTY, the clock, `fs.stat`, the log sink)
// is injected, so the tests drive this module against a fake PTY.

/** The env var holding the instance key; it is removed from the shell's env. */
export const TERMINAL_KEY_ENV = 'MOTIR_TERMINAL_KEY';
/** Live sessions per agent (Q5). */
export const MAX_SESSIONS = 4;
/** How often the sign-in state is re-checked while a session is attached (Q7). */
export const SIGNIN_INTERVAL_MS = 5_000;
/** How long an authenticated connection may wait before its `open` frame. */
export const OPEN_TIMEOUT_MS = 30_000;

export interface TerminalServerOptions {
  /** MOTIR_TERMINAL_KEY. */
  instanceKey: string;
  /** MOTIR_INSTANCE_ID. */
  instanceId: string;
  /** FLY_MACHINE_ID. */
  machineId: string;
  spawnPty: SpawnPty;
  /** The server's own environment; the shell gets it minus the key. */
  env: NodeJS.ProcessEnv;
  /** Lifecycle lines only. */
  log: (line: string) => void;
  /** Milliseconds since the epoch. */
  now?: () => number;
  stat?: StatFn;
  maxSessions?: number;
  replayBytes?: number;
  signInIntervalMs?: number;
  openTimeoutMs?: number;
}

interface Session {
  id: string;
  pty: PtyProcess;
  ring: OutputRing;
  connection: Attachment | null;
  /** When it last lost its connection; null while attached. */
  detachedAt: number | null;
  /** Monotonic tiebreak for sessions detached in the same millisecond. */
  detachSeq: number;
}

interface Attachment {
  ws: WebSocketConnection;
  session: Session | null;
  /** The session the relay token names, if any. */
  tokenSession: string | undefined;
}

export interface TerminalServer {
  readonly server: Server;
  /** Start listening; resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  /** Kill every shell, drop every connection, stop listening. */
  close(): Promise<void>;
  /** How many live sessions the server holds. */
  sessionCount(): number;
}

/** The shell's environment: the server's own, minus the key, plus the terminal type. */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === TERMINAL_KEY_ENV || value === undefined) continue;
    out[name] = value;
  }
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  return out;
}

/** `$HOME/workspace`, or `$HOME` when the workspace does not exist yet. */
export function shellCwd(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'] || '/';
  const workspace = join(home, 'workspace');
  try {
    if (existsSync(workspace) && statSync(workspace).isDirectory()) return workspace;
  } catch {
    // fall through to HOME
  }
  return home;
}

export function createTerminalServer(options: TerminalServerOptions): TerminalServer {
  const now = options.now ?? Date.now;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const replayBytes = options.replayBytes ?? REPLAY_BYTES;
  const signInIntervalMs = options.signInIntervalMs ?? SIGNIN_INTERVAL_MS;
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const log = options.log;
  const nonces = new NonceMemory();
  const sessions = new Map<string, Session>();
  const connections = new Set<Attachment>();
  let detachCounter = 0;
  let signInTimer: NodeJS.Timeout | null = null;
  let lastSignIn: SignInStatus | null = null;
  let closing = false;

  const send = (attachment: Attachment, frame: ServerFrame): void => {
    if (attachment.ws.isOpen) attachment.ws.send(encodeServerFrame(frame));
  };

  const attachedCount = (): number =>
    [...sessions.values()].filter((session) => session.connection !== null).length;

  // ── Sign-in (Q7) ──────────────────────────────────────────────────────────
  const readSignIn = (): Promise<SignInStatus> => checkSignIn(options.env, options.stat);

  const sameState = (a: SignInStatus | null, b: SignInStatus): boolean =>
    a !== null && a.profile === b.profile && a.state === b.state;

  const pushSignIn = (status: SignInStatus, to: Iterable<Attachment>): void => {
    for (const attachment of to) {
      send(attachment, { t: 'signin', profile: status.profile, state: status.state });
    }
  };

  const attachedConnections = (): Attachment[] =>
    [...sessions.values()]
      .map((session) => session.connection)
      .filter((connection): connection is Attachment => connection !== null);

  const pollSignIn = async (): Promise<void> => {
    const status = await readSignIn();
    if (closing || sameState(lastSignIn, status)) return;
    lastSignIn = status;
    pushSignIn(status, attachedConnections());
  };

  const syncSignInTimer = (): void => {
    const wanted = attachedCount() > 0 && !closing;
    if (wanted && signInTimer === null) {
      signInTimer = setInterval(() => void pollSignIn(), signInIntervalMs);
      signInTimer.unref();
    } else if (!wanted && signInTimer !== null) {
      clearInterval(signInTimer);
      signInTimer = null;
    }
  };

  /** On attach: always tell this connection; tell the others only on a change. */
  const signInOnAttach = async (attachment: Attachment): Promise<void> => {
    const status = await readSignIn();
    if (closing) return;
    const changed = !sameState(lastSignIn, status);
    lastSignIn = status;
    const others = changed ? attachedConnections().filter((other) => other !== attachment) : [];
    pushSignIn(status, [attachment, ...others]);
  };

  // ── Sessions (Q5) ─────────────────────────────────────────────────────────
  const detach = (session: Session): void => {
    session.connection = null;
    session.detachedAt = now();
    session.detachSeq = ++detachCounter;
    syncSignInTimer();
  };

  const removeSession = (session: Session): void => {
    sessions.delete(session.id);
    syncSignInTimer();
  };

  const attach = (attachment: Attachment, session: Session, resumed: boolean): void => {
    const previous = session.connection;
    if (previous && previous !== attachment) {
      // One connection per session: the newer attach takes it over.
      previous.session = null;
      send(previous, { t: 'error', code: 'taken_over' });
      previous.ws.close(1000);
      log(`agent-terminal: session ${session.id} taken over`);
    }
    session.connection = attachment;
    session.detachedAt = null;
    attachment.session = session;
    send(attachment, { t: 'ready', session: session.id, resumed });
    if (resumed) {
      const replay = session.ring.snapshot();
      if (replay.length > 0) attachment.ws.send(replay);
    }
    log(`agent-terminal: session ${session.id} ${resumed ? 'resumed' : 'attached'}`);
    syncSignInTimer();
    void signInOnAttach(attachment);
  };

  const reapLongestDetached = (): boolean => {
    let victim: Session | null = null;
    for (const session of sessions.values()) {
      if (session.connection !== null || session.detachedAt === null) continue;
      if (
        victim === null ||
        session.detachedAt < (victim.detachedAt as number) ||
        (session.detachedAt === victim.detachedAt && session.detachSeq < victim.detachSeq)
      ) {
        victim = session;
      }
    }
    if (!victim) return false;
    removeSession(victim);
    victim.pty.kill();
    log(`agent-terminal: session ${victim.id} reaped (session limit)`);
    return true;
  };

  const openSession = (attachment: Attachment, cols: number, rows: number): void => {
    if (sessions.size >= maxSessions && !reapLongestDetached()) {
      send(attachment, { t: 'error', code: 'session_limit' });
      attachment.ws.close(1000);
      log('agent-terminal: open refused (session limit)');
      return;
    }
    let pty: PtyProcess;
    try {
      pty = options.spawnPty({
        file: 'bash',
        args: ['-l'],
        cols,
        rows,
        cwd: shellCwd(options.env),
        env: shellEnv(options.env),
      });
    } catch {
      // The error is not logged: its message is not ours to vouch for.
      log('agent-terminal: shell failed to start');
      attachment.ws.close(1011);
      return;
    }
    const session: Session = {
      id: randomUUID(),
      pty,
      ring: new OutputRing(replayBytes),
      connection: null,
      detachedAt: null,
      detachSeq: 0,
    };
    sessions.set(session.id, session);
    pty.onData((data) => {
      session.ring.push(data);
      if (session.connection) session.connection.ws.send(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (!sessions.has(session.id)) return;
      removeSession(session);
      const connection = session.connection;
      session.connection = null;
      if (connection) {
        connection.session = null;
        send(connection, { t: 'exit', code: exitCode, signal });
        connection.ws.close(1000);
      }
      log(`agent-terminal: session ${session.id} exited (code ${String(exitCode)})`);
    });
    log(`agent-terminal: session ${session.id} opened (pid ${pty.pid})`);
    attach(attachment, session, false);
  };

  const onOpenFrame = (
    attachment: Attachment,
    frame: { cols: number; rows: number; session?: string },
  ): void => {
    if (attachment.session) return; // already attached; one `open` per connection
    const wanted = frame.session ?? attachment.tokenSession;
    if (wanted === undefined) {
      openSession(attachment, frame.cols, frame.rows);
      return;
    }
    const session = sessions.get(wanted);
    if (!session || (attachment.tokenSession !== undefined && attachment.tokenSession !== wanted)) {
      // The connection stays open: the panel may `open` a fresh session on it.
      send(attachment, { t: 'error', code: 'unknown_session' });
      log('agent-terminal: resume refused (unknown session)');
      return;
    }
    attach(attachment, session, true);
    session.pty.resize(frame.cols, frame.rows);
  };

  const onMessage = (attachment: Attachment, data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      attachment.session?.pty.write(data);
      return;
    }
    const frame = parseClientFrame(data.toString('utf8'));
    if (!frame) return; // ignored, and never echoed or logged
    switch (frame.t) {
      case 'open':
        onOpenFrame(attachment, frame);
        return;
      case 'resize':
        attachment.session?.pty.resize(frame.cols, frame.rows);
        return;
      case 'ping':
        send(attachment, { t: 'pong' });
        return;
    }
  };

  // ── The upgrade: authenticate BEFORE anything else exists (Q3) ────────────
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const path = (req.url ?? '/').split('?')[0];
    if (path !== TERMINAL_PATH) {
      // `/v1/chat` is reserved for MOTIR-6863 and not served yet.
      refuseUpgrade(socket, 404, 'Not Found');
      if (path === CHAT_PATH) log('agent-terminal: upgrade refused (chat not served)');
      return;
    }
    if (!isWebSocketUpgrade(req)) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const verdict = verifyRelayAuthorization(req.headers.authorization, {
      instanceKey: options.instanceKey,
      instanceId: options.instanceId,
      machineId: options.machineId,
      nowSeconds: Math.floor(now() / 1000),
      nonces,
    });
    if (!verdict.ok) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      log(`agent-terminal: upgrade refused (${verdict.reason})`);
      return;
    }
    if (closing) {
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    const attachment: Attachment = { ws, session: null, tokenSession: verdict.payload.sessionId };
    connections.add(attachment);
    log('agent-terminal: connection opened');
    const openTimer = setTimeout(() => {
      if (!attachment.session) ws.close(1008);
    }, openTimeoutMs);
    openTimer.unref();
    ws.on('message', (data, isBinary) => onMessage(attachment, data, isBinary));
    ws.on('close', (code) => {
      clearTimeout(openTimer);
      connections.delete(attachment);
      const session = attachment.session;
      attachment.session = null;
      if (session && session.connection === attachment) {
        detach(session);
        log(`agent-terminal: session ${session.id} detached`);
      }
      log(`agent-terminal: connection closed (${code})`);
    });
  };

  const server = createServer((req, res) => {
    // Plain HTTP is not served. `426` on the terminal path says why.
    res.statusCode = req.url?.startsWith(TERMINAL_PATH) ? 426 : 404;
    res.end();
  });
  server.on('upgrade', onUpgrade);
  // A malformed request is dropped silently: its bytes are the client's.
  server.on('clientError', (_err, socket) => socket.destroy());

  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.port : port;
          log(`agent-terminal: listening on ${host}:${bound}`);
          resolve(bound);
        });
      });
    },
    async close() {
      closing = true;
      syncSignInTimer();
      for (const session of [...sessions.values()]) {
        sessions.delete(session.id);
        session.pty.kill();
      }
      for (const attachment of connections) attachment.ws.terminate();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    sessionCount: () => sessions.size,
  };
}
