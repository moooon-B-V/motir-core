import type { WorkbenchWatermarkDto } from '@/lib/dto/workbench';
import type { LiveNotification } from '@/lib/live/liveNotification';
import type { LiveSignalHub } from '@/lib/live/liveSignalHub';
import {
  getWorkbenchStreamCoalescer,
  planWindowKey,
  projectWindowKey,
  workspaceWindowKey,
  type WorkbenchStreamCoalescer,
} from '@/lib/workbench/workbenchStreamCoalescer';
import type { WatchedPlan, WorkbenchStreamPlanFrame } from '@/lib/workbench/planWatch';

// ONE OPEN WORKBENCH STREAM'S READ LIFECYCLE (Story MOTIR-8542 · Subtask MOTIR-8729).
//
// The stream used to ask the database once a second whether anything moved. It
// now re-reads its reader's watermark only when
//   (a) a notification about its project arrives, coalesced process-wide over
//       `WORKBENCH_STREAM_COALESCE_MS`,
//   (b) the listener hub (re)connects, so notifications may have been missed, or
//   (c) `WORKBENCH_STREAM_BACKSTOP_MS` has passed since the last read.
// All three take the SAME read path, so there is one path to test.
//
// ⚠️ THE NOTIFICATION IS A HINT; THE READ IS THE AUTHORITY. The filter below only
// skips reads that cannot matter. What moved, and whether this reader may see it,
// is decided by the injected `read` — the reader's own watermark read under their
// own `withWorkspaceContext` — so a notification about something the reader cannot
// see costs a read at most, and writes no frame, because the watermark did not move.
//
// ⚠️ ONE READ IN FLIGHT. A notification landing while a read runs marks the
// session dirty, and the read is followed by exactly ONE more. A burst therefore
// converges on its final state without a read per write and without a queue.
//
// ── WATCHED PLANS (MOTIR-8730) ───────────────────────────────────────────────
// A stream may also watch up to ten plans. A notification naming one of them
// arms that plan's own window, and when it closes the stream reads THAT PLAN's
// review version — through `readPlan`, the reader's own admitted read — and
// writes a plan frame only when (status, version) moved. It is a SECOND,
// INDEPENDENT handler: it never calls the watermark read, and the watermark
// handler above does not look at `planId`. (A plan write still arms the project
// window too, which is right: `plan` and `plan_revision` are watermark inputs.)
// Each plan has its own one-in-flight / one-dirty pair, so plans never wait on
// each other, and every plan read shares the same process limiter.
//
// No state beyond the cursor, the per-plan last-seen version, the flags and the
// timers. Nothing remembers what was sent: a redeploy loses nothing a
// reconnect's cursor and watched versions do not restore.

/** A quiet stream re-reads this long after its last read — the heal for a lost hint. */
export const WORKBENCH_STREAM_BACKSTOP_MS = 60_000;

/** The catch-up read after a hub reconnect lands within this, jittered so a reconnect does not wake every stream in the same millisecond. */
export const WORKBENCH_STREAM_RECONNECT_JITTER_MS = 1_000;

export interface WorkbenchStreamActor {
  userId: string;
  workspaceId: string;
  projectId: string;
}

