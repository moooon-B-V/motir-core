import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { previousFireAtOrBefore } from '../cron';
import { engineScheduledJobs, type EngineJobDefinition } from './registry';
import { routedToEngine } from './cutover';
import { notifyQueuedJob } from './notify';

// THE SCHEDULER (Story MOTIR-3416 · Subtask MOTIR-3471) — the half of the engine
// that did not exist.
//
// MOTIR-3414 shipped a dispatcher that enqueues for EVENTS. `engineScheduledJobs()`
// has been exported since MOTIR-3421 under the comment "The scheduled story
// consumes this", with no caller. Nothing turned a cron expression into a
// `job_queue` row. This does.
//
// ===========================================================================
// It is a TICK, not a timer — and that is a correctness property
// ===========================================================================
// `tick()` is driven by the worker's existing poll loop, not by a `setTimeout`
// chain that re-arms itself. The difference matters when the process is busy or
// paused: a `setTimeout` chain accumulates skew and, worse, expresses the
// schedule as "one interval since the last tick", so a tick that runs late shifts
// every subsequent fire. Here **every fire time is computed from the CLOCK
// against the cron expression** (`previousFireAtOrBefore`), so a tick that runs
// four minutes late still enqueues the fire it owed, at the instant it was owed.
// The tick's cadence decides only LATENCY; it can never decide WHICH fire.
//
// The corollary is that the tick is free to run as often as the loop happens to
// poll, because a tick that has nothing new to enqueue writes nothing: it
// recomputes the same fire instant and the `(job_id, scheduled_for)` unique
// answers "already queued" (MOTIR-3469).
//
// ===========================================================================
// ⚠️ THE SCHEDULER HOLDS NO STATE ABOUT WHAT IT HAS ENQUEUED, DELIBERATELY
// ===========================================================================
// A "last enqueued fire per job" map in memory would be a second source of truth
// that a restart loses and a second worker never sees. The identity of a tick
// lives in the DATABASE — `job_queue.scheduled_for` — and the constraint on it is
// what makes an enqueue idempotent for one worker, for two workers, and across a
// restart, all by the same mechanism.
//
// The single piece of process-local state is `watchingSince`, and it is not a
// cache: it is the answer to "was this scheduler running when that fire
// happened?", which is exactly the question the `skip` disposition asks and the
// one thing the database cannot answer.
//
// ===========================================================================
// The three dispositions (`docs/decisions/job-queue-foundation.md` §11)
// ===========================================================================
//   * `latest` — enqueue `previousFireAtOrBefore(cron, now)`. Stateless: on a
//     healthy tick that is the fire already queued and the write is a no-op; after
//     an outage it is the newest missed fire, which is precisely what `latest`
//     promises.
//   * `skip`   — the same fire, but only if it happened while this scheduler was
//     watching. A fire from before start-up is one the worker was DOWN for, and
//     the disposition says not to run it.
//   * `all`    — every fire between the job's newest already-enqueued
//     `scheduled_for` and now, oldest first. With no such row there is no history
//     to replay, so it degrades to one fire rather than inventing a horizon.
//
// ⚠️ NONE of the fourteen jobs declares `all` today (§11.5), and the branch is
// implemented and tested anyway: the class it names is real, one job is one change
// away from joining it, and a disposition that exists in the type but not in the
// scheduler would be a trap rather than a vocabulary.

/** How many missed fires ONE tick will enqueue for an `all` job. */
export const MAX_CATCH_UP_FIRES = 100;

/** What one tick did — returned so the worker can log it and the tests can assert it. */
export interface SchedulerTickResult {
  /** `<jobId>@<ISO fire instant>` for every row this tick actually wrote. */
  enqueued: string[];
  /** Ticks another worker (or an earlier tick) had already written. Not an error. */
  alreadyQueued: string[];
  /** Jobs whose enqueue threw. Their siblings still ran — see the loop below. */
  failed: Array<{ jobId: string; error: string }>;
  /** Jobs whose `all` catch-up hit `MAX_CATCH_UP_FIRES`. Never a silent truncation. */
  capped: string[];
}

