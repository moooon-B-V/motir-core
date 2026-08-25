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

/**
 * Close a client, swallowing whatever it throws.
 *
 * ⚠️ `end()` CAN REJECT — on a client whose socket has already errored, which is
 * precisely the state the reconnect path finds it in. Letting that propagate
 * would turn a recovered listener into a crashed worker, for a connection we
 * were discarding anyway. One named helper rather than two inline
 * `.catch(() => {})`s so the swallow is a decision with a name on it, and so a
 * test can drive it.
 */
export async function closeQuietly(
  client: { end: () => Promise<void> } | undefined,
): Promise<void> {
  if (!client) return;
  try {
    await client.end();
  } catch {
    // Deliberately ignored — see above.
  }
}

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
  // ⚠️ THE UNPOOLED URL, and it is the paragraph above carried ONE LAYER OUT.
  // `LISTEN` binds to a SESSION that must stay open — which is precisely what a
  // TRANSACTION-MODE POOLER will not give it: Neon's pooled endpoint (PgBouncer)
  // hands the session back to its pool the moment the statement ends, so the
  // subscription either is refused outright or is silently dropped. Prisma's pool
  // and Neon's pooler break this connection for the same reason, one layer apart,
  // and a dedicated `Client` on the POOLED url only solves the nearer half.
  //
  // ⚠️ THE SENDER STAYS POOLED, DELIBERATELY — do not "fix" `dispatcher.ts` to
  // match. `NOTIFY` executes on a real backend and Postgres broadcasts
  // SERVER-SIDE to every session holding a matching `LISTEN`; Neon's pooled and
  // direct endpoints front the same compute, so a NOTIFY sent through the pooler
  // reaches a listener on the direct endpoint. Only the LISTEN half needs a
  // session of its own.
  //
  // ⚠️ IN PRODUCTION THIS URL IS THE OWNER ROLE (`rolbypassrls = true`; see
  // `scripts/detectStrayDesignResults.mjs`). That is safe here ONLY because this
  // client issues exactly one statement — the `LISTEN` below — and thereafter
  // reads notifications. It must never be reused to query a table; a bypassing
  // connection with no tenant context is the one thing RLS cannot protect.
  //
  // Falls back to `DATABASE_URL` for local dev and CI, where there is no pooler
  // and the two variables name the same database.
  const connectionString =
    opts?.connectionString ?? process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'];

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
      // ⚠️ NO CHANNEL FILTER, and that is a statement about an INVARIANT rather
      // than an omission. This client issues exactly ONE `LISTEN`, two lines
      // below, so Postgres can only ever deliver `JOB_QUEUE_CHANNEL` here — a
      // `msg.channel === …` test could not be false, which coverage confirmed by
      // never reaching its other arm.
      //
      // If a second `LISTEN` is ever added to this connection, reinstate the
      // filter: it stops being dead the moment the invariant does.
      client.on('notification', () => onNotify());
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
      void closeQuietly(client);
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
      await closeQuietly(client);
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
