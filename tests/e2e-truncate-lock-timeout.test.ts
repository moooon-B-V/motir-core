import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { truncateJobTables, withTruncateDeadlockRetry } from '@/tests/e2e/_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { currentWorkerAdminUrl } from '@/tests/helpers/parallelDb';

// MOTIR-7415 — an E2E truncate that has to WAIT for its locks gives up its place
// in the lock queue instead of stalling the lane's job worker behind it.
//
// ── The failure ─────────────────────────────────────────────────────────────
// A TRUNCATE asks for `AccessExclusiveLock`. While that request waits, every
// LATER lock request on the same tables queues behind it — including the
// worker's lease-renewal UPDATE, which does not conflict with whatever the
// truncate itself is waiting for. On motir-core#3369's merge group the worker's
// transactions sat 96–103 s in that queue, and the jobs specs' `beforeEach`
// timed out three times in a row: a timed-out Playwright hook cancels nothing,
// so each abandoned truncate stayed queued and the next one joined it.
//
// ── What these cases drive ──────────────────────────────────────────────────
// Real connections against the worker's database, no mocks: one session holds
// an ordinary read lock in an idle transaction (the unidentified holder in the
// CI log), the door truncates, and a third session issues the worker's UPDATE.
// Against the door as it stood — no `lock_timeout`, a retry keyed on `40P01`
// only — the UPDATE waits for the whole life of the holder (measured 11.1 s
// against a 12 s holder), which is the first case's red.

const WORKER_UPDATE = 'UPDATE job_queue SET lease_expires_at = now() WHERE false';

let holder: Client;
let worker: Client;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  return client;
}

/** Opens a transaction that holds `AccessShareLock` on `job_queue` and sits idle. */
async function holdReadLock(): Promise<void> {
  await holder.query('BEGIN');
  await holder.query('SELECT count(*) FROM job_queue');
}

/** The lock dumps the door has logged so far. */
function lockDumps(): string[] {
  return vi
    .mocked(console.warn)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.startsWith('[e2e-truncate] lock timeout'));
}

/** Resolves with how long `promise` took, or `null` if it is still pending at `ms`. */
async function timedWithin(promise: Promise<unknown>, ms: number): Promise<number | null> {
  const started = Date.now();
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise.then(() => Date.now() - started), timer]);
}

beforeEach(async () => {
  await truncateJobRuns();
  holder = await connect();
  worker = await connect();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await holder.query('ROLLBACK').catch(() => {});
  await holder.end();
  await worker.end();
});

describe('the E2E truncate door under a lock it cannot take (MOTIR-7415)', () => {
  it('a blocked truncate releases the worker within its lock timeout, logs the holder, and lands once the holder ends', async () => {
    await holdReadLock();
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid;

    const truncating = truncateJobTables();
    // Let the truncate reach the lock queue before the worker arrives behind it.
    await new Promise((r) => setTimeout(r, 300));

    const workerMs = await timedWithin(worker.query(WORKER_UPDATE), 4_000);
    // Released by the first attempt's 2 s lock timeout. Unbounded, the UPDATE
    // waits for the holder, which in this case never ends on its own — so the
    // holder is released either way, and only after the door has had the
    // chance to name it (the dump reads the locks the holder still has).
    await vi
      .waitFor(() => expect(lockDumps()).not.toHaveLength(0), { timeout: 5_000 })
      .catch(() => {});
    await holder.query('ROLLBACK');

    expect(
      workerMs,
      'the worker UPDATE was still queued behind the truncate after 4 s',
    ).not.toBeNull();
    expect(workerMs!).toBeLessThan(4_000);

    await expect(truncating).resolves.toBeUndefined();

    const dumps = lockDumps();
    expect(dumps.length).toBeGreaterThanOrEqual(1);
    // The dump names the session that put the truncate in the queue.
    expect(dumps[0]).toContain(`"pid": ${holderPid}`);
    expect(dumps[0]).toContain('job_queue:AccessShareLock');
  }, 20_000);

  it('a holder that never lets go fails the truncate with its own lock-timeout error inside the hook budget', async () => {
    await holdReadLock();

    const started = Date.now();
    const outcome = await withTruncateDeadlockRetry(truncateJobRuns).then(
      () => null,
      (err: unknown) => err,
    );
    const elapsed = Date.now() - started;

    // The reason, not Playwright's 30 s timeout: the last attempt's error
    // arrives inside the hook's budget.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/55P03|lock timeout/i);
    expect(elapsed).toBeLessThan(25_000);
    // Bounded: five attempts, each logged.
    expect(lockDumps()).toHaveLength(5);

    // And nothing was left queued: the worker's UPDATE goes straight through.
    expect(await timedWithin(worker.query(WORKER_UPDATE), 1_000)).not.toBeNull();
  }, 30_000);
});
