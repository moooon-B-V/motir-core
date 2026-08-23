import { Client } from 'pg';
import { JOB_QUEUE_CHANNEL } from './worker';

// LISTEN / NOTIFY (Story MOTIR-3414 · Subtask MOTIR-3421) — the LATENCY path.
//
// The worker's idle backoff is bounded at `IDLE_MAX_MS`, so on its own a freshly
// emitted event waits out up to a full poll interval before anything runs. For a
// notification email or a mention that is user-visible latency bought for
// nothing. So the dispatcher NOTIFYs a channel and the worker wakes.
//
// ⚠️ THE POLL REMAINS THE CORRECTNESS PATH — this is a hint, never a delivery
// guarantee, and the distinction is the whole reason the module is written this
// way:
//
//   * A `NOTIFY` reaches only listeners connected AT THE MOMENT it fires. A
//     worker starting up, redeploying, or reconnecting after a dropped socket
//     misses it and would never learn the run exists.
//   * Postgres delivers a notification only on COMMIT of the transaction that
//     issued it, and drops it entirely if that transaction rolls back — correct
//     for us, and another thing the poll makes non-load-bearing.
//
// So losing the listener degrades LATENCY (to `IDLE_MAX_MS`) and never loses
// work. A design in which NOTIFY is load-bearing has a silent-stall failure mode;
// this one cannot.
//
// ⚠️ IT NEEDS ITS OWN CONNECTION, and not for style. `LISTEN` binds to a SESSION
// and the session must stay open to receive anything, which is the opposite of
// what a pool does — Prisma hands a query whichever connection is free and takes
// it back afterwards, so a `LISTEN` issued through it would be silently
// unsubscribed. Hence a raw `pg` Client, held open for the worker's life. It is
// one extra connection per worker machine, which is the price of the feature.

export interface JobQueueListener {
  /** Close the listening connection. Idempotent. */
  stop(): Promise<void>;
  /** True while the connection is up — the worker logs a degraded-to-polling line when it is not. */
  readonly connected: boolean;
}

/**
 * Open a dedicated connection and call `onNotify` whenever the dispatcher
 * signals new work.
 *
 * Reconnects with a bounded backoff: a dropped listener is a latency
 * regression, not an outage, so it retries quietly rather than crashing the
 * worker — the poll is still running underneath it the whole time.
 */
export async function listenForQueuedJobs(
  onNotify: () => void,
  opts?: {
    connectionString?: string;
    logger?: Pick<Console, 'info' | 'warn'>;
    reconnectMs?: number;
  },
): Promise<JobQueueListener> {
  const log = opts?.logger ?? console;
  const reconnectMs = opts?.reconnectMs ?? 5_000;
  const connectionString = opts?.connectionString ?? process.env['DATABASE_URL'];

  let client: Client | undefined;
  let stopped = false;
  let connected = false;
  let retry: NodeJS.Timeout | undefined;

  async function connect(): Promise<void> {
    if (stopped) return;
    try {
      client = new Client({ connectionString });
      // A listener that dies on an unhandled 'error' event takes the worker
      // process with it — for a path that is explicitly non-load-bearing.
      client.on('error', (err) => {
        connected = false;
        log.warn('[job-listener] connection error; falling back to polling', err.message);
        scheduleReconnect();
      });
      client.on('notification', (msg) => {
        if (msg.channel === JOB_QUEUE_CHANNEL) onNotify();
      });
      await client.connect();
      await client.query(`LISTEN ${JOB_QUEUE_CHANNEL}`);
      connected = true;
      log.info(`[job-listener] listening on ${JOB_QUEUE_CHANNEL}`);
    } catch (err) {
      connected = false;
      log.warn('[job-listener] could not start listening; polling only', err);
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void client?.end().catch(() => {});
      client = undefined;
      void connect();
    }, reconnectMs);
    retry.unref?.();
  }

  await connect();

  return {
    get connected(): boolean {
      return connected;
    },
    async stop(): Promise<void> {
      stopped = true;
      connected = false;
      if (retry) {
        clearTimeout(retry);
        retry = undefined;
      }
      await client?.end().catch(() => {});
      client = undefined;
    },
  };
}

/**
 * Signal that new work is queued. Called by the dispatcher AFTER its enqueue has
 * committed (MOTIR-3423) — Postgres itself enforces that ordering for a NOTIFY
 * issued inside a transaction, and a caller outside one gets it for free.
 *
 * Best-effort by construction: a failure here costs latency, never work, so it
 * is swallowed rather than surfaced. The same reasoning `sendEvent` already
 * applies to its own transport, one layer up.
 */
export async function notifyQueuedJob(
  exec: (sql: string) => Promise<unknown>,
  logger: Pick<Console, 'warn'> = console,
): Promise<void> {
  try {
    await exec(`NOTIFY ${JOB_QUEUE_CHANNEL}`);
  } catch (err) {
    logger.warn('[job-listener] NOTIFY failed; the poll will pick the run up', err);
  }
}
