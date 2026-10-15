import { Client } from 'pg';
import { closeQuietly } from '@/lib/live/listenerConnection';
import {
  LIVE_SIGNAL_CHANNEL,
  parseLiveNotification,
  type LiveNotification,
} from '@/lib/live/liveNotification';

// The per-process LIVE-SIGNAL HUB (Story MOTIR-8542 · Subtask MOTIR-8728).
//
// Every `app` process holds AT MOST ONE Postgres session that `LISTEN`s on
// `live_signal`, and fans each notification out, in memory, to the streams open
// on that process. So the number of database connections push costs is the
// number of PROCESSES, never the number of tabs.
//
// ⚠️ IT IS A HINT SOURCE, NEVER A DELIVERY GUARANTEE — the same rule
// `lib/jobs/engine/notify.ts` states for the job queue, and for the same
// reasons: a NOTIFY reaches only sessions listening at the moment it fires, so a
// process that is reconnecting misses it. Losing the listener therefore costs
// LATENCY: every stream keeps a slow backstop re-read (the stream route's
// 60 s), and every (re)connect tells subscribers to catch up at once
// (`onReconnect`). Nothing here reads a table, and nothing here decides what a
// reader may see — the stream's own access-gated read does that.
//
// ⚠️ ONE `error` / `end` / `notification` HANDLER TRIPLE ON THE CLIENT, never one
// per subscriber. Subscribers live in a `Set`, so several hundred open streams
// add no listeners to any emitter (the MOTIR-8171 ceiling).

/** First reconnect delay after the listener drops; doubles per failed attempt. */
export const LIVE_SIGNAL_RECONNECT_BASE_MS = 1_000;
/** The reconnect delay never grows past this. */
export const LIVE_SIGNAL_RECONNECT_MAX_MS = 30_000;
/**
 * How long the session stays open after the LAST subscriber leaves. A tab
 * reloading drops its stream and opens another a moment later, and closing and
 * reopening the session for that would cost a connection handshake per reload.
 */
export const LIVE_SIGNAL_IDLE_CLOSE_MS = 5_000;

export interface LiveSignalSubscriber {
  /** A parsed notification arrived. Called synchronously, in subscription order. */
  onSignal: (notification: LiveNotification) => void;
  /**
   * The listener (re)connected, so notifications may have been missed since this
   * subscriber's last read. A stream answers with an immediate catch-up read.
   */
  onReconnect?: () => void;
}

export interface LiveSignalHub {
  /** Register a subscriber; the first one starts the listener. Returns the unsubscribe. */
  subscribe(subscriber: LiveSignalSubscriber): () => void;
  /** True while the session is up and listening. */
  readonly connected: boolean;
  /** How many subscribers are registered. */
  readonly subscriberCount: number;
  /** Close the session and drop every subscriber. Idempotent. */
  stop(): Promise<void>;
}

export interface LiveSignalHubOptions {
  connectionString?: string;
  logger?: Pick<Console, 'info' | 'warn'>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  idleCloseMs?: number;
}

