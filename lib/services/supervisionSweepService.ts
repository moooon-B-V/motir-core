import type { JobSupervision } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import {
  codeGraphIndexDispatchService,
  type IndexSession,
} from '@/lib/services/codeGraphIndexDispatchService';
import { ciRunnerBootService, type SupervisionSession } from '@/lib/services/ciRunnerBootService';

// THE ABANDONED-SUPERVISION SWEEP (Story MOTIR-3778 · Subtask MOTIR-3830) — the
// owner of a state this story creates.
//
// ===========================================================================
// The state, and why it is new
// ===========================================================================
// While a supervision was a `while` loop inside ONE run, a `finally` covered
// every way out of it: short of the worker dying there was no path that skipped
// teardown. A supervision is a CHAIN OF PASSES now, and a chain can simply stop —
// the run dead-letters between polls, a queue row is removed, a defer lands on a
// row nobody will claim again. The container keeps running and nothing is
// watching it.
//
// ⚠️ WHAT IS LEFT WITHOUT THIS, READ RATHER THAN ASSUMED. The fleet reaper
// (`ciRunnerBootService.reapOrphans`) runs at
// `DEFAULT_REAP_AFTER_MS = DEFAULT_JOB_TIMEOUT_MS + 10 min` = **70 minutes**, and
// the Fly adapter destroys every machine carrying a fleet metadata tag — index
// containers included. But its resolver is CI-INTENT-SHAPED:
// `intents.findByContainerId(...)` answers null for an index container, so the
// adapter logs *"reaped a fleet machine with no attributable intent"*, writes NO
// usage row, and `sweepStaleClaims` — which is intent-scoped — never releases the
// `fleet_in_flight_slot` that container was holding. Seventy minutes of billed
// container, an unmetered invoice line, and a leaked admission slot.
//
// That is a defensible LAST resort and an indefensible primary path. This is the
// primary path: it reads the rows Motir owns, notices a chain that stopped, and
// takes the terminal transition the chain would have taken.
//
// ===========================================================================
// ⚠️ IT RE-IMPLEMENTS NO TEARDOWN, AND THAT IS THE DESIGN
// ===========================================================================
// It calls `settleIndexContainer` / `settleSupervision` — the same functions the
// driver's terminal transition calls. Those already destroy the container, meter
// the container-seconds with full attribution, release the admission slot and
// settle the intent, and each has its own suite. A sweep with its own teardown
// would be a second implementation of the one path in this system where being
// subtly wrong costs a duplicated billed container. This file never calls the
// orchestrator's teardown port at all, and `tests/jobs/supervision-sweep.test.ts`
// asserts that by reading the file — which is why the forbidden token is not
// written out here either.
//
// ===========================================================================
// The GRACE WINDOW, as arithmetic rather than a number that looks safe
// ===========================================================================
// The window must exceed the largest LEGITIMATE gap between two passes of a
// healthy supervision, because sweeping a live one tears down a container a
// customer's job is running in. Summing the four things that can lengthen it:
//
//   the longest wait a defer names          `MAX_POLL_INTERVAL_MS`   30 s  (CI; index is 15 s)
// + the worker's idle poll ceiling          `IDLE_MAX_MS`             5 s
// + a lease that must expire before a
//   dead claimant's row is reclaimable      `LEASE_MS`               60 s
// + the longest retry backoff a failed
//   pass can be rescheduled at              `retryBackoffMs` cap    300 s
//   ------------------------------------------------------------------------
//   worst legitimate gap                                          ≈ 395 s
//
// {@link SUPERVISION_STALL_GRACE_MS} is **15 minutes** — 2.3× that worst case,
// and still comfortably inside the 70-minute reaper it exists to pre-empt. The
// asymmetry is deliberate: sweeping a LIVE supervision destroys a running job,
// while sweeping a dead one late costs some minutes of container.
//
// ⚠️ AND THE GAP IS CHECKED TWICE, ON TWO DIFFERENT FACTS. `next_poll_at` older
// than the window says the chain SHOULD have come back; the owning `job_queue`
// row says whether it still CAN. A pass in flight, or a row due in the future,
// is a live supervision whatever its last poll instant says.