export interface JobSchedulerOptions {
  /**
   * Reads the scheduled-job set. Defaults to the real registry; injected by the
   * tests so the empty-registry refusal below can be driven without unloading
   * modules.
   */
  scheduledJobs?: () => ReadonlyArray<EngineJobDefinition>;
  /**
   * The clock. Injectable throughout for the reason `jobScheduleHealthService.check(now)`
   * already is: a scheduler tested against the wall clock is a scheduler whose
   * suite fails at 03:29 on the third of the month.
   */
  now?: () => Date;
  /** Structured logging sink; defaults to `console`. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * Thrown by `start()` when the registry is empty.
 *
 * ⚠️ A SEPARATE ERROR TYPE BECAUSE THE DIAGNOSIS IS THE WHOLE VALUE. An empty
 * registry in a process that believes it is scheduling is INDISTINGUISHABLE from
 * "this deployment has no cron jobs": nothing throws, nothing runs, and an
 * operator sees a dashboard with no rows. That is the exact failure MOTIR-3455
 * found on the emit path, and the reason this refuses to start rather than
 * proceeding quietly.
 */
export class EmptyJobRegistryError extends Error {
  constructor() {
    super(
      'The job scheduler found NO scheduled jobs in the engine registry. That table is ' +
        'populated by `defineJob` as each definition MODULE is evaluated, so an empty one ' +
        'almost always means the process never imported `@/lib/jobs/registry` (it is a ' +
        'side-effect import and looks unused). Refusing to start: a scheduler that runs ' +
        'against an empty registry enqueues nothing, forever, in complete silence.',
    );
    this.name = 'EmptyJobRegistryError';
  }
}

/**
 * The scheduler. Constructed, `start()`ed (which is where the registry guard
 * fires), then `tick()`ed by the worker's loop.
 *
 * It owns no timer and no loop of its own — see the header. `JobWorker` calls
 * `tick()` at the top of its own, so a run this enqueues is claimed in the SAME
 * pass rather than at the next poll boundary, and a drain stops it for free.
 */
export class JobScheduler {
  private readonly scheduledJobs: () => ReadonlyArray<EngineJobDefinition>;
  private readonly now: () => Date;
  private readonly log: NonNullable<JobSchedulerOptions['logger']>;

  /**
   * When this scheduler began watching. The `skip` disposition's whole question —
   * "was anyone here when that fire passed?" — and the only thing the database
   * cannot answer, because a row that was never written leaves no trace.
   */
  private watchingSince: Date | null = null;

  constructor(opts: JobSchedulerOptions = {}) {
    this.scheduledJobs = opts.scheduledJobs ?? engineScheduledJobs;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.logger ?? console;
  }

  /** True once `start()` has run. `tick()` is a no-op before it. */
  get isStarted(): boolean {
    return this.watchingSince !== null;
  }

  /**
   * Arm the scheduler, refusing an empty registry (`EmptyJobRegistryError`).
   *
   * Cheap and synchronous: it reads the registry and stamps the clock. The
   * refusal is the point — see the error's own comment.
   */
  start(): void {
    const jobs = this.scheduledJobs();
    if (jobs.length === 0) throw new EmptyJobRegistryError();
    this.watchingSince = this.now();
    this.log.info(`[job-scheduler] watching ${jobs.length} scheduled job(s)`);
  }

  /**
   * ONE tick: enqueue every fire currently owed by every ROUTED scheduled job.
   *
   * Never throws. A job whose enqueue fails is reported and its siblings still
   * run — the same property the dispatcher's fan-out has, for the same reason:
   * one job's bad day must not stop thirteen sweeps.
   */
  async tick(): Promise<SchedulerTickResult> {
    const result: SchedulerTickResult = {
      enqueued: [],
      alreadyQueued: [],
      failed: [],
      capped: [],
    };
    if (this.watchingSince === null) return result;

    const now = this.now();
    for (const def of this.scheduledJobs()) {
      // Read LIVE per job, exactly as the dispatcher does: the switch's default
      // is Inngest, and a job nobody has routed must not be scheduled here even
      // though it is in the registry.
      if (!routedToEngine(def.id)) continue;
      try {
        await this.scheduleOne(def, now, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ jobId: def.id, error: message });
        this.log.warn(
          `[job-scheduler] could not schedule "${def.id}"; its siblings are unaffected:`,
          message,
        );
      }
    }

    // Wake a listening worker so a due run starts now rather than at the next
    // poll boundary. Best-effort by construction — see `notify.ts`.
    if (result.enqueued.length > 0) {
      // Logged HERE rather than by the caller, so the one line an operator reads
      // when a sweep fires names the fire INSTANT and not just the job — which is
      // the difference between "it ran" and "it ran for the tick it owed".
      this.log.info(`[job-scheduler] enqueued ${result.enqueued.join(', ')}`);
      await withSystemContext(async (tx) => {
        await notifyQueuedJob((sql) => tx.$executeRawUnsafe(sql), this.log);
      });
    }
    return result;
  }