export function createLiveSignalHub(opts: LiveSignalHubOptions = {}): LiveSignalHub {
  const log = opts.logger ?? console;
  const reconnectBaseMs = opts.reconnectBaseMs ?? LIVE_SIGNAL_RECONNECT_BASE_MS;
  const reconnectMaxMs = opts.reconnectMaxMs ?? LIVE_SIGNAL_RECONNECT_MAX_MS;
  const idleCloseMs = opts.idleCloseMs ?? LIVE_SIGNAL_IDLE_CLOSE_MS;
  // ⚠️ THE UNPOOLED URL, and it must STAY direct — the connection-model work may
  // move the app's own traffic behind a transaction-mode pooler, and a pooler
  // hands the session back the moment a statement ends, which silently drops a
  // `LISTEN`. `listenForQueuedJobs` resolves its URL the same way, for the same
  // reason. The senders (the triggers) need no such care: Postgres broadcasts a
  // NOTIFY server-side to every listening session on the database.
  //
  // ⚠️ IN PRODUCTION THIS URL IS THE OWNER ROLE (`rolbypassrls = true`). That is
  // safe ONLY because this client issues exactly one statement — the `LISTEN`
  // below — and then only reads notifications. It must never be reused to query
  // a table: a bypassing connection with no tenant context is the one thing RLS
  // cannot protect.
  const connectionString =
    opts.connectionString ?? process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'];

  const subscribers = new Set<LiveSignalSubscriber>();
  let client: Client | undefined;
  let running = false;
  let connected = false;
  let down = false;
  let backoffMs = reconnectBaseMs;
  // Bumped whenever a client is abandoned, so events from it are ignored.
  let generation = 0;
  let retry: NodeJS.Timeout | undefined;
  let idle: NodeJS.Timeout | undefined;

  function dispatch(payload: string | undefined): void {
    const notification = parseLiveNotification(payload ?? '');
    if (!notification) return;
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onSignal(notification);
      } catch (err) {
        log.warn('[live-signal] a subscriber threw; the others still receive the signal', err);
      }
    }
  }

  function announceReconnect(): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onReconnect?.();
      } catch (err) {
        log.warn('[live-signal] a subscriber threw on reconnect', err);
      }
    }
  }

  function markDown(err: unknown): void {
    connected = false;
    if (!down) {
      down = true;
      log.warn(
        '[live-signal] listener down; pages heal on the 60 s backstop',
        err instanceof Error ? err.message : err,
      );
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (!running || retry) return;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, reconnectMaxMs);
    const abandoned = client;
    client = undefined;
    generation += 1;
    void closeQuietly(abandoned);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, wait);
    retry.unref?.();
  }

  async function connect(): Promise<void> {
    if (!running) return;
    const mine = ++generation;
    const next = new Client({ connectionString });
    client = next;
    // A listener that dies on an unhandled 'error' event takes the process with it.
    next.on('error', (err) => {
      if (mine === generation) markDown(err);
    });
    next.on('end', () => {
      if (mine === generation) markDown(new Error('listener connection ended'));
    });
    // No channel filter: this session issues exactly ONE `LISTEN`, so Postgres
    // can only deliver `live_signal` here.
    next.on('notification', (msg) => {
      if (mine === generation) dispatch(msg.payload);
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${LIVE_SIGNAL_CHANNEL}`);
    } catch (err) {
      if (mine === generation) markDown(err);
      else void closeQuietly(next);
      return;
    }
    if (mine !== generation) {
      void closeQuietly(next);
      return;
    }
    connected = true;
    backoffMs = reconnectBaseMs;
    if (down) {
      down = false;
      log.info(`[live-signal] listener recovered on ${LIVE_SIGNAL_CHANNEL}`);
    }
    announceReconnect();
  }

  async function shutdown(): Promise<void> {
    running = false;
    connected = false;
    down = false;
    backoffMs = reconnectBaseMs;
    generation += 1;
    if (retry) {
      clearTimeout(retry);
      retry = undefined;
    }
    const closing = client;
    client = undefined;
    await closeQuietly(closing);
  }

  return {
    subscribe(subscriber) {
      if (idle) {
        clearTimeout(idle);
        idle = undefined;
      }
      // A fresh entry per call, so the same object subscribed twice is two
      // registrations and each unsubscribe removes exactly its own.
      const entry: LiveSignalSubscriber = {
        onSignal: (n) => subscriber.onSignal(n),
        onReconnect: () => subscriber.onReconnect?.(),
      };
      subscribers.add(entry);
      if (!running) {
        running = true;
        void connect();
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscribers.delete(entry);
        if (subscribers.size === 0 && running && !idle) {
          idle = setTimeout(() => {
            idle = undefined;
            if (subscribers.size === 0) void shutdown();
          }, idleCloseMs);
          idle.unref?.();
        }
      };
    },
    get connected() {
      return connected;
    },
    get subscriberCount() {
      return subscribers.size;
    },
    async stop() {
      if (idle) {
        clearTimeout(idle);
        idle = undefined;
      }
      subscribers.clear();
      await shutdown();
    },
  };
}

// Held on `globalThis`, not in a module-level `let`: Next's dev server re-evaluates
// modules on hot reload, and a duplicated module graph would otherwise open a
// second listening session per copy.
const HUB_KEY = Symbol.for('motir.live.signalHub');

/** The process-wide hub. Every call, from every copy of this module, answers the same instance. */
export function getLiveSignalHub(): LiveSignalHub {
  const holder = globalThis as typeof globalThis & { [HUB_KEY]?: LiveSignalHub };
  holder[HUB_KEY] ??= createLiveSignalHub();
  return holder[HUB_KEY];
}
