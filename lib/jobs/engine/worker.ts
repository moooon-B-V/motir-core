import { randomUUID } from 'node:crypto';
import type { JobQueueRun } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { isJobStepYield } from './step';

// The WORKER (Story MOTIR-3414 · Subtask MOTIR-3421) — the process that claims
// due runs, executes them, records the outcome, and repeats.
//
// ===========================================================================
// Where it runs
// ===========================================================================
// Its OWN Fly process group, declared in `fly.toml` beside `app` — not inside
// the web process, so job load and request serving cannot contend for one event
// loop and the two scale independently. Declaring the group is this card's
// deliverable; bringing a machine up in it is `fly scale count`, an operator
// action owned by MOTIR-3425 (`fly.toml` CONFIGURES, it does not PROVISION —
// the same distinction the file's own header draws, and the one that cost
// motir-ai three days of an incident filed against the wrong service).
//
// ===========================================================================
// The claim
// ===========================================================================
// `jobQueueRepository.claimDueRuns` — `FOR UPDATE SKIP LOCKED`, with the state
// write in the same statement. Its header carries the full argument. What
// belongs HERE is what the loop does around it:
//
// ⚠️ SIDE EFFECTS RUN OUTSIDE THE CLAIMING TRANSACTION. The transaction holds
// the claim write and nothing else; the handler runs after it commits. A handler
// inside the claim would hold a row lock (and a pooled connection) for the whole
// job — minutes, for a supervisor — and Prisma cannot nest interactive
// transactions, so every service the handler calls would fail besides.
//
// ===========================================================================
// The lease, and the two ways a claim ends badly
// ===========================================================================
// A claim carries a LEASE: `lease_expires_at`, renewed by a heartbeat while the
// worker is alive. It exists for the one failure a graceful shutdown cannot
// cover — the worker DIES (OOM, host loss, SIGKILL) with runs in flight. Without
// a lease those rows sit `running` forever with no live claimant; with one they
// become reclaimable.
//
//   * LEASE_MS is 60 s and RENEW_MS is 20 s — a 3× margin, so two consecutive
//     missed heartbeats are needed before a live worker is declared dead. One
//     missed beat is a GC pause or a slow query and must not cost a run.
//   * The heartbeat renews EVERY run this worker holds in one statement, scoped
//     to `claimed_by`, so a worker can only renew its own.
//   * A run legitimately longer than the lease is the normal case, not the
//     exception (the container supervisors sleep for half an hour). The
//     heartbeat is what makes a long run and a dead worker distinguishable —
//     nothing about duration alone can.
//
// ⚠️ A RECLAIM AND A DRAIN BOTH REFUND THE ATTEMPT. `claimDueRuns` spends an
// attempt at the claim, so a worker that died has already consumed one without
// the handler ever failing. Not refunding it lets a rolling deploy or a
// crash-loop exhaust a job's whole budget silently — it would dead-letter with
// no error to show an operator. A genuine handler failure is counted on the
// failure path, where there is something to record.
//
// ===========================================================================
// Waking up: backoff, and why NOTIFY is not an optimisation
// ===========================================================================
// An idle worker polls with a bounded exponential backoff (IDLE_MIN_MS →
// IDLE_MAX_MS). On its own that means a freshly emitted event waits out up to a
// full poll interval before anything runs — user-visible latency on a
// notification or an email, for no reason other than the loop's own cadence.
//
// So the worker also LISTENs on a Postgres channel the dispatcher NOTIFYs, and
// treats a notification as "wake now". `LISTEN`/`NOTIFY` is a Postgres feature
// and needs no new service — which was one of the constraints on the foundation
// decision (`docs/decisions/job-queue-foundation.md` §9).
//
// ⚠️ THE POLL IS THE CORRECTNESS PATH AND THE NOTIFY IS THE LATENCY PATH — in
// that order, deliberately. A notification is delivered at most once and only to
// a listener connected AT THE MOMENT it fires: a worker restarting, or one whose
// connection has just dropped, misses it and would otherwise never learn the run
// exists. So the poll continues at IDLE_MAX_MS regardless, and losing the
// listener degrades latency rather than losing work. A design where NOTIFY is
// load-bearing has a silent-stall failure mode; this one does not.
//
// ===========================================================================
// Graceful shutdown
// ===========================================================================
// On SIGTERM: stop claiming, let in-flight runs finish (or checkpoint, if they
// yield), then RELEASE the claims so another machine can take them immediately.
// A deploy is a routine event — several a day — and must not orphan work or cost
// an attempt.
//
// The drain is bounded by DRAIN_TIMEOUT_MS. Fly sends SIGKILL some seconds after
// SIGTERM, so the release must happen with time to spare: a run still going at
// the deadline is released anyway and re-run later by whoever claims it, which
// is safe precisely because the step ledger memoized everything it completed.
// That is the shim paying for itself outside its own card.

