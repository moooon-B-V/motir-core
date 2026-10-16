import { drainSseFrames } from '@/lib/ai/sseFrames';
import { WORKBENCH_TAB_KEYS, type WorkbenchTabKey } from '@/lib/dto/workbench';
import {
  formatWatchParams,
  WORKBENCH_STREAM_MAX_WATCHED_PLANS,
  WORKBENCH_STREAM_PLAN_FRAME,
} from '@/lib/workbench/planWatch';
import { createLiveFlag } from '../liveFlag';
import type { LiveSignal, LiveSignalListener, LiveSignalSource, LiveTopic } from '../liveSignal';

// THE WORKBENCH'S SSE NUDGE, AS A SOURCE (Story MOTIR-8539 · Subtask MOTIR-8572).
//
// The connection logic is `useWorkbenchLiveStream`'s from Story MOTIR-5238
// (Subtask MOTIR-5242), moved here unchanged so it can sit behind the seam: the
// watermark cursor, the backoff to a 15s ceiling, the `STREAM_STALE_MS`
// watchdog, the `offline` / `online` listeners and the frame filter. What is
// new is only WHO it answers: subscribers by topic instead of one hook's state.
//
// ⚠️ ONE CONNECTION PER SOURCE, HOWEVER MANY SUBSCRIBERS. It connects when the
// first `workbench` subscriber arrives and closes when the last one leaves — the
// same discipline as the hook's `enabled` gate, counted instead of passed. The
// cursor outlives the connection, so a reopen resumes from the watermark:
// neither a replay nor a gap. The shell's provider holds the one source.
//
// ⚠️ A FRAME NAMING NOTHING IS NOT A SIGNAL. The opening frame of every
// connection carries `moved: []` to hand the client its cursor, and a reconnect
// that missed nothing carries the same. Signalling those would re-read on every
// reconnect, which is the cost this design avoids.
//
// ⚠️ THE CONNECTION PARKS IN A HIDDEN TAB (Story MOTIR-8542 · Subtask MOTIR-8731).
// A tab hidden for `WORKBENCH_STREAM_HIDDEN_GRACE_MS` aborts its connection and
// PARKS: no fetch, no watchdog, no backoff timer, no `offline` / `online` wake —
// the cursor, the listeners and `seq` are kept. Shown again, it reopens at once
// with the held cursor, and the server's opening frame names whatever moved
// while it was away, so the catch-up is ONE nudge through the ordinary path. A
// park is deliberate, so it never reads as a drop: `reconnecting` stays false
// through hide, park and reopen (design-notes § 39 rule 2), and only a reopen
// that FAILS enters the drop path. The grace keeps a quick tab switch free.
//
// ⚠️ IT SERVES THE `plan` TOPIC TOO (Story MOTIR-8542 · Subtask MOTIR-8732). A
// generating plan's reads follow `plan` frames on this same connection instead of
// a 2.5 s timer. The watched plans ride the connection URL (`watch=<id>:<version>`,
// the first `WORKBENCH_STREAM_MAX_WATCHED_PLANS` in subscription order), so a
// change to the SET of plans reopens the one connection — close before open,
// after `PLAN_WATCH_SETTLE_MS`, with the held cursor, and never as a drop. A plan
// frame signals that plan's listeners only. While a connection is up and a plan
// is watched, every `PLAN_BACKSTOP_MS` each watched plan gets a `full` signal: the
// review version cannot see a committed card a proposal points at being renamed,
// and a lost notification must not leave a plan stale for longer than that. The
// backstop timer belongs to the connection, so a parked tab runs none.

/** The stream's address — one place, so the source and its tests agree. */
export const WORKBENCH_STREAM_PATH = '/api/workbench/stream';

/** The backoff ceiling, matching `useRunEvents`' — one number, one behaviour. */
const BACKOFF_CEILING_MS = 15_000;