export interface WorkbenchStreamTimers {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/** What a watched plan's read answers: its status and review version, or null when refused or gone. */
export type WorkbenchStreamPlanReading = { status: string; reviewVersion: string } | null;

export interface WorkbenchStreamSessionOptions {
  actor: WorkbenchStreamActor;
  hub: Pick<LiveSignalHub, 'subscribe'>;
  /** The reader's own watermark read. The route passes `workbenchWatermarkService.read`. */
  read: (actor: WorkbenchStreamActor, since: string | null) => Promise<WorkbenchWatermarkDto>;
  /** Called with a re-read that MOVED something. Never with the opening read, which `start` returns. */
  write: (reading: WorkbenchWatermarkDto) => void;
  /** The plans this stream watches, with the version the client already holds. */
  watched?: readonly WatchedPlan[];
  /** The reader's own admitted plan read. The route passes `planReviewService.readReviewVersionForReader`. */
  readPlan?: (planId: string) => Promise<WorkbenchStreamPlanReading>;
  /** Called with a plan frame when a watched plan's (status, version) moved. */
  writePlan?: (frame: WorkbenchStreamPlanFrame) => void;
  coalescer?: WorkbenchStreamCoalescer;
  timers?: WorkbenchStreamTimers;
  random?: () => number;
  logger?: Pick<Console, 'warn'>;
}

export interface WorkbenchStreamSession {
  /**
   * Subscribe, then take the opening read and return it. A throw from that read
   * closes the session and propagates, so the route still answers with a status.
   */
  start(since: string | null): Promise<WorkbenchWatermarkDto>;
  /** Unsubscribe and clear every timer. Idempotent; nothing runs or writes afterwards. */
  close(): void;
}

export function createWorkbenchStreamSession(
  opts: WorkbenchStreamSessionOptions,
): WorkbenchStreamSession {
  const { actor, hub, read, write } = opts;
  const coalescer = opts.coalescer ?? getWorkbenchStreamCoalescer();
  const timers: WorkbenchStreamTimers = opts.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const random = opts.random ?? Math.random;
  const readPlan = opts.readPlan;
  const writePlan = opts.writePlan;

  interface PlanState {
    /** The version the client presented, compared only on the first read. */
    presented: string | null;
    /** `status:reviewVersion` of the last read that answered, or null before one. */
    lastSeen: string | null;
    inFlight: boolean;
    queued: boolean;
    dirty: boolean;
  }
  const plans = new Map<string, PlanState>();
  if (readPlan) {
    for (const plan of opts.watched ?? []) {
      plans.set(plan.planId, {
        presented: plan.version,
        lastSeen: null,
        inFlight: false,
        queued: false,
        dirty: false,
      });
    }
  }
  const log = opts.logger ?? console;

  // ⚠️ THE ACTIVE PROJECT ALONE IS THE READER'S SCOPE. `resolveActiveProjectScope`
  // (`lib/services/homeService.ts`) answers the active project or nothing, and
  // every tab the watermark reads is bounded by that answer — so matching on
  // `actor.projectId` misses no write the read could see. If the scope ever
  // widens to several projects, this key set has to widen with it.
  const projectKey = projectWindowKey(actor.workspaceId, actor.projectId);
  const workspaceKey = workspaceWindowKey(actor.workspaceId);

  let cursor: string | null = null;
  let closed = false;
  let inFlight = false;
  let queued = false;
  let dirty = false;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let catchUp: ReturnType<typeof setTimeout> | undefined;
  const releases: Array<() => void> = [];

  function clearBackstop(): void {
    if (backstop === undefined) return;
    timers.clearTimeout(backstop);
    backstop = undefined;
  }

  function armBackstop(): void {
    clearBackstop();
    backstop = timers.setTimeout(() => {
      backstop = undefined;
      request();
      requestEveryPlan();
    }, WORKBENCH_STREAM_BACKSTOP_MS);
    backstop.unref?.();
  }

  /** A read is wanted. At most one runs, and at most one waits behind it. */
  function request(): void {
    if (closed) return;
    // Waiting for a slot: the read has not started, so it will see this change.
    if (queued) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    queued = true;
    void coalescer.run(async () => {
      queued = false;
      // A reader who left while this waited costs the slot nothing more.
      if (closed) return;
      await reread();
    });
  }

  async function reread(): Promise<void> {
    inFlight = true;
    dirty = false;
    clearBackstop();
    try {
      const reading = await read(actor, cursor);
      if (closed) return;
      cursor = reading.cursor;
      // A frame ONLY when something moved; the held cursor moves either way.
      if (reading.moved.length > 0) write(reading);
    } catch (err) {
      // ⚠️ LOGGED, AND THE STREAM STAYS OPEN. One transient pool error must not
      // drop every tab on the process; the next notification or the backstop
      // retries from the same cursor.
      if (!closed) {
        log.warn(
          '[workbench-stream] re-read failed; retrying on the next signal or the backstop',
          err instanceof Error ? err.message : err,
        );
      }
    } finally {
      settle();
    }
  }

  function settle(): void {
    inFlight = false;
    if (closed) return;
    armBackstop();
    if (dirty) {
      dirty = false;
      request();
    }
  }

  /** A read of one watched plan is wanted — the plan's own one-in-flight rule. */
  function requestPlan(planId: string): void {
    const state = plans.get(planId);
    if (closed || !state || state.queued) return;
    if (state.inFlight) {
      state.dirty = true;
      return;
    }
    state.queued = true;
    void coalescer.run(async () => {
      state.queued = false;
      if (closed) return;
      await rereadPlan(planId, state);
    });
  }

  function requestEveryPlan(): void {
    for (const planId of plans.keys()) requestPlan(planId);
  }

  async function rereadPlan(planId: string, state: PlanState): Promise<void> {
    state.inFlight = true;
    state.dirty = false;
    try {
      const reading = await readPlan!(planId);
      // `null` is a refusal or a plan that is gone: no frame, no error, and no
      // hint that it exists. A later read that answers still compares as usual.
      if (closed || !reading) return;
      const seen = `${reading.status}:${reading.reviewVersion}`;
      const moved =
        state.lastSeen === null
          ? reading.reviewVersion !== state.presented
          : seen !== state.lastSeen;
      state.lastSeen = seen;
      if (moved) writePlan?.({ planId, reviewVersion: reading.reviewVersion });
    } catch (err) {
      if (!closed) {
        log.warn(
          '[workbench-stream] plan re-read failed; retrying on the next signal or the backstop',
          err instanceof Error ? err.message : err,
        );
      }
    } finally {
      state.inFlight = false;
      if (!closed && state.dirty) {
        state.dirty = false;
        requestPlan(planId);
      }
    }
  }

  function onSignal(n: LiveNotification): void {
    if (closed || n.workspaceId !== actor.workspaceId) return;
    if (n.projectId === null) coalescer.touch(workspaceKey);
    else if (n.projectId === actor.projectId) coalescer.touch(projectKey);
    // The plan handler, beside the watermark one and independent of it.
    if (n.planId !== null && plans.has(n.planId)) {
      coalescer.touch(planWindowKey(actor.workspaceId, n.planId));
    }
  }

  function onReconnect(): void {
    if (closed || catchUp !== undefined) return;
    catchUp = timers.setTimeout(
      () => {
        catchUp = undefined;
        request();
        requestEveryPlan();
      },
      Math.floor(random() * WORKBENCH_STREAM_RECONNECT_JITTER_MS),
    );
    catchUp.unref?.();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    dirty = false;
    clearBackstop();
    if (catchUp !== undefined) {
      timers.clearTimeout(catchUp);
      catchUp = undefined;
    }
    for (const release of releases.splice(0)) release();
    plans.clear();
  }

  return {
    async start(since) {
      if (closed) throw new Error('workbench stream session is closed');
      // ⚠️ SUBSCRIBE BEFORE THE OPENING READ. A write that commits while that
      // read runs marks the session dirty, so it is read straight after — the gap
      // between "read" and "listening" is where a change would otherwise fall.
      releases.push(coalescer.listen(projectKey, request));
      releases.push(coalescer.listen(workspaceKey, request));
      for (const planId of plans.keys()) {
        releases.push(
          coalescer.listen(planWindowKey(actor.workspaceId, planId), () => requestPlan(planId)),
        );
      }
      releases.push(hub.subscribe({ onSignal, onReconnect }));
      // Every watched plan is read once at open, so a change between the
      // client's last read and this stream is never missed. Through the limiter
      // and the plan's own in-flight flag, so a signal during it marks it dirty.
      requestEveryPlan();
      inFlight = true;
      let opening: WorkbenchWatermarkDto;
      try {
        opening = await read(actor, since);
      } catch (err) {
        inFlight = false;
        close();
        throw err;
      }
      cursor = opening.cursor;
      settle();
      return opening;
    },
    close,
  };
}