/** The largest wait a supervision's defer may name, from `FLEET_TIME_BUDGETS.maxPollIntervalMs`. */
const LONGEST_DEFER_MS = 30_000;
/** The worker's idle poll ceiling — `IDLE_MAX_MS` in `lib/jobs/engine/worker.ts`. */
const WORKER_IDLE_CEILING_MS = 5_000;
/** A dead claimant's row is reclaimable only once its lease expires — `LEASE_MS`. */
const LEASE_MS = 60_000;
/** The cap on `retryBackoffMs`, the longest a FAILED pass can be rescheduled at. */
const LONGEST_RETRY_BACKOFF_MS = 300_000;

/**
 * How far past its due poll a supervision must be before it is treated as
 * abandoned. See the header for the arithmetic this rounds up from.
 */
export const SUPERVISION_STALL_GRACE_MS = 15 * 60_000;

/** The sum the grace window must exceed, exported so a test asserts the inequality rather than the number. */
export const WORST_LEGITIMATE_GAP_MS =
  LONGEST_DEFER_MS + WORKER_IDLE_CEILING_MS + LEASE_MS + LONGEST_RETRY_BACKOFF_MS;

/** How many stalled supervisions one tick settles. A backlog drains over several ticks. */
const SWEEP_BATCH = 20;

export interface SupervisionSweepResult {
  /** Rows `listStalled` returned — candidates, before the liveness check. */
  scanned: number;
  /** Supervisions this tick took the terminal transition for. */
  settled: number;
  /** Candidates left alone because their run is still live, or a sibling claimed the transition. */
  skipped: number;
}