/**
 * No bytes for this long means the connection is DEAD, whatever the socket says
 * (Story MOTIR-5238 · MOTIR-5245's E2E finding).
 *
 * ⚠️ A DROPPED CONNECTION DOES NOT ALWAYS FAIL, and that is the whole reason this
 * exists. Measured in the acceptance lane: with the browser taken offline mid-walk,
 * every NEW request failed `ERR_INTERNET_DISCONNECTED` while the already-open
 * stream was never torn down at all — no error, no `done`, no event. The reader
 * sat in front of a page that looked live and was frozen, and `reconnecting` —
 * the one thing the design promises them (§ 26, Panel 2) — never came, because
 * nothing had gone wrong in any way the client could see.
 *
 * The server already writes a `:` comment every `WORKBENCH_STREAM_HEARTBEAT_MS`
 * of silence so a proxy does not close the connection. That makes SILENCE itself
 * measurable: a healthy connection delivers bytes at least that often, so a gap of
 * more than two heartbeats is a connection that has stopped existing. The heartbeat
 * was already paying for this; it just had no reader.
 *
 * Two heartbeats plus slack, rather than one: a single missed beat is a slow
 * network, and announcing a drop that has not happened teaches a reader to ignore
 * the one that has.
 */
export const STREAM_STALE_MS = 35_000;

/**
 * How long a tab may stay hidden before its connection parks. A quick tab switch
 * keeps the connection; a tab left in the background stops holding one.
 */
export const WORKBENCH_STREAM_HIDDEN_GRACE_MS = 30_000;

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * While a plan is watched and a connection is up, each watched plan is read in
 * full this often — the bound the poll's every-8th full read used to keep.
 */
export const PLAN_BACKSTOP_MS = 60_000;

/**
 * How long a change to the watched plan set waits before it reopens the
 * connection, so a surface mounting two subscriptions in one render pays one reopen.
 */
export const PLAN_WATCH_SETTLE_MS = 50;

type PlanTopic = Extract<LiveTopic, { kind: 'plan' }>;

/** How often the watchdog looks. Cheap, and never the thing that decides. */
const WATCHDOG_TICK_MS = 2_000;

function isTabKey(value: unknown): value is WorkbenchTabKey {
  return typeof value === 'string' && (WORKBENCH_TAB_KEYS as readonly string[]).includes(value);
}

interface PumpHandle {
  /** End the pump and its connection; nothing reconnects. */
  stop(): void;
  /** The tab was shown: forget the silence measured while it was hidden. */
  freshen(): void;
}

export interface WorkbenchStreamSource extends LiveSignalSource {
  /** Close the connection now (the holder unmounted). A later subscribe reopens it. */
  dispose(): void;
}

