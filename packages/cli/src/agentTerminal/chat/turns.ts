import { spawn as spawnChild } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SignInStatus } from '../signIn.js';
import {
  CHAT_ENV_ADDITIONS,
  HISTORY_BUDGET_BYTES,
  MAX_LISTED_SESSIONS,
  MAX_TITLE_CHARS,
  UNSUPPORTED,
  type ChatAdapter,
  type ChatContext,
  type ChatSupport,
  type TranscriptMapper,
} from './adapter.js';
import {
  boundEvent,
  encodeChatServerFrame,
  isSessionId,
  parseChatClientFrame,
  type ChatErrorCode,
  type ChatServerFrame,
  type ChatSessionSummary,
  type TranscriptEvent,
  type TurnFailCode,
} from './protocol.js';

// The chat turn runner (MOTIR-7012 · `docs/decisions/agent-chat.md` Q3, Q6,
// Q7, Q10, Q11): everything a chat needs AROUND an adapter, built once.
//
//   - ONE running turn per AGENT, not per session (Q6): a second `prompt`
//     anywhere on the agent while a turn runs is refused `turn_running`, because
//     two OpenCode turns do not fit a 512 MB machine.
//   - Before any turn, in Q6's order: the adapter's `support()`, then the
//     terminal's sign-in state (`signed_out` refuses, `unknown` passes), then
//     the per-agent limit. A refusal spawns nothing.
//   - `turn_end` is written HERE, from the process exit: `completed` (the
//     adapter's end marker and exit 0), `stopped` (a `stop` was received),
//     `failed` with a code otherwise — a crash, a non-zero exit, or a kill the
//     adapter asked for (Claude Code's `apiKeySource:"none"` backstop, Q2).
//   - Stop is SIGINT to the process group, then SIGKILL after 5 s.
//   - A dropped socket does not stop a turn. Its events are kept in a 256 KiB
//     ring; a re-`open` of that session gets `history`, then the ring, then
//     live events. A later `open` of a held session takes it over, and the
//     earlier socket receives `taken_over`.
//
// ⚠️ WHAT IS NEVER LOGGED (Q10). Log lines carry turn numbers, refusal codes,
// reasons and durations. Never a prompt, a transcript event, a tool output, a
// path, a session id or title, or an `Error` message built from any of them. The
// turn process's stdout goes to the mapper and nowhere else; its stderr is read
// and discarded.
//
// The process spawn, the adapter, the sign-in read and the log sink are
// injected, so the tests drive this module with a fake process.

/** Stop's grace between SIGINT and SIGKILL (Q6). */
export const STOP_GRACE_MS = 5_000;
/** The per-turn event ring (Q6): the terminal's replay size. */
export const TURN_RING_BYTES = 256 * 1024;
/** A stdout line longer than this is dropped rather than buffered without end. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** Q11: the vendor binary by its bare name, resolved on PATH — never a path or a shell line. */
const BARE_BINARY = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// ── The process seam ────────────────────────────────────────────────────────

export type ChatSignal = 'SIGINT' | 'SIGKILL';

export interface ChatProcessExit {
  code: number | null;
  signal: string | null;
  /** The binary could not be started at all (not on PATH, not executable). */
  failedToStart?: boolean;
}

export interface ChatProcess {
  readonly pid: number;
  /** The process's stdout. Its stderr never reaches the runner (Q10). */
  onStdout(listener: (chunk: Buffer) => void): void;
  /** Once, after stdout has drained. */
  onExit(listener: (exit: ChatProcessExit) => void): void;
  /** Signal the process GROUP, so a CLI's own children stop with it. */
  signal(signal: ChatSignal): void;
}

export interface ChatSpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin and closed; null leaves stdin closed. */
  stdin: string | null;
}

export type SpawnChat = (options: ChatSpawnOptions) => ChatProcess;

/**
 * The real spawn: the binary directly (no shell), as the leader of its own
 * process group so Stop reaches its children, stderr read and discarded.
 */