/** How long a claim is held before another worker may reclaim it. */
export const LEASE_MS = 60_000;
/** Heartbeat cadence. A 3× margin on the lease: two missed beats before a live worker looks dead. */
export const RENEW_MS = 20_000;
/** Idle poll floor and ceiling. The ceiling bounds how long a MISSED notification can cost. */
export const IDLE_MIN_MS = 250;
export const IDLE_MAX_MS = 5_000;
/** How long a drain waits for in-flight runs before releasing them anyway. */
export const DRAIN_TIMEOUT_MS = 20_000;
/** How many runs one worker claims per tick. */
export const CLAIM_BATCH = 5;
/** The channel the dispatcher NOTIFYs when it enqueues. */
export const JOB_QUEUE_CHANNEL = 'motir_job_queue';

/** What the worker needs in order to execute one claimed run. Supplied by the caller so the loop is testable without the registry. */
export type JobRunExecutor = (run: JobQueueRun) => Promise<void>;

export interface JobWorkerOptions {
  /** Executes one claimed run. Throws to signal failure; throws a `JobStepYield` to signal a durable sleep. */
  execute: JobRunExecutor;
  /** Identifies this worker in `claimed_by`. Defaults to a per-process UUID. */
  workerId?: string;
  /** Overrides for the timing constants — the tests drive these; production passes none. */
  timings?: Partial<{
    leaseMs: number;
    renewMs: number;
    idleMinMs: number;
    idleMaxMs: number;
    drainTimeoutMs: number;
    claimBatch: number;
  }>;
  /** Called on every terminal outcome. */
  onOutcome?: (run: JobQueueRun, outcome: 'succeeded' | 'failed' | 'retrying' | 'yielded') => void;
  /**
   * ⚠️ THE AFTER-ALL-RETRIES-EXHAUSTED HOOK — the engine's `onFailure`
   * (MOTIR-3424). Invoked when the budget is spent, BEFORE the row is marked
   * failed, and this is where the `failed` ledger row and the dead-letter row are
   * written.
   *
   * It lives HERE, in the loop, and not in a `catch` inside the handler's own
   * execution, for the reason `lib/jobs/engine/ledger.ts` records at length:
   * Inngest's executor never runs a `step.run` scheduled from a catch block after
   * the terminally-failing step, so the equivalent code there silently never wrote
   * the rows in production while the in-process test harness made it look like it
   * did (PRODECT_FINDINGS #39). This hook is plain code in the claim loop with no
   * step machinery between the throw and the write.
   *
   * A throw from the hook itself is caught and logged — a bookkeeping failure
   * must not leave the run `running` with no live claimant, which is a strictly
   * worse state than a missing dashboard row.
   */
  onTerminalFailure?: (run: JobQueueRun, error: unknown) => Promise<void>;
  /** Structured logging sink; defaults to `console`. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * Exponential backoff for a RETRY, in ms. Doubling from one second, capped at
 * five minutes, with ±20% jitter.
 *
 * The jitter is not decoration: without it every run of a job that failed for a
 * COMMON cause (a provider outage, a database blip) retries at the same instant,
 * and the recovering dependency is hit by the whole cohort at once. That is the
 * thundering herd, and it is how a brief outage becomes a long one.
 */
export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 300_000);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Serialize an unknown thrown value for `job_queue.last_error`. Mirrors `defineJob`'s `serializeFailure`. */
export function serializeWorkerFailure(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: String(err) };
}