export function createWorkbenchStreamSource(): WorkbenchStreamSource {
  const listeners = new Set<LiveSignalListener>();
  // The plan topic: listeners per plan in subscription order, the last version a
  // `plan` frame carried, and each plan's own monotonic `seq`.
  const planListeners = new Map<string, Set<LiveSignalListener>>();
  const planVersions = new Map<string, string>();
  const planSeqs = new Map<string, number>();
  // The watched set the running pump's connection was opened with.
  let connectedWatchKey = '';
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const reconnecting = createLiveFlag(false);
  // The cursor the next connection presents. It outlives every connection.
  let cursor: string | null = null;
  let seq = 0;
  // The running pump, or null when no connection is held (none subscribed, or parked).
  let pumpHandle: PumpHandle | null = null;
  // Parked: subscribed, but the tab has been hidden past the grace, so no
  // connection is held until it is shown again.
  let parked = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const signal = (moved: WorkbenchTabKey[]): void => {
    seq += 1;
    const next = { topic: { kind: 'workbench' as const }, seq, moved };
    for (const listener of [...listeners]) listener(next);
  };

  const signalPlan = (planId: string, mark: 'forced' | 'full' | null): void => {
    const set = planListeners.get(planId);
    if (!set) return;
    const planSeq = (planSeqs.get(planId) ?? 0) + 1;
    planSeqs.set(planId, planSeq);
    const topic: PlanTopic = { kind: 'plan', planId };
    const next: LiveSignal =
      mark === 'forced'
        ? { topic, seq: planSeq, forced: true }
        : mark === 'full'
          ? { topic, seq: planSeq, full: true }
          : { topic, seq: planSeq };
    for (const listener of [...set]) listener(next);
  };

  const hasSubscribers = (): boolean => listeners.size > 0 || planListeners.size > 0;

  /** The plans the connection URL carries, in subscription order. */
  const watchedPlanIds = (): string[] =>
    [...planListeners.keys()].slice(0, WORKBENCH_STREAM_MAX_WATCHED_PLANS);

  const streamUrl = (): string => {
    const params: string[] = [];
    if (cursor) params.push(`since=${encodeURIComponent(cursor)}`);
    const watch = formatWatchParams(
      watchedPlanIds().map((planId) => ({ planId, version: planVersions.get(planId) ?? null })),
    );
    if (watch) params.push(watch);
    return params.length > 0
      ? `${WORKBENCH_STREAM_PATH}?${params.join('&')}`
      : WORKBENCH_STREAM_PATH;
  };

  const startPump = (): PumpHandle => {
    // ⚠️ TWO CONTROLLERS, AND THE SPLIT IS LOAD-BEARING. `lifetime` is the last
    // subscriber leaving, after which nothing reconnects. Each CONNECTION gets
    // its own, so the watchdog and the `offline` listener can kill a dead
    // connection without telling the pump to give up.
    const lifetime = new AbortController();
    let cancelled = false;
    // When this connection last delivered a byte. Pump-scoped so a show can
    // reset it: a gap measured across a hidden spell is the browser throttling
    // timers, not a dead connection.
    let lastByteAt = Date.now();

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        const connection = new AbortController();
        const dropConnection = (): void => connection.abort();
        lifetime.signal.addEventListener('abort', dropConnection);
        // A browser that KNOWS it is offline says so at once, rather than waiting
        // out the watchdog: the reader is told in the moment the lift stops.
        window.addEventListener('offline', dropConnection);
        lastByteAt = Date.now();
        const watchdog = setInterval(() => {
          // A hidden tab's timers are throttled, so its silence proves nothing:
          // only a VISIBLE tab may call a quiet connection dead.
          if (isHidden()) return;
          if (Date.now() - lastByteAt >= STREAM_STALE_MS) dropConnection();
        }, WATCHDOG_TICK_MS);
        // The plan backstop, owned by THIS connection: it starts when the
        // connection opens and ends with it, so a parked, stopped or backing-off
        // pump runs none.
        let backstop: ReturnType<typeof setInterval> | null = null;
        try {
          // The set this connection is opened with — what a set change compares to.
          connectedWatchKey = watchedPlanIds().join(',');
          const res = await fetch(streamUrl(), {
            headers: { Accept: 'text/event-stream' },
            signal: connection.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          if (!cancelled) reconnecting.set(false);
          // A connection that opened resets the backoff: the next drop is a
          // first drop, not the fifth.
          attempt = 0;
          if (planListeners.size > 0) {
            backstop = setInterval(() => {
              for (const planId of [...planListeners.keys()]) signalPlan(planId, 'full');
            }, PLAN_BACKSTOP_MS);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            // EVERY byte counts, a heartbeat's included — the watchdog is
            // measuring silence, not events.
            lastByteAt = Date.now();
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = drainSseFrames(buffer);
            buffer = rest;
            for (const { event, data } of frames) {
              if (event === WORKBENCH_STREAM_PLAN_FRAME) {
                // A plan frame is a signal for that plan alone, never a tab nudge.
                const plan = data as { planId?: unknown; reviewVersion?: unknown };
                if (typeof plan.planId !== 'string' || typeof plan.reviewVersion !== 'string') {
                  continue;
                }
                if (!planListeners.has(plan.planId)) continue;
                planVersions.set(plan.planId, plan.reviewVersion);
                signalPlan(plan.planId, null);
                continue;
              }
              const frame = data as { moved?: unknown; cursor?: unknown };
              if (typeof frame.cursor === 'string') cursor = frame.cursor;
              const moved = Array.isArray(frame.moved) ? frame.moved.filter(isTabKey) : [];
              if (moved.length === 0) continue;
              reconnecting.set(false);
              signal(moved);
            }
          }
          if (cancelled) return;
        } catch {
          // ⚠️ THE LAST SUBSCRIBER LEAVING is the only abort that ends the pump.
          // A connection aborted by the watchdog or by `offline` is a DROP, and a
          // drop is what this loop exists to survive.
          if (cancelled || lifetime.signal.aborted) return;
        } finally {
          clearInterval(watchdog);
          if (backstop !== null) clearInterval(backstop);
          lifetime.signal.removeEventListener('abort', dropConnection);
          window.removeEventListener('offline', dropConnection);
        }
        if (cancelled) return;
        // The connection dropped. Say so, then resume FROM THE WATERMARK — which
        // is neither a replay nor a gap, because the server compares the cursor
        // rather than replaying from a position.
        reconnecting.set(true);
        const backoff = Math.min(1_000 * 2 ** Math.min(attempt, 4), BACKOFF_CEILING_MS);
        // ⚠️ THE BACKOFF IS INTERRUPTED BY `online`. Waiting out fifteen seconds
        // after the network has visibly come back is a stale page the reader can
        // SEE is stale, and it is the half of a drop they remember.
        // The last subscriber leaving, or a park, ends the wait too, so a
        // stopped pump leaves no timer and no listener behind.
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            window.removeEventListener('online', wake);
            lifetime.signal.removeEventListener('abort', wake);
            resolve();
          };
          const timer = setTimeout(wake, backoff);
          window.addEventListener('online', wake, { once: true });
          lifetime.signal.addEventListener('abort', wake, { once: true });
        });
      }
    };

    void pump();
    return {
      stop: () => {
        cancelled = true;
        lifetime.abort();
      },
      freshen: () => {
        lastByteAt = Date.now();
      },
    };
  };

  const clearGrace = (): void => {
    if (graceTimer !== null) clearTimeout(graceTimer);
    graceTimer = null;
  };

  const stopPump = (): void => {
    pumpHandle?.stop();
    pumpHandle = null;
    // Nothing is connected, so nothing is reconnecting — a park included.
    reconnecting.set(false);
  };

  const park = (): void => {
    graceTimer = null;
    if (!hasSubscribers() || parked) return;
    parked = true;
    stopPump();
  };

  const onVisibility = (): void => {
    if (isHidden()) {
      if (graceTimer === null && !parked) {
        graceTimer = setTimeout(park, WORKBENCH_STREAM_HIDDEN_GRACE_MS);
      }
      return;
    }
    clearGrace();
    if (parked) {
      // Resume in place: a fresh pump, attempt 0, presenting the held cursor.
      parked = false;
      pumpHandle = startPump();
    } else {
      pumpHandle?.freshen();
    }
  };

  const start = (): void => {
    document.addEventListener('visibilitychange', onVisibility);
    pumpHandle = startPump();
    if (isHidden()) graceTimer = setTimeout(park, WORKBENCH_STREAM_HIDDEN_GRACE_MS);
  };

  const clearSettle = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  };

  // ⚠️ A CHANGE TO THE WATCHED SET REOPENS THE ONE CONNECTION — close before
  // open, so two `fetch`es are never out at once, and not as a drop: no backoff,
  // no `reconnecting`. Parked, the change is only recorded: the show-time reopen
  // builds its URL from the current set.
  const watchSetChanged = (): void => {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!pumpHandle || parked) return;
      if (watchedPlanIds().join(',') === connectedWatchKey) return;
      pumpHandle.stop();
      pumpHandle = startPump();
    }, PLAN_WATCH_SETTLE_MS);
  };

  const stop = (): void => {
    clearGrace();
    clearSettle();
    parked = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    stopPump();
  };

  return {
    subscribe(topic, onSignal) {
      // A wrapper per subscription, so the same callback subscribed twice is two.
      const listener: LiveSignalListener = (s) => onSignal(s);
      if (topic.kind === 'plan') {
        const { planId } = topic;
        let set = planListeners.get(planId);
        const added = !set;
        if (!set) {
          set = new Set();
          planListeners.set(planId, set);
        }
        set.add(listener);
        if (!pumpHandle && !parked) start();
        else if (added) watchSetChanged();
        return () => {
          const current = planListeners.get(planId);
          if (!current?.delete(listener)) return;
          if (current.size > 0) return;
          planListeners.delete(planId);
          planVersions.delete(planId);
          if (!hasSubscribers()) stop();
          else watchSetChanged();
        };
      }
      listeners.add(listener);
      if (!pumpHandle && !parked) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (!hasSubscribers()) stop();
      };
    },
    trigger(topic) {
      // Only a plan is nudged on demand (the poll hook's `refresh()`).
      if (topic.kind === 'plan') signalPlan(topic.planId, 'forced');
    },
    reconnecting,
    dispose: stop,
  };
}