export const spawnChatProcess: SpawnChat = (options) => {
  const child = spawnChild(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [options.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  // Q10: kimi writes tool progress to stderr. It is drained, never forwarded.
  child.stderr?.resume();
  if (options.stdin !== null && child.stdin) {
    // A CLI that exits before reading its prompt is not an error of ours.
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin);
  }
  const listeners: ((exit: ChatProcessExit) => void)[] = [];
  let exited: ChatProcessExit | null = null;
  const finish = (exit: ChatProcessExit): void => {
    if (exited) return;
    exited = exit;
    for (const listener of listeners) listener(exit);
  };
  // The error (which may name the binary's path) is dropped, never logged.
  child.on('error', () => {
    finish({ code: null, signal: null, failedToStart: child.pid === undefined });
  });
  child.on('close', (code, signal) => finish({ code, signal }));
  return {
    pid: child.pid ?? -1,
    onStdout: (listener) => {
      child.stdout?.on('data', listener);
    },
    onExit: (listener) => {
      if (exited) listener(exited);
      else listeners.push(listener);
    },
    signal: (signal) => {
      if (child.pid === undefined || exited) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    },
  };
};

// ── The per-turn ring ───────────────────────────────────────────────────────

/** The encoded `event` frames of one running turn, oldest dropped past the bound. */
export class EventRing {
  private frames: string[] = [];
  private bytes = 0;

  constructor(private readonly capacity: number = TURN_RING_BYTES) {}

  get size(): number {
    return this.bytes;
  }

  push(frame: string): void {
    this.frames.push(frame);
    this.bytes += Buffer.byteLength(frame, 'utf8');
    while (this.bytes > this.capacity && this.frames.length > 0) {
      this.bytes -= Buffer.byteLength(this.frames.shift() as string, 'utf8');
    }
  }

  /** The held frames, oldest first. */
  snapshot(): string[] {
    return [...this.frames];
  }
}

// ── The hub ─────────────────────────────────────────────────────────────────

/** The one side of a WebSocket the chat writes to. */
export interface ChatSocket {
  readonly isOpen: boolean;
  send(text: string): void;
}

export interface ChatHubOptions {
  /** `MOTIR_SANDBOX_AGENT`, or null. */
  profile: string | null;
  /** The registered adapter for the profile; null answers `unsupported`. */
  adapter: ChatAdapter | null;
  ctx: ChatContext;
  spawn: SpawnChat;
  /** The terminal's sign-in check (`agent-terminal.md` Q7). */
  readSignIn: () => Promise<SignInStatus>;
  /** Lifecycle lines only. */
  log: (line: string) => void;
  /** Milliseconds since the epoch. */
  now?: () => number;
  stopGraceMs?: number;
  ringBytes?: number;
}

/** What the server feeds one accepted chat socket's traffic into. */
export interface ChatConnectionHandle {
  /** One message; `isBinary` frames are refused `bad_frame` (Q4: text only). */
  message(data: Buffer, isBinary: boolean): void;
  /** The socket closed. A running turn keeps running. */
  closed(): void;
}

export interface ChatHub {
  accept(socket: ChatSocket): ChatConnectionHandle;
  /** Push a sign-in change to every open chat socket. */
  pushSignIn(status: SignInStatus): void;
  /** The running turn's number, or null. */
  runningTurn(): number | null;
  connectionCount(): number;
  /** The server is closing: kill the running turn. */
  close(): void;
}

interface Connection {
  socket: ChatSocket;
  view: View | null;
  /** Frames are handled one at a time, in order, so `hello` is always first. */
  queue: Promise<void>;
}

/** One chat session, as the server holds it: a new chat, or a resumed one. */
interface View {
  /** The CLI's session id; null for a new chat until the stream reveals it. */
  sessionId: string | null;
  /** The socket that holds it, if any. */
  holder: Connection | null;
  /** False while a resume's history is being read: live events wait in the ring. */
  live: boolean;
  turn: Turn | null;
}

interface Turn {
  id: number;
  view: View;
  proc: ChatProcess | null;
  mapper: TranscriptMapper | null;
  ring: EventRing;
  startedAt: number;
  stopRequested: boolean;
  /** Set by an adapter-requested kill, or the server's shutdown. */
  failCode: TurnFailCode | null;
  killTimer: NodeJS.Timeout | null;
  ended: boolean;
}

/** Cut a title to Q7's bound, on a character (code point) boundary. */
function cutTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= MAX_TITLE_CHARS ? title : chars.slice(0, MAX_TITLE_CHARS).join('');
}