  /** Enqueue whatever ONE job owes at `now`, per its declared disposition. */
  private async scheduleOne(
    def: EngineJobDefinition,
    now: Date,
    result: SchedulerTickResult,
  ): Promise<void> {
    if (def.cron === undefined || def.catchUp === undefined) return;

    const fires = await this.owedFires(def, def.cron, def.catchUp, now, result);
    for (const fire of fires) {
      const outcome = await withSystemContext((tx) =>
        jobQueueRepository.enqueueScheduled(
          {
            jobId: def.id,
            scheduledFor: fire,
            // ⚠️ EXACTLY `scheduled.<jobId>`, and it is not cosmetic:
            // `jobRunsService` denormalises it onto the ledger row and
            // `jobScheduleHealthService` GROUPS on this literal. Get it wrong and
            // every migrated cron job reads as permanently overdue — the tripwire
            // firing on the tripwire.
            eventName: `scheduled.${def.id}`,
            // The fire instant, not "now": a caught-up run is claimable at once
            // and the claim's `ORDER BY run_at` puts the oldest owed work first.
            runAt: fire,
            maxAttempts: def.maxAttempts,
          },
          tx,
        ),
      );
      const key = `${def.id}@${fire.toISOString()}`;
      // Already-queued is the NORMAL outcome of a second worker's tick, and of
      // every tick between two fires. It is the key doing its job, not an error.
      if (outcome.outcome === 'enqueued') result.enqueued.push(key);
      else result.alreadyQueued.push(key);
    }
  }

  /**
   * Which fires this job owes at `now`, oldest first.
   *
   * The cron arithmetic is `lib/jobs/cron.ts`'s and is not reimplemented here —
   * it is a tested UTC evaluator built for the schedule-health probe, and walking
   * it backwards is how "which fires were missed" is expressed in terms of it.
   */
  private async owedFires(
    def: EngineJobDefinition,
    cron: string,
    catchUp: NonNullable<EngineJobDefinition['catchUp']>,
    now: Date,
    result: SchedulerTickResult,
  ): Promise<Date[]> {
    const mostRecent = previousFireAtOrBefore(cron, now);
    // No fire inside the evaluator's horizon: the expression is legal but has not
    // come due yet (or is sparser than the horizon). Nothing is owed.
    if (mostRecent === null) return [];

    if (catchUp === 'skip') {
      // A fire from before this scheduler started is one the worker was DOWN for.
      // `watchingSince` is non-null here — `tick()` returned early otherwise.
      return mostRecent.getTime() >= this.watchingSince!.getTime() ? [mostRecent] : [];
    }

    if (catchUp === 'latest') return [mostRecent];

    // `all` — every fire since the newest one already enqueued for this job.
    const watermark = await withSystemContext((tx) =>
      jobQueueRepository.latestScheduledFor(def.id, tx),
    );
    // Nothing has ever been enqueued for this job, so there is no history to
    // replay. Enqueue the current fire and let the watermark exist from now on;
    // inventing a start point would replay the evaluator's whole horizon on a
    // first deploy.
    if (watermark === null) return [mostRecent];

    const fires: Date[] = [];
    let cursor: Date | null = mostRecent;
    while (cursor !== null && cursor.getTime() > watermark.getTime()) {
      fires.push(cursor);
      if (fires.length >= MAX_CATCH_UP_FIRES) {
        // ⚠️ SAY SO. A sweep that silently drops its tail reads exactly like one
        // that had nothing left to do — the same rule `ciRunnerProvisionSweep`
        // states about its own batch ceiling.
        result.capped.push(def.id);
        this.log.warn(
          `[job-scheduler] "${def.id}" owes more than ${MAX_CATCH_UP_FIRES} missed fires; ` +
            `enqueuing the newest ${MAX_CATCH_UP_FIRES} this tick and the rest on the next.`,
        );
        break;
      }
      // Step back one minute from this fire and ask again — the evaluator's own
      // "at or before" is inclusive, so the minus is what advances the walk.
      cursor = previousFireAtOrBefore(cron, new Date(cursor.getTime() - 60_000));
    }
    // Oldest first, so the queue is filled in the order the fires happened.
    return fires.reverse();
  }
}
