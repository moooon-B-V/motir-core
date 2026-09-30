import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  TERMINAL_AUTH_TIMEOUT_MS,
  TERMINAL_CLOSE,
  TERMINAL_HEARTBEAT_INTERVAL_MS,
  TERMINAL_PATH,
  TERMINAL_PING_INTERVAL_MS,
  type AgentTerminalCloseReason,
} from '@/lib/agentTerminal/protocol';
import type {
  AgentTerminalAuthorization,
  AgentTerminalConnectionTarget,
} from '@/lib/services/agentTerminalRelayService';
import { ActivityThrottle } from './activityThrottle';
import { scrubbedError } from './monitoring';

// THE TERMINAL RELAY (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q1, Q2, Q3, Q6, Q8) — browser ↔ relay ↔ the
// one agent machine's terminal server, as a thin transport over
// `agentTerminalService` (every database question is the service's).
//
// ONE CONNECTION, IN ORDER:
//   1. The upgrade at `/v1/terminal`; anything else is a 404. `Origin` must be
//      `MOTIR_BASE_URL`'s origin, else close 4403.
//   2. The FIRST frame, within 5 s, must be text `{"t":"auth","ticket"}` — else
//      close 4401. The ticket travels in a frame, never the URL (access logs).
//   3. `authorize(ticket)` redeems it (single use) and re-reads the instance →
//      4401 / 4403 / 4409 / 4410, or where to dial with a signed relay token.
//   4. One `agent_terminal_connection` row opens; the relay dials the machine
//      (`wss://<app>.fly.dev/v1/terminal` + `fly-force-instance-id` on Fly; a
//      local address on the fake). No answer → 4502.
//   5. Frames go both ways UNCHANGED. The relay parses only small TEXT frames
//      from the browser (to drop a repeated `auth` and read `ping.active`), and
//      NEVER inspects a binary frame — it only notices that one passed.
//   6. Activity (Q6): `touchActivity` on open, on close, on any binary frame in
//      either direction and on `{"t":"ping","active":true}` — through one
//      in-memory throttle, at most once a minute per instance per process.
//   7. Protocol pings to both sides every 20 s; a peer that misses one is gone.
//   8. Either side closing closes the other; the row is closed with the
//      browser's close code and the relay's reason. Nothing else is kept.
//
// LIVENESS (MOTIR-6959): ONE timer per relay process — not per connection —
// hands `heartbeat` the rows this relay holds open, about once a minute, so
// their `lastSeenAt` moves. A relay killed without shutting down stops moving
// them, and `system.agent-instance-sweep` closes them `relay_lost`.
//
// ⚠️ WHAT IS NEVER LOGGED OR REPORTED (Q8): a frame, a ticket, a token. Log
// lines carry ids, codes and durations only, and every reported error is
// rebuilt by `scrubbedError` from a fixed context and the original's NAME.

export interface TerminalRelayDeps {
  /** The one Origin a browser may connect from — `MOTIR_BASE_URL`'s origin. */
  allowedOrigin: string;
  authorize(ticket: string): Promise<AgentTerminalAuthorization>;
  openConnection(input: {
    workspaceId: string;
    instanceId: string;
    userId: string;
  }): Promise<string>;
  closeConnection(input: {
    id: string;
    workspaceId: string;
    closeCode: number;
    closeReason: AgentTerminalCloseReason;
  }): Promise<void>;
  touchActivity(instanceId: string): Promise<void>;
  /**
   * Refresh `lastSeenAt` on the rows this relay holds open (MOTIR-6959). Called
   * by one per-process timer, never with an empty list.
   */
  heartbeat(connections: { id: string; workspaceId: string }[]): Promise<void>;
  /** A lifecycle line (ids only). */
  log(line: string): void;
  /** Report an unexpected failure (already scrubbed). */
  reportError(err: Error): void;
  /** Milliseconds; the throttle's clock. */
  now(): number;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  throttleMs?: number;
  /** How long the dial to the machine may take before 4502. */
  dialTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export interface TerminalRelay {
  readonly server: http.Server;
  /** Connections currently held — for tests and the shutdown log. */
  readonly liveConnections: number;
  /** Close every connection (`relay_shutdown`), record each, stop listening. */
  close(): Promise<void>;
}

/** A browser frame larger than this is a protocol error (keystrokes and pastes fit easily). */
const MAX_BROWSER_FRAME_BYTES = 4 * 1024 * 1024;
/** Frames the browser may send while the machine is being dialled. */
const MAX_PENDING_FRAMES = 256;
/** Only a text frame this small is ever parsed; larger text is forwarded unread. */
const MAX_PARSED_TEXT_BYTES = 4 * 1024;
const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

/** Close codes a peer may SEND (RFC 6455 §7.4): not 1005, 1006, 1015. */
function sendableCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

/** A small JSON control frame, or null. Never logged, never thrown with. */
function parseControl(data: RawData): { t?: unknown; ticket?: unknown; active?: unknown } | null {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  if (buffer.length > MAX_PARSED_TEXT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { t?: unknown })
      : null;
  } catch {
    return null;
  }
}

