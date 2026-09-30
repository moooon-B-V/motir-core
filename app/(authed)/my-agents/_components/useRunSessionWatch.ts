import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  TERMINAL_PING_MS,
  TERMINAL_RECONNECT_WINDOW_MS,
  TERMINAL_RETRY_CAP_MS,
  type TerminalSink,
} from './useAgentTerminal';

// WATCHING THE RUN'S SESSION (Story MOTIR-6864 · MOTIR-7029;
// `design/my-agents/design-notes.md` § _The agent's live run_, panels 1 and 3).
//
// The terminal server lists the run session to every connection that attaches
// (`docs/decisions/agent-instance-run.md` §1), and ONE connection answers ONE
// session (`agent-terminal.md` Q4: one `open` per connection). So watching the
// run is a SECOND socket beside the developer's own shell — through the SAME
// ticket route and relay the shell uses (`POST …/terminal-ticket`), opening the
// session id the server listed. The shell's socket is never touched: switching
// back to "Your shell" is instant, and nothing about it is re-attached.
//
// The run session is WATCH-ONLY: the server drops every input frame, so this
// hook sends none — only `open`, `resize` and the heartbeat.
//
// ⚠️ NO TERMINAL BYTE LEAVES THIS MODULE EXCEPT TO THE TERMINAL (Q8). Nothing is
// logged, reported or stored — not even the session id, which is the server's
// listing and not this tab's to keep.

/** Every state the watch can be in. */
export type RunWatchConn =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  /** The run's session exited (the run ended), or the server no longer knows it. */
  | { kind: 'ended' }
  /** Another tab is watching the run now. */
  | { kind: 'takenOver' }
  /** The watch could not be (re)opened: the panel returns to the shell. */
  | { kind: 'lost' };

const SETTLED: ReadonlySet<RunWatchConn['kind']> = new Set(['ended', 'takenOver', 'lost']);

export function useRunSessionWatch({
  projectKey,
  agentId,
  session,
  sink,
}: {
  projectKey: string;
  agentId: string;
  /** The run session to watch, as the server listed it; null to watch nothing. */
  session: string | null;
  sink: RefObject<TerminalSink | null>;
}) {
  const [conn, setConnState] = useState<RunWatchConn>({ kind: 'idle' });
  const connRef = useRef<RunWatchConn>(conn);
  const ws = useRef<WebSocket | null>(null);
  const epoch = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const windowStart = useRef<number | null>(null);
  const attempt = useRef(0);
  const staleRetried = useRef(false);
  const ticketUrl = `/api/projects/${encodeURIComponent(projectKey)}/instances/${encodeURIComponent(
    agentId,
  )}/terminal-ticket`;

  const setConn = useCallback((next: RunWatchConn) => {
    connRef.current = next;
    setConnState(next);
  }, []);

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
      setConn({ kind: 'lost' });
      return;
    }
    setConn({ kind: 'connecting' });
    const delay = Math.min(1_000 * 2 ** attempt.current, TERMINAL_RETRY_CAP_MS);
    attempt.current += 1;
    retryTimer.current = setTimeout(() => connectRef.current(), delay);
  }, [setConn]);

  const connect = useCallback(
    async (target: string) => {
      teardown();
      const mine = epoch.current;
      let res: Response;
      try {
        res = await fetch(ticketUrl, { method: 'POST', cache: 'no-store' });
      } catch {
        if (mine === epoch.current) scheduleRetry();
        return;
      }
      if (mine !== epoch.current) return;
      if (!res.ok) {
        // Not yours, not running, no terminal: the shell's own socket says which,
        // in its own words. The watch simply stops.
        setConn({ kind: 'lost' });
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
      const sendJson = (frame: Record<string, unknown>) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(frame));
      };
      socket.onopen = () => {
        if (mine !== epoch.current) return;
        const { cols, rows } = sink.current?.size() ?? { cols: 80, rows: 24 };
        // The ticket rides the first frame, never the URL (Q3); then the run's session.
        sendJson({ t: 'auth', ticket });
        sendJson({ t: 'open', cols, rows, session: target });
      };
      socket.onmessage = (event: MessageEvent) => {
        if (mine !== epoch.current) return;
        const data: unknown = event.data;
        if (typeof data !== 'string') {
          if (data instanceof ArrayBuffer) sink.current?.write(new Uint8Array(data));
          else if (ArrayBuffer.isView(data)) {
            sink.current?.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          }
          return;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (frame?.['t']) {
          case 'ready':
            // The replay (up to 256 KiB) follows as binary and redraws the screen.
            sink.current?.reset();
            windowStart.current = null;
            attempt.current = 0;
            staleRetried.current = false;
            setConn({ kind: 'live' });
            if (pingTimer.current) clearInterval(pingTimer.current);
            pingTimer.current = setInterval(() => {
              sendJson({
                t: 'ping',
                active: typeof document === 'undefined' || document.visibilityState === 'visible',
              });
            }, TERMINAL_PING_MS);
            return;
          case 'exit':
            setConn({ kind: 'ended' });
            return;
          case 'error':
            // `unknown_session`: the run's session is already gone — it ended.
            if (frame['code'] === 'unknown_session') setConn({ kind: 'ended' });
            else if (frame['code'] === 'taken_over') setConn({ kind: 'takenOver' });
            return;
          default:
            // `sessions` and `signin` belong to the shell's socket, which has them too.
            return;
        }
      };
      socket.onclose = (event: CloseEvent) => {
        if (mine !== epoch.current) return;
        if (pingTimer.current) clearInterval(pingTimer.current);
        pingTimer.current = null;
        ws.current = null;
        if (SETTLED.has(connRef.current.kind)) return;
        if (event.code === 4401 && !staleRetried.current) {
          // A stale ticket: mint a new one and retry once, silently.
          staleRetried.current = true;
          connectRef.current();
          return;
        }
        if (
          event.code === 4401 ||
          event.code === 4403 ||
          event.code === 4409 ||
          event.code === 4410
        ) {
          setConn({ kind: 'lost' });
          return;
        }
        scheduleRetry();
      };
    },
    [scheduleRetry, setConn, sink, teardown, ticketUrl],
  );

  useEffect(() => {
    if (session === null) {
      teardown();
      // Synchronising with the socket (an external system): nothing is watched.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConn({ kind: 'idle' });
      return;
    }
    connectRef.current = () => void connect(session);
    windowStart.current = null;
    attempt.current = 0;
    staleRetried.current = false;
    setConn({ kind: 'connecting' });
    void connect(session);
    return teardown;
  }, [session, connect, setConn, teardown]);

  const sendResize = useCallback((cols: number, rows: number) => {
    const socket = ws.current;
    if (!socket || socket.readyState !== 1 || connRef.current.kind !== 'live') return;
    socket.send(JSON.stringify({ t: 'resize', cols, rows }));
  }, []);

  /** Taken over by another tab: take it back here, on a new ticket. */
  const retake = useCallback(() => {
    if (session === null) return;
    windowStart.current = null;
    attempt.current = 0;
    staleRetried.current = false;
    setConn({ kind: 'connecting' });
    void connect(session);
  }, [connect, session, setConn]);

  return { conn, sendResize, retake };
}
