import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

// THE AGENT TERMINAL'S SOCKET (Story MOTIR-6861 · MOTIR-6941) — the client side of
// `docs/decisions/agent-terminal.md` Q3–Q6, as ONE state machine: connect,
// reconnect and close live here, and the panel's terminal faces derive from the
// single `conn` value it returns rather than from several flags.
//
//   ticket  POST …/instances/:id/terminal-ticket → { url, ticket, expiresAt }
//           refusals in words: not_owner (403) · not_running (409) · no_terminal_server (409)
//   socket  wss `url`; first frame {"t":"auth","ticket"}, then {"t":"open","cols","rows","session"?}
//   close   4401 stale ticket (one silent retry) · 4403 not yours · 4409 not running
//           · 4410 no terminal server · 4502 the machine did not answer (reconnect loop)
//
// ⚠️ NO TERMINAL BYTE LEAVES THIS MODULE EXCEPT TO THE TERMINAL AND THE SOCKET
// (Q8). Nothing here logs, reports or stores a frame: the ONLY thing written to
// browser storage is the session id (Q5, `sessionStorage`, per tab), which is the
// reconnect token and carries no content.

/** Q6: the heartbeat, which also keeps both hops inside any proxy idle timeout. */
export const TERMINAL_PING_MS = 20_000;
/** The reconnect window (design panel 5: "about a minute of backing off"). */
export const TERMINAL_RECONNECT_WINDOW_MS = 60_000;
/** Backoff between attempts: 1 s, doubling, capped here. */
export const TERMINAL_RETRY_CAP_MS = 10_000;

export type SignInState = 'signed_in' | 'signed_out' | 'unknown';

export interface TerminalSignIn {
  profile: string | null;
  state: SignInState;
}

/** Every state the terminal tab can be in. */
export type TerminalConn =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting' }
  | { kind: 'lost'; machine: boolean }
  | { kind: 'exited' }
  | { kind: 'takenOver' }
  | { kind: 'sessionLimit' }
  | { kind: 'noTerminal' }
  | { kind: 'notAvailable' }
  | { kind: 'notRunning' };

/** Where the socket's bytes go, and the size the PTY should have. */
export interface TerminalSink {
  write(bytes: Uint8Array): void;
  /** Clear the screen before a (re)attach, so a replay redraws it rather than repeats it. */
  reset(): void;
  size(): { cols: number; rows: number };
}

/** The per-tab key the session id is kept under (Q5). */
export function terminalSessionKey(agentId: string): string {
  return `motir:agent-terminal:session:${agentId}`;
}

function readSession(agentId: string): string | null {
  try {
    return window.sessionStorage.getItem(terminalSessionKey(agentId));
  } catch {
    return null;
  }
}

function writeSession(agentId: string, session: string | null): void {
  try {
    if (session) window.sessionStorage.setItem(terminalSessionKey(agentId), session);
    else window.sessionStorage.removeItem(terminalSessionKey(agentId));
  } catch {
    // Storage blocked: the shell still works, it just won't reattach on reload.
  }
}

/** A state the socket stays in until the reader acts: its close is not a drop. */
const SETTLED: ReadonlySet<TerminalConn['kind']> = new Set([
  'exited',
  'takenOver',
  'sessionLimit',
  'noTerminal',
  'notAvailable',
  'notRunning',
  'lost',
]);