function originMatches(origin: string | undefined, allowed: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(allowed).origin;
  } catch {
    return false;
  }
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createTerminalRelay(deps: TerminalRelayDeps): TerminalRelay {
  const authTimeoutMs = deps.authTimeoutMs ?? TERMINAL_AUTH_TIMEOUT_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? TERMINAL_PING_INTERVAL_MS;
  const dialTimeoutMs = deps.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
  const throttle = new ActivityThrottle(deps.now, deps.throttleMs);
  const live = new Map<string, (code: number, reason: AgentTerminalCloseReason) => Promise<void>>();
  /** Close records still being written — a shutdown waits for them. */
  const recording = new Set<Promise<void>>();
  /** The rows this relay holds open, by connection — what the heartbeat refreshes. */
  const openRows = new Map<string, { id: string; workspaceId: string }>();

  let heartbeating = false;
  const heartbeatTimer = setInterval(() => {
    // One write at a time: a slow database must not stack heartbeats.
    if (heartbeating || openRows.size === 0) return;
    heartbeating = true;
    deps
      .heartbeat([...openRows.values()])
      .catch((err: unknown) => {
        deps.reportError(scrubbedError('relay: heartbeat failed', err));
      })
      .finally(() => {
        heartbeating = false;
      });
  }, deps.heartbeatIntervalMs ?? TERMINAL_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BROWSER_FRAME_BYTES,
    perMessageDeflate: false,
  });

  const server = http.createServer((req, res) => {
    // Fly's health check, and nothing else: the relay serves no page.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      path = '';
    }
    if (path !== TERMINAL_PATH) {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req.headers.origin));
  });

  function bump(instanceId: string): void {
    if (!throttle.take(instanceId)) return;
    deps.touchActivity(instanceId).catch((err: unknown) => {
      deps.reportError(scrubbedError('relay: touchActivity failed', err));
    });
  }

  function handleConnection(browser: WebSocket, origin: string | undefined): void {
    const conn = randomUUID().slice(0, 8);
    const startedAt = deps.now();

    if (!originMatches(origin, deps.allowedOrigin)) {
      deps.log(`relay: connection ${conn} refused code=${TERMINAL_CLOSE.notOwner} (origin)`);
      browser.close(TERMINAL_CLOSE.notOwner);
      return;
    }

    let phase: 'auth' | 'authorizing' | 'dialing' | 'open' | 'closed' = 'auth';
    let target: AgentTerminalConnectionTarget | null = null;
    let rowId: Promise<string | null> | null = null;
    let upstream: WebSocket | null = null;
    const pending: { data: RawData; isBinary: boolean }[] = [];
    const alive = { browser: true, upstream: true };
    let settled: Promise<void> = Promise.resolve();

    const authTimer = setTimeout(() => {
      if (phase === 'auth') refuse(TERMINAL_CLOSE.badTicket, 'no auth frame');
    }, authTimeoutMs);

    const pingTimer = setInterval(() => {
      if (!alive.browser) return void finish(1001, 'ping_timeout');
      if (upstream && phase === 'open' && !alive.upstream) {
        return void finish(TERMINAL_CLOSE.unreachable, 'ping_timeout');
      }
      alive.browser = false;
      browser.ping();
      if (upstream && phase === 'open') {
        alive.upstream = false;
        upstream.ping();
      }
    }, pingIntervalMs);

    function stopTimers(): void {
      clearTimeout(authTimer);
      clearInterval(pingTimer);
    }

    /** A refusal before any connection row exists: close, log, done. */
    function refuse(code: number, why: string): void {
      if (phase === 'closed') return;
      phase = 'closed';
      stopTimers();
      if (browser.readyState === WebSocket.OPEN) browser.close(code);
      deps.log(`relay: connection ${conn} refused code=${code} (${why})`);
    }

    /** Close both sides once, then record the close and bump activity one last time. */
    function finish(code: number, reason: AgentTerminalCloseReason): Promise<void> {
      if (phase === 'closed') return settled;
      phase = 'closed';
      stopTimers();
      live.delete(conn);
      openRows.delete(conn);
      if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
        browser.close(sendableCode(code) ? code : 1011);
      }
      if (upstream) {
        upstream.removeAllListeners('message');
        if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
        else upstream.terminate();
      }
      const t = target;
      if (!t) return settled;
      bump(t.instanceId);
      deps.log(
        `relay: connection ${conn} closed instance=${t.instanceId} code=${code} reason=${reason} durationMs=${deps.now() - startedAt}`,
      );
      const opened = rowId;
      settled = (async () => {
        const id = opened ? await opened : null;
        if (!id) return;
        await deps
          .closeConnection({ id, workspaceId: t.workspaceId, closeCode: code, closeReason: reason })
          .catch((err: unknown) => {
            deps.reportError(scrubbedError('relay: recording a close failed', err));
          });
      })();
      const pendingRecord = settled;
      recording.add(pendingRecord);
      void pendingRecord.finally(() => recording.delete(pendingRecord));
      return settled;
    }

    function forwardToUpstream(data: RawData, isBinary: boolean): void {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    }

    browser.on('pong', () => {
      alive.browser = true;
    });

    browser.on('message', (data, isBinary) => {
      if (phase === 'closed') return;
      if (phase === 'auth') {
        const frame = isBinary ? null : parseControl(data);
        if (!frame || frame.t !== 'auth' || typeof frame.ticket !== 'string') {
          refuse(TERMINAL_CLOSE.badTicket, 'first frame is not auth');
          return;
        }
        clearTimeout(authTimer);
        phase = 'authorizing';
        void authorizeAndDial(frame.ticket);
        return;
      }
      const instanceId = target?.instanceId;
      if (isBinary) {
        if (instanceId) bump(instanceId);
      } else {
        const frame = parseControl(data);
        if (frame?.t === 'auth') return; // consumed by the relay (Q4's table); never forwarded
        if (frame?.t === 'ping' && frame.active === true && instanceId) bump(instanceId);
      }
      if (phase === 'open') {
        forwardToUpstream(data, isBinary);
        return;
      }
      if (pending.length >= MAX_PENDING_FRAMES) {
        void finish(1008, 'protocol_error');
        return;
      }
      pending.push({ data, isBinary });
    });

    browser.on('close', (code) => {
      if (phase === 'auth' || phase === 'authorizing') {
        phase = 'closed';
        stopTimers();
        deps.log(`relay: connection ${conn} left before it opened code=${code}`);
        return;
      }
      void finish(code, 'browser_closed');
    });

    browser.on('error', (err) => {
      // A malformed frame, an oversized one: `ws` closes the socket itself.
      deps.reportError(scrubbedError('relay: browser socket error', err));
    });

    async function authorizeAndDial(ticket: string): Promise<void> {
      let verdict: AgentTerminalAuthorization;
      try {
        verdict = await deps.authorize(ticket);
      } catch (err) {
        deps.reportError(scrubbedError('relay: authorize failed', err));
        refuse(1011, 'authorize failed');
        return;
      }
      if (phase === 'closed') return; // the browser left while the ticket was redeemed
      if (!verdict.ok) {
        refuse(verdict.closeCode, 'refused');
        return;
      }
      const t = verdict.target;
      target = t;
      phase = 'dialing';
      live.set(conn, finish);
      rowId = deps
        .openConnection({ workspaceId: t.workspaceId, instanceId: t.instanceId, userId: t.userId })
        .catch((err: unknown) => {
          deps.reportError(scrubbedError('relay: recording an open failed', err));
          return null;
        });
      void rowId.then((id) => {
        // Held from the moment its row exists until `finish` lets it go.
        if (id && phase !== 'closed') openRows.set(conn, { id, workspaceId: t.workspaceId });
      });
      deps.log(`relay: connection ${conn} opened instance=${t.instanceId} user=${t.userId}`);
      bump(t.instanceId);

      const socket = new WebSocket(t.dial.url, {
        headers: t.dial.headers,
        perMessageDeflate: false,
        handshakeTimeout: dialTimeoutMs,
      });
      upstream = socket;

      socket.on('open', () => {
        if (phase !== 'dialing') return;
        phase = 'open';
        for (const frame of pending.splice(0)) forwardToUpstream(frame.data, frame.isBinary);
      });
      socket.on('message', (data, isBinary) => {
        if (phase !== 'open') return;
        if (isBinary) bump(t.instanceId);
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
      });
      socket.on('pong', () => {
        alive.upstream = true;
      });
      socket.on('unexpected-response', (_req, res) => {
        // The server answered the upgrade with a status (401: a token it refused).
        deps.reportError(
          new Error(`relay: the terminal server refused the upgrade (HTTP ${res.statusCode})`),
        );
        void finish(TERMINAL_CLOSE.unreachable, 'unreachable');
      });
      socket.on('error', (err) => {
        // A dial aborted by our own close (`terminate` while connecting) is not news.
        if (phase === 'closed') return;
        if (phase === 'dialing') {
          deps.log(`relay: connection ${conn} could not reach instance=${t.instanceId}`);
          void finish(TERMINAL_CLOSE.unreachable, 'unreachable');
          return;
        }
        deps.reportError(scrubbedError('relay: terminal socket error', err));
      });
      socket.on('close', (code) => {
        if (phase === 'closed') return;
        if (phase === 'dialing' || code === 1006) {
          void finish(TERMINAL_CLOSE.unreachable, 'unreachable');
          return;
        }
        void finish(code === 1005 ? 1000 : code, 'terminal_closed');
      });
    }
  }

  return {
    server,
    get liveConnections() {
      return live.size;
    },
    async close() {
      clearInterval(heartbeatTimer);
      const closing = [...live.values()].map((finish) => finish(1012, 'relay_shutdown'));
      await Promise.all(closing);
      await Promise.all([...recording]);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