/**
 * One worker. Constructed, then `start()`ed; `shutdown()` drains it.
 *
 * The loop is exposed as `tick()` as well, so the tests can drive it one claim
 * at a time and assert on the outcome instead of racing a background timer.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly execute: JobRunExecutor;
  private readonly onOutcome: NonNullable<JobWorkerOptions['onOutcome']>;
  private readonly onTerminalFailure: JobWorkerOptions['onTerminalFailure'];
  private readonly log: NonNullable<JobWorkerOptions['logger']>;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly idleMinMs: number;
  private readonly idleMaxMs: number;
  private readonly drainTimeoutMs: number;
  private readonly claimBatch: number;

  /** Set by `shutdown()`; the loop stops CLAIMING the moment it is true. */
  private draining = false;
  private running = false;
  private idleDelay: number;
  private heartbeat: NodeJS.Timeout | undefined;
  /** Runs this worker has claimed and not yet settled. The drain waits on these. */
  private readonly inFlight = new Set<string>();
  /** Resolves when the idle sleep should be cut short — the NOTIFY path. */
  private wake: (() => void) | undefined;

  constructor(opts: JobWorkerOptions) {
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
    this.execute = opts.execute;
    this.onOutcome = opts.onOutcome ?? (() => {});
    this.onTerminalFailure = opts.onTerminalFailure;
    this.log = opts.logger ?? console;
    this.leaseMs = opts.timings?.leaseMs ?? LEASE_MS;
    this.renewMs = opts.timings?.renewMs ?? RENEW_MS;
    this.idleMinMs = opts.timings?.idleMinMs ?? IDLE_MIN_MS;
    this.idleMaxMs = opts.timings?.idleMaxMs ?? IDLE_MAX_MS;
    this.drainTimeoutMs = opts.timings?.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.claimBatch = opts.timings?.claimBatch ?? CLAIM_BATCH;
    this.idleDelay = this.idleMinMs;
  }

  /** How many runs this worker currently holds. The drain's own condition, exposed for the tests. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Claim and execute one batch. Returns how many runs were claimed — 0 means
   * the queue had nothing due, which is what drives the backoff.
   *
   * Public so a test can step the loop deterministically rather than sleeping
   * against a background timer, which is the same authoritative-signal
   * discipline the E2E rule states one altitude up.
   */
  async tick(): Promise<number> {
    if (this.draining) return 0;

    // Reclaim first: a run abandoned by a dead worker is due work, and doing
    // this before the claim means it is picked up in the SAME tick rather than
    // waiting for the next one.
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));

    // The claim: one transaction, holding the lock and the state write and
    // nothing else.
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns(this.workerId, this.claimBatch, this.leaseMs, tx),
    );
    if (claimed.length === 0) return 0;

    for (const run of claimed) this.inFlight.add(run.id);

    // Executed OUTSIDE the claiming transaction — see the header. Settled
    // independently, so one run's failure cannot abort its batch-mates.
    await Promise.all(claimed.map((run) => this.settle(run)));
    return claimed.length;
  }

  /** Run one claimed row and record its terminal state. Never throws — a failure is an outcome, not an exception the loop should die on. */
  private async settle(run: JobQueueRun): Promise<void> {
    try {
      await this.execute(run);
      await withSystemContext((tx) => jobQueueRepository.markSucceeded(run.id, tx));
      this.onOutcome(run, 'succeeded');
    } catch (err) {
      if (isJobStepYield(err)) {
        // A durable sleep. NOT a failure: the attempt is refunded and the run is
        // re-enqueued at the deadline the step recorded.
        await withSystemContext((tx) =>
          jobQueueRepository.rescheduleAt(run.id, err.resumeAt, tx, { refundAttempt: true }),
        );
        this.onOutcome(run, 'yielded');
        return;
      }

      const failure = serializeWorkerFailure(err);
      if (run.attempts >= run.maxAttempts) {
        // The budget is spent. Write the ledger + DLQ rows BEFORE marking the
        // queue row failed, so an operator never sees a `failed` run with no
        // record of why.
        if (this.onTerminalFailure) {
          try {
            await this.onTerminalFailure(run, err);
          } catch (hookErr) {
            // A bookkeeping failure must not strand the run. Log it and still
            // settle the row: `running` with no live claimant is strictly worse
            // than a missing dashboard entry.
            this.log.error('[job-worker] terminal-failure hook threw', hookErr);
          }
        }
        await withSystemContext((tx) => jobQueueRepository.markFailed(run.id, failure, tx));
        this.log.error(
          `[job-worker] ${run.jobId} run ${run.id} FAILED terminally`,
          failure.message,
        );
        this.onOutcome(run, 'failed');
        return;
      }

      const backoff = retryBackoffMs(run.attempts);
      await withSystemContext((tx) =>
        jobQueueRepository.rescheduleAt(run.id, new Date(Date.now() + backoff), tx, {
          lastError: failure,
        }),
      );
      this.onOutcome(run, 'retrying');
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /**
   * The loop. Claims until the queue is empty, then backs off — interruptibly,
   * so a NOTIFY (or a shutdown) cuts the sleep short instead of waiting it out.
   */
  private async loop(): Promise<void> {
    while (!this.draining) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (err) {
        // A claim that fails is a database problem, not a job problem. Log and
        // back off rather than exiting: a worker that dies on a transient error
        // takes the whole background layer down with it until the platform
        // restarts it.
        this.log.error('[job-worker] claim tick failed', err);
      }
      if (claimed > 0) {
        this.idleDelay = this.idleMinMs; // work found — poll eagerly again
        continue;
      }
      await this.sleepInterruptibly(this.idleDelay);
      this.idleDelay = Math.min(this.idleDelay * 2, this.idleMaxMs);
    }
  }

  /**
   * Sleep, unless `notify()` or `shutdown()` wakes us first.
   *
   * `finish` is idempotent because both wake paths can fire: a NOTIFY landing in
   * the same millisecond as the timer would otherwise resolve twice and clear a
   * timer that no longer exists.
   */
  private sleepInterruptibly(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }

  /**
   * Wake the loop now — the NOTIFY path, and what makes a freshly emitted event
   * start immediately rather than at the next poll boundary. Safe to call when
   * the worker is busy or stopped: it is a hint, never a claim.
   */
  notify(): void {
    this.wake?.();
  }

  /** Start the loop and the lease heartbeat. Resolves immediately; the loop runs in the background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.draining = false;
    this.heartbeat = setInterval(() => {
      void withSystemContext((tx) =>
        jobQueueRepository.renewLeases(this.workerId, this.leaseMs, tx),
      ).catch((err: unknown) => this.log.warn('[job-worker] lease renewal failed', err));
    }, this.renewMs);
    // `unref` so a heartbeat timer alone never holds the process open.
    this.heartbeat.unref?.();
    void this.loop();
  }

  /**
   * Drain: stop claiming, wait for in-flight runs (bounded), then RELEASE
   * whatever this worker still holds so another machine can take it at once.
   *
   * The release is unconditional — it runs whether the wait succeeded or timed
   * out. A run released mid-execution is re-run later by its next claimant, and
   * the step ledger means it resumes rather than restarts. Leaving it `running`
   * with no live claimant would be the actual failure: the acceptance criterion
   * is that no such row exists after a shutdown, and the ONLY way to guarantee
   * that is to release even the ones that did not finish in time.
   */
  async shutdown(): Promise<void> {
    this.draining = true;
    this.wake?.(); // cut any idle sleep short so the loop exits promptly
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.inFlight.size > 0) {
      this.log.warn(
        `[job-worker] drain timed out with ${this.inFlight.size} run(s) in flight; releasing them`,
      );
    }

    const released = await withSystemContext((tx) =>
      jobQueueRepository.releaseClaims(this.workerId, tx),
    );
    if (released > 0) this.log.info(`[job-worker] released ${released} claim(s) on shutdown`);
    this.running = false;
  }
}