export function useAgentTerminal({
  projectKey,
  agentId,
  enabled,
  sink,
}: {
  projectKey: string;
  agentId: string;
  /** The agent reads `running` and its image serves a terminal. */
  enabled: boolean;
  sink: RefObject<TerminalSink | null>;
}) {
  const [conn, setConnState] = useState<TerminalConn>({ kind: 'idle' });
  const [signIn, setSignIn] = useState<TerminalSignIn | null>(null);
  /** Has this panel shown the shell at least once? (The connecting face covers a blank terminal only.) */
  const [everLive, setEverLive] = useState(false);
  const connRef = useRef<TerminalConn>(conn);
  const ws = useRef<WebSocket | null>(null);
  const epoch = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const windowStart = useRef<number | null>(null);
  const attempt = useRef(0);
  const staleRetried = useRef(false);
  const lastCloseCode = useRef<number | null>(null);
  const wasLive = useRef(false);
  const ticketUrl = `/api/projects/${encodeURIComponent(projectKey)}/instances/${encodeURIComponent(
    agentId,
  )}/terminal-ticket`;

  const setConn = useCallback((next: TerminalConn) => {
    connRef.current = next;
    setConnState(next);
  }, []);

  /** Drop the socket and every timer; handlers of the old socket go inert. */
  const teardown = useCallback(() => {
    epoch.current += 1;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);
    retryTimer.current = null;
    pingTimer.current = null;
    const socket = ws.current;
    ws.current = null;
    if (socket && socket.readyState <= 1) {
      try {
        socket.close(1000);
      } catch {
        // already closing
      }
    }
  }, []);

  const connectRef = useRef<() => void>(() => {});

  const scheduleRetry = useCallback(() => {
    const now = Date.now();
    if (windowStart.current === null) windowStart.current = now;
    if (now - windowStart.current >= TERMINAL_RECONNECT_WINDOW_MS) {
      setConn({ kind: 'lost', machine: lastCloseCode.current === 4502 });
      return;
    }
    setConn(wasLive.current ? { kind: 'reconnecting' } : { kind: 'connecting' });
    const delay = Math.min(1_000 * 2 ** attempt.current, TERMINAL_RETRY_CAP_MS);
    attempt.current += 1;
    retryTimer.current = setTimeout(() => connectRef.current(), delay);
  }, [setConn]);

  const sendJson = (socket: WebSocket, frame: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  const openFrame = useCallback(
    (fresh: boolean): Record<string, unknown> => {
      const { cols, rows } = sink.current?.size() ?? { cols: 80, rows: 24 };
      const session = fresh ? null : readSession(agentId);
      return session ? { t: 'open', cols, rows, session } : { t: 'open', cols, rows };
    },
    [agentId, sink],
  );

  const onControl = useCallback(
    (socket: WebSocket, frame: Record<string, unknown>) => {
      switch (frame['t']) {
        case 'ready': {
          if (typeof frame['session'] === 'string') writeSession(agentId, frame['session']);
          // Fresh or resumed, the screen starts clean: a resume's replay follows
          // as binary and redraws it (Q5).
          sink.current?.reset();
          windowStart.current = null;
          attempt.current = 0;
          staleRetried.current = false;
          lastCloseCode.current = null;
          wasLive.current = true;
          setEverLive(true);
          setConn({ kind: 'live' });
          if (pingTimer.current) clearInterval(pingTimer.current);
          pingTimer.current = setInterval(() => {
            sendJson(socket, {
              t: 'ping',
              active: typeof document === 'undefined' || document.visibilityState === 'visible',
            });
          }, TERMINAL_PING_MS);
          return;
        }
        case 'signin': {
          const state = frame['state'];
          if (state === 'signed_in' || state === 'signed_out' || state === 'unknown') {
            setSignIn({
              profile: typeof frame['profile'] === 'string' ? frame['profile'] : null,
              state,
            });
          }
          return;
        }
        case 'exit':
          writeSession(agentId, null);
          setConn({ kind: 'exited' });
          return;
        case 'error':
          if (frame['code'] === 'unknown_session') {
            // The shell is gone (a wake is a cold boot): open a fresh one on the
            // same connection, with no words.
            writeSession(agentId, null);
            sendJson(socket, openFrame(true));
          } else if (frame['code'] === 'taken_over') {
            setConn({ kind: 'takenOver' });
          } else if (frame['code'] === 'session_limit') {
            setConn({ kind: 'sessionLimit' });
          }
          return;
        default:
          return;
      }
    },
    [agentId, openFrame, setConn, sink],
  );

  const onClosed = useCallback(
    (code: number) => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = null;
      ws.current = null;
      if (SETTLED.has(connRef.current.kind)) return;
      switch (code) {
        case 4401:
          // A stale ticket: mint a new one and retry once, silently.
          if (!staleRetried.current) {
            staleRetried.current = true;
            connectRef.current();
          } else {
            setConn({ kind: 'lost', machine: false });
          }
          return;
        case 4403:
          setConn({ kind: 'notAvailable' });
          return;
        case 4409:
          setConn({ kind: 'notRunning' });
          return;
        case 4410:
          setConn({ kind: 'noTerminal' });
          return;
        default:
          lastCloseCode.current = code;
          scheduleRetry();
      }
    },
    [scheduleRetry, setConn],
  );

  const connect = useCallback(
    async (fresh = false) => {
      teardown();
      const mine = epoch.current;
      if (fresh) writeSession(agentId, null);
      let res: Response;
      try {
        res = await fetch(ticketUrl, { method: 'POST', cache: 'no-store' });
      } catch {
        if (mine === epoch.current) scheduleRetry();
        return;
      }
      if (mine !== epoch.current) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        if (mine !== epoch.current) return;
        if (res.status === 403 || res.status === 404) setConn({ kind: 'notAvailable' });
        else if (body?.code === 'no_terminal_server') setConn({ kind: 'noTerminal' });
        else if (body?.code === 'not_running') setConn({ kind: 'notRunning' });
        else scheduleRetry();
        return;
      }
      const grant = (await res.json().catch(() => null)) as {
        url?: string;
        ticket?: string;
      } | null;
      if (mine !== epoch.current) return;
      if (!grant?.url || !grant.ticket) {
        scheduleRetry();
        return;
      }
      const ticket = grant.ticket;
      let socket: WebSocket;
      try {
        socket = new WebSocket(grant.url);
      } catch {
        scheduleRetry();
        return;
      }
      socket.binaryType = 'arraybuffer';
      ws.current = socket;
      socket.onopen = () => {
        if (mine !== epoch.current) return;
        // The ticket rides the first frame, never the URL (Q3).
        sendJson(socket, { t: 'auth', ticket });
        sendJson(socket, openFrame(fresh));
      };
      socket.onmessage = (event: MessageEvent) => {
        if (mine !== epoch.current) return;
        const data: unknown = event.data;
        if (typeof data === 'string') {
          let frame: unknown;
          try {
            frame = JSON.parse(data);
          } catch {
            return;
          }
          if (frame && typeof frame === 'object') {
            onControl(socket, frame as Record<string, unknown>);
          }
          return;
        }
        if (data instanceof ArrayBuffer) sink.current?.write(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) {
          sink.current?.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
      };
      socket.onclose = (event: CloseEvent) => {
        if (mine !== epoch.current) return;
        onClosed(event.code);
      };
    },
    [agentId, onClosed, onControl, openFrame, scheduleRetry, setConn, sink, teardown, ticketUrl],
  );

  useEffect(() => {
    connectRef.current = () => void connect(false);
  }, [connect]);

  /** Start over from the reader's click: a fresh window, a fresh ticket. */
  const restart = useCallback(
    (fresh: boolean) => {
      windowStart.current = null;
      attempt.current = 0;
      staleRetried.current = false;
      lastCloseCode.current = null;
      if (fresh) sink.current?.reset();
      setConn({ kind: 'connecting' });
      void connect(fresh);
    },
    [connect, setConn, sink],
  );

  /** The agent stopped being reachable: no socket, no sign-in (none before a connect, Q7). */
  const stop = useCallback(() => {
    teardown();
    wasLive.current = false;
    setSignIn(null);
    setConn({ kind: 'idle' });
  }, [setConn, teardown]);

  useEffect(() => {
    if (!enabled) {
      // Synchronising with the socket (an external system): the agent stopped
      // being reachable, so the socket closes and the tab reads idle.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      stop();
      return;
    }
    wasLive.current = false;
    restart(false);
    return teardown;
    // `restart` changes with the agent; `enabled` flipping is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, agentId]);

  // Closing the panel closes the socket.
  useEffect(() => teardown, [teardown]);

  const sendInput = useCallback((data: string) => {
    const socket = ws.current;
    if (!socket || socket.readyState !== 1 || connRef.current.kind !== 'live') return;
    socket.send(new TextEncoder().encode(data));
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const socket = ws.current;
    if (!socket || connRef.current.kind !== 'live') return;
    sendJson(socket, { t: 'resize', cols, rows });
  }, []);

  return {
    conn,
    signIn,
    everLive,
    sendInput,
    sendResize,
    /** Lost / 4502 / taken over / session limit: the same shell, a new ticket. */
    reconnect: () => restart(false),
    /** Exited: a new shell. */
    newShell: () => restart(true),
  };
}