export function createChatHub(options: ChatHubOptions): ChatHub {
  const { adapter, ctx, log } = options;
  const now = options.now ?? Date.now;
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const ringBytes = options.ringBytes ?? TURN_RING_BYTES;
  const connections = new Set<Connection>();
  /** Views that carry a session id, by that id. */
  const views = new Map<string, View>();
  let current: Turn | null = null;
  let turnCounter = 0;
  let closing = false;

  const send = (connection: Connection, frame: ChatServerFrame): void => {
    if (connection.socket.isOpen) connection.socket.send(encodeChatServerFrame(frame));
  };

  const refuse = (connection: Connection, code: ChatErrorCode, what: string): void => {
    send(connection, { t: 'error', code });
    log(`agent-chat: ${what} refused (${code})`);
  };

  const support = async (): Promise<ChatSupport> => {
    if (!adapter) return UNSUPPORTED;
    try {
      return await adapter.support(ctx);
    } catch {
      // A probe that cannot answer is not a yes. Its error is not logged.
      return UNSUPPORTED;
    }
  };

  const readSignIn = async (): Promise<SignInStatus> => {
    try {
      return await options.readSignIn();
    } catch {
      return { profile: options.profile, state: 'unknown' };
    }
  };

  const forget = (view: View): void => {
    if (view.holder || view.turn || view.sessionId === null) return;
    if (views.get(view.sessionId) === view) views.delete(view.sessionId);
  };

  /** Detach a connection from its view; the view's turn keeps running. */
  const release = (connection: Connection): void => {
    const view = connection.view;
    connection.view = null;
    if (!view || view.holder !== connection) return;
    view.holder = null;
    view.live = false;
    forget(view);
  };

  // ── Events ───────────────────────────────────────────────────────────────
  const emit = (turn: Turn, event: TranscriptEvent): void => {
    const frame = encodeChatServerFrame({ t: 'event', turn: turn.id, e: boundEvent(event) });
    turn.ring.push(frame);
    const holder = turn.view.holder;
    if (holder && turn.view.live && holder.socket.isOpen) holder.socket.send(frame);
  };

  /** Q4's `session` frame, once the mapper knows the CLI's id. */
  const revealSession = (turn: Turn): void => {
    const view = turn.view;
    let id: string | null;
    try {
      id = turn.mapper?.sessionId() ?? null;
    } catch {
      id = null;
    }
    if (id === null || id === view.sessionId || !isSessionId(id)) return;
    if (view.sessionId !== null && views.get(view.sessionId) === view) views.delete(view.sessionId);
    view.sessionId = id;
    views.set(id, view);
    const holder = view.holder;
    if (holder && view.live) send(holder, { t: 'session', id });
  };

  const endTurn = (turn: Turn, exit: ChatProcessExit): void => {
    if (turn.ended) return;
    turn.ended = true;
    if (turn.killTimer) clearTimeout(turn.killTimer);
    turn.killTimer = null;
    let sawEnd = false;
    try {
      sawEnd = turn.mapper?.sawEnd() ?? false;
    } catch {
      sawEnd = false;
    }
    let end: TranscriptEvent;
    if (turn.stopRequested) {
      end = { k: 'turn_end', reason: 'stopped' };
    } else if (turn.failCode) {
      end = { k: 'turn_end', reason: 'failed', code: turn.failCode };
    } else if (exit.failedToStart) {
      end = { k: 'turn_end', reason: 'failed', code: 'spawn_failed' };
    } else if (exit.code === 0 && sawEnd) {
      end = { k: 'turn_end', reason: 'completed' };
    } else if (exit.code === 0) {
      end = { k: 'turn_end', reason: 'failed', code: 'no_end' };
    } else {
      end = { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' };
    }
    emit(turn, end);
    if (current === turn) current = null;
    const view = turn.view;
    if (view.turn === turn) view.turn = null;
    forget(view);
    const code = end.code ? ` ${end.code}` : '';
    log(`agent-chat: turn ${turn.id} ended (${end.reason}${code}, ${now() - turn.startedAt} ms)`);
  };

  const onLine = (turn: Turn, line: string): void => {
    if (turn.ended || !turn.mapper) return;
    let events: TranscriptEvent[];
    try {
      events = turn.mapper.onLine(line);
    } catch {
      // An adapter that cannot map a line drops it; the line is never logged.
      events = [];
    }
    revealSession(turn);
    for (const event of events) {
      // `turn_end` is the runner's to write (Q5), never an adapter's.
      if (event.k !== 'turn_end') emit(turn, event);
    }
    let killCode: ChatErrorCode | null = null;
    try {
      killCode = turn.mapper.killCode();
    } catch {
      killCode = null;
    }
    if (killCode && !turn.failCode) {
      turn.failCode = killCode;
      turn.proc?.signal('SIGKILL');
      log(`agent-chat: turn ${turn.id} killed by its adapter (${killCode})`);
    }
  };

  /** Q3/Q11: the command an adapter named, held to what Q11 allows. */
  const turnEnv = (additions: Record<string, string> | undefined): Record<string, string> => {
    const env: Record<string, string> = { ...ctx.env };
    for (const [name, value] of Object.entries(additions ?? {})) {
      if (!CHAT_ENV_ADDITIONS.has(name)) throw new Error('env addition refused');
      env[name] = value;
    }
    delete env['MOTIR_TERMINAL_KEY'];
    return env;
  };

  const startTurn = (view: View, prompt: string): void => {
    const turn: Turn = {
      id: ++turnCounter,
      view,
      proc: null,
      mapper: null,
      ring: new EventRing(ringBytes),
      startedAt: now(),
      stopRequested: false,
      failCode: null,
      killTimer: null,
      ended: false,
    };
    current = turn;
    view.turn = turn;
    emit(turn, { k: 'user', text: prompt });
    let proc: ChatProcess;
    try {
      const command = (adapter as ChatAdapter).turnCommand({
        prompt,
        sessionId: view.sessionId,
        ctx,
      });
      if (!BARE_BINARY.test(command.file)) throw new Error('binary refused');
      const env = turnEnv(command.env);
      turn.mapper = (adapter as ChatAdapter).createMapper();
      revealSession(turn);
      proc = options.spawn({
        file: command.file,
        args: [...command.args],
        cwd: ctx.cwd,
        env,
        stdin: command.stdin,
      });
    } catch {
      // The error is not logged: it may carry the prompt or a path.
      log(`agent-chat: turn ${turn.id} failed to start`);
      endTurn(turn, { code: null, signal: null, failedToStart: true });
      return;
    }
    turn.proc = proc;
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const feed = (text: string): void => {
      partial += text;
      let newline = partial.indexOf('\n');
      while (newline !== -1) {
        const line = partial.slice(0, newline).replace(/\r$/, '');
        partial = partial.slice(newline + 1);
        if (line.length > 0) onLine(turn, line);
        newline = partial.indexOf('\n');
      }
      if (partial.length > MAX_LINE_CHARS) partial = '';
    };
    proc.onStdout((chunk) => feed(decoder.write(chunk)));
    proc.onExit((exit) => {
      feed(decoder.end());
      if (partial.length > 0) onLine(turn, partial);
      partial = '';
      endTurn(turn, exit);
    });
    log(`agent-chat: turn ${turn.id} started (pid ${proc.pid})`);
    if (closing) {
      turn.failCode = 'shutdown';
      proc.signal('SIGKILL');
    }
  };

  // ── Frames ───────────────────────────────────────────────────────────────
  const hello = async (connection: Connection): Promise<void> => {
    const verdict = await support();
    const signIn = await readSignIn();
    send(connection, {
      t: 'hello',
      profile: options.profile,
      supported: verdict.supported,
      ...(verdict.supported ? {} : { reason: verdict.code }),
      signin: signIn.state,
    });
  };

  const onList = async (connection: Connection): Promise<void> => {
    if (!adapter) return refuse(connection, 'unsupported', 'list');
    let items: ChatSessionSummary[];
    try {
      items = await adapter.listSessions(ctx, MAX_LISTED_SESSIONS);
    } catch {
      // A store the adapter cannot read lists nothing. Its error is not logged.
      items = [];
    }
    send(connection, {
      t: 'sessions',
      items: items.slice(0, MAX_LISTED_SESSIONS).map((item) => ({
        id: item.id,
        title: cutTitle(item.title),
        updatedAt: item.updatedAt,
      })),
    });
  };

  const onOpen = async (connection: Connection, session: string | undefined): Promise<void> => {
    if (!adapter) return refuse(connection, 'unsupported', 'open');
    if (session !== undefined && !isSessionId(session)) {
      return refuse(connection, 'unknown_session', 'open');
    }
    release(connection);
    if (session === undefined) {
      const view: View = { sessionId: null, holder: connection, live: true, turn: null };
      connection.view = view;
      send(connection, { t: 'ready', session: null, resumed: false });
      log('agent-chat: chat opened');
      return;
    }
    let view = views.get(session);
    if (!view) {
      view = { sessionId: session, holder: null, live: false, turn: null };
      views.set(session, view);
    }
    const previous = view.holder;
    if (previous && previous !== connection) {
      // One socket per session: the later `open` takes it over (Q6).
      previous.view = null;
      send(previous, { t: 'error', code: 'taken_over' });
      log('agent-chat: chat taken over');
    }
    view.holder = connection;
    view.live = false;
    connection.view = view;
    send(connection, { t: 'ready', session, resumed: true });
    let history: Awaited<ReturnType<ChatAdapter['readHistory']>>;
    try {
      history = await adapter.readHistory(ctx, session, HISTORY_BUDGET_BYTES);
    } catch {
      history = { unavailable: true };
    }
    // Taken over (or released) while the store was being read: that socket owns it now.
    if (view.holder !== connection) return;
    // `unavailable` draws no earlier turns, and says there were some (Q7).
    send(
      connection,
      'unavailable' in history
        ? { t: 'history', events: [], truncated: true }
        : {
            t: 'history',
            events: history.events.map(boundEvent),
            truncated: history.truncated,
          },
    );
    // Then the running turn's ring, then live events (Q6).
    if (view.turn && connection.socket.isOpen) {
      for (const frame of view.turn.ring.snapshot()) connection.socket.send(frame);
    }
    view.live = true;
    log(`agent-chat: chat resumed${view.turn ? ` (turn ${view.turn.id} running)` : ''}`);
  };

  const onPrompt = async (connection: Connection, prompt: string): Promise<void> => {
    const view = connection.view;
    if (!view) return refuse(connection, 'bad_frame', 'prompt');
    // Q6's order: support, then the sign-in, then the per-agent limit.
    const verdict = await support();
    if (!verdict.supported) return refuse(connection, verdict.code, 'prompt');
    const signIn = await readSignIn();
    if (signIn.state === 'signed_out') return refuse(connection, 'not_signed_in', 'prompt');
    if (current) return refuse(connection, 'turn_running', 'prompt');
    // Checked after the awaits, synchronously with the spawn, so two sockets
    // prompting at once cannot both pass the limit.
    if (closing || connection.view !== view) return;
    startTurn(view, prompt);
  };

  const onStop = (connection: Connection): void => {
    const turn = current;
    if (!turn || turn.ended || turn.view !== connection.view || !turn.proc) {
      return refuse(connection, 'no_turn', 'stop');
    }
    if (turn.stopRequested) return;
    turn.stopRequested = true;
    log(`agent-chat: turn ${turn.id} stopping`);
    turn.proc.signal('SIGINT');
    const proc = turn.proc;
    turn.killTimer = setTimeout(() => {
      turn.killTimer = null;
      if (turn.ended) return;
      proc.signal('SIGKILL');
      log(`agent-chat: turn ${turn.id} killed (stop grace elapsed)`);
    }, stopGraceMs);
    turn.killTimer.unref();
  };

  const enqueue = (connection: Connection, task: () => Promise<void> | void): void => {
    connection.queue = connection.queue
      .then(task)
      .catch(() => log('agent-chat: frame handling failed'));
  };

  return {
    accept(socket) {
      const connection: Connection = { socket, view: null, queue: Promise.resolve() };
      connections.add(connection);
      log('agent-chat: connection opened');
      enqueue(connection, () => hello(connection));
      return {
        message(data, isBinary) {
          const parsed = isBinary
            ? ({ ok: false, code: 'bad_frame' } as const)
            : parseChatClientFrame(data.toString('utf8'));
          if (!parsed.ok) {
            // Refused by code; the frame itself is never echoed or logged.
            enqueue(connection, () => refuse(connection, parsed.code, 'frame'));
            return;
          }
          const frame = parsed.frame;
          switch (frame.t) {
            case 'ping':
              enqueue(connection, () => send(connection, { t: 'pong' }));
              return;
            case 'list':
              enqueue(connection, () => onList(connection));
              return;
            case 'open':
              enqueue(connection, () => onOpen(connection, frame.session));
              return;
            case 'prompt':
              enqueue(connection, () => onPrompt(connection, frame.text));
              return;
            case 'stop':
              enqueue(connection, () => onStop(connection));
              return;
          }
        },
        closed() {
          connections.delete(connection);
          release(connection);
        },
      };
    },
    pushSignIn(status) {
      for (const connection of connections) {
        send(connection, { t: 'signin', profile: status.profile, state: status.state });
      }
    },
    runningTurn: () => current?.id ?? null,
    connectionCount: () => connections.size,
    close() {
      closing = true;
      const turn = current;
      if (turn && !turn.ended) {
        turn.failCode ??= 'shutdown';
        if (turn.killTimer) clearTimeout(turn.killTimer);
        turn.killTimer = null;
        turn.proc?.signal('SIGKILL');
      }
      connections.clear();
    },
  };
}