export const supervisionSweepService = {
  /**
   * Find supervisions whose chain stopped and settle each one.
   *
   * ⚠️ A TICK THAT FINDS NOTHING PERFORMS NO ORCHESTRATOR CALL AT ALL — one
   * indexed read of `(state, next_poll_at)` and a return. That is the
   * overwhelmingly common case and it is what makes the cadence affordable.
   */
  async sweepAbandoned(
    options: { now?: () => Date; graceMs?: number } = {},
  ): Promise<SupervisionSweepResult> {
    const now = options.now ?? ((): Date => new Date());
    const graceMs = options.graceMs ?? SUPERVISION_STALL_GRACE_MS;
    const cutoff = new Date(now().getTime() - graceMs);

    const candidates = await withSystemContext((tx) =>
      jobSupervisionRepository.listStalled(cutoff, tx, SWEEP_BATCH),
    );
    if (candidates.length === 0) return { scanned: 0, settled: 0, skipped: 0 };

    let settled = 0;
    let skipped = 0;
    for (const row of candidates) {
      if (await this.settleAbandoned(row, cutoff)) settled += 1;
      else skipped += 1;
    }
    return { scanned: candidates.length, settled, skipped };
  },

  /**
   * Settle ONE abandoned supervision. Returns whether it did.
   *
   * ⚠️ THE CLAIM IS A LOCKED COMPARE-AND-SET, and `teardown`'s own idempotence is
   * deliberately NOT what is relied on. Two overlapping ticks would otherwise
   * both read `watching`, both call the settle path, and both meter the
   * container — an idempotent destroy does not make a second usage row
   * disappear. `watching → settling` under `SELECT … FOR UPDATE` is what makes
   * the transition exactly-once, and it is the same claim the driver makes.
   */
  async settleAbandoned(row: JobSupervision, cutoff: Date): Promise<boolean> {
    if (await this.runIsStillLive(row, cutoff)) return false;

    const claimed = await withSystemContext(async (tx) => {
      const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(
        row.runId,
        row.subject,
        tx,
      );
      if (!locked || locked.state !== 'watching') return false;
      await jobSupervisionRepository.markState(row.runId, row.subject, 'settling', tx);
      return true;
    });
    if (!claimed) return false;

    const session = await this.readSession(row);
    if (!session) {
      // No boot memo — nothing was ever provisioned under this row, or the run's
      // steps have been swept. There is no container to tear down, so the honest
      // act is to stop tracking it rather than to invent a teardown.
      console.warn('[supervisionSweep] no boot memo for a stalled supervision; dropping the row', {
        runId: row.runId,
        subject: row.subject,
        kind: row.kind,
      });
      await withSystemContext((tx) =>
        jobSupervisionRepository.markState(row.runId, row.subject, 'settled', tx),
      );
      return false;
    }

    const startedAt = row.startedAt ? row.startedAt.toISOString() : null;
    const failureDetail = `supervision abandoned: no pass advanced it since ${row.nextPollAt.toISOString()}`;

    // THE TERMINAL TRANSITION — the supervisors' own, never a second copy.
    if (row.kind === 'index') {
      await codeGraphIndexDispatchService.settleIndexContainer(session as IndexSession, {
        done: true,
        reason: 'job_timed_out',
        startedAt,
        exitCode: null,
        failureDetail,
      });
    } else {
      const runner = session as SupervisionSession;
      await ciRunnerBootService.settleSupervision(runner, {
        done: true,
        reason: 'job_timed_out',
        startedAt,
        bootLatencyMs: startedAt
          ? Math.max(0, new Date(startedAt).getTime() - new Date(runner.queuedAt).getTime())
          : null,
        failureDetail,
      });
    }

    // The row's job is done: the outcome now lives where every settled
    // supervision's does — the settle step's memo and the run's `job_run` row.
    await withSystemContext((tx) =>
      jobSupervisionRepository.markState(row.runId, row.subject, 'settled', tx),
    );
    return true;
  },

  /**
   * Is the run that owes this supervision's next pass still able to make it?
   *
   * `next_poll_at` says the chain SHOULD have come back; this says whether it
   * still CAN. Three live shapes, and a row that matches none of them is a chain
   * nothing will advance:
   *
   *   * the run is `running` — a pass is in flight right now;
   *   * the run is `pending` and due at or after the cutoff — it is simply
   *     waiting, and the wait is legitimate;
   *   * … and nothing else. A `failed` run has dead-lettered, a `succeeded` one
   *     returned without settling its supervision (a bug, but the container is
   *     just as real), and an ABSENT row cannot come back at all.
   */
  async runIsStillLive(row: JobSupervision, cutoff: Date): Promise<boolean> {
    const run = await withSystemContext((tx) => jobQueueRepository.findById(row.runId, tx));
    if (!run) return false;
    if (run.state === 'running') return true;
    return run.state === 'pending' && run.runAt.getTime() >= cutoff.getTime();
  },

  /**
   * Read the supervision's session back out of the BOOT MEMO.
   *
   * ⚠️ THIS IS WHY `subject` IS PART OF THE ROW'S IDENTITY (§16.2). The session —
   * the container handle, `bootedAt`, `queuedAt`, the admission `slotRef` —
   * rides `index-boot:<subject>` / `boot-runner` and nowhere else, deliberately,
   * so that a second copy of the one fact whose duplicate costs a billed
   * container cannot exist. The sweep therefore reconstructs it the same way a
   * resumed pass does, from `job_step`, WITHOUT invoking the handler at all.
   */
  async readSession(row: JobSupervision): Promise<unknown | null> {
    const stepId = row.kind === 'index' ? `index-boot:${row.subject}` : 'boot-runner';
    const memo = await withSystemContext((tx) =>
      jobStepRepository.findByRunAndStep(row.runId, stepId, tx),
    );
    if (!memo || memo.kind !== 'run') return null;
    const result = memo.result as { phase?: string; session?: unknown } | null;
    if (!result || result.phase !== 'supervising' || !result.session) return null;
    return result.session;
  },
};
