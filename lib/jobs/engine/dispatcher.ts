import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { engineSubscribers } from './registry';
import { routedToEngine } from './cutover';
import { notifyQueuedJob } from './notify';

// FAN-OUT (Story MOTIR-3414 · Subtask MOTIR-3423) — one emitted event becomes
// one RUN per subscribing job.
//
// `sendEvent('work-item/transitioned', …)` writes ONE `job_event` row, and this
// dispatcher enqueues one `job_queue` row per job whose trigger matches. That
// event has four subscribers today, so it produces four runs — exactly what
// Inngest does server-side, which is why the event log is a table rather than a
// column on the run: the payload is stored once and referenced N times.
//
// ===========================================================================
// Three properties, each of which is silent when absent
// ===========================================================================
//
// 1. ⚠️ A SUBSCRIBER THAT FAILS TO ENQUEUE DOES NOT PREVENT ITS SIBLINGS.
//    Fan-out is NOT a transaction over the consumers. If enqueuing the watcher
//    job fails, the mention job must still be enqueued — otherwise one
//    unrelated consumer's bad day silently drops every notification for that
//    event. So each enqueue is its own statement and its own try/catch, and the
//    failures are collected and reported rather than thrown.
//
// 2. ⚠️ ENQUEUE IS IDEMPOTENT PER `(event, job)`. A dispatcher that retries —
//    because the caller retried, or because the process died between two
//    subscribers — must not double-enqueue. The guarantee is the `(event_id,
//    job_id)` UNIQUE constraint from MOTIR-3420, not a check-then-insert: a
//    check would be a read-derived write with a race in the middle. A `P2002` is
//    an EXPECTED outcome here and is swallowed as "already enqueued", which is
//    the correct reading of it.
//
// 3. ⚠️ THE SUBSCRIBER SET IS DERIVED FROM THE REGISTRY, never a second list.
//    `engineSubscribers(name)` filters the table `defineJob` populates at the
//    single choke point every job passes through. Two lists drift; one list
//    cannot. The test asserts the count against the REAL registry, so adding a
//    subscriber to a job cannot silently change the fan-out without a test
//    noticing.

/** What one dispatch did — returned so `sendEvent` can log it and the tests can assert it. */
export interface DispatchResult {
  /** The `job_event` row id, or null when nothing subscribed and no row was written. */
  eventId: string | null;
  /** Job ids enqueued by THIS call. */
  enqueued: string[];
  /** Job ids that were already enqueued for this event — the idempotent path, not an error. */
  alreadyEnqueued: string[];
  /** Job ids whose enqueue failed, with the reason. Their siblings still landed. */
  failed: Array<{ jobId: string; error: string }>;
}

/** True when a thrown value is Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Write the event and enqueue a run for every subscriber ROUTED TO THIS ENGINE.
 *
 * Subscribers still on Inngest are skipped here and reached by `sendEvent`'s
 * ordinary `inngest.send()`, so an event with a mixed subscriber set is
 * delivered to both lanes and each job runs exactly once, on its own lane.
 *
 * ⚠️ NOTHING HAPPENS WHEN NO SUBSCRIBER IS ROUTED HERE — not even a `job_event`
 * row. Writing one anyway would fill the table with events nothing will ever
 * consume, on every request that emits, for the whole migration.
 */
export async function dispatchEventToEngine(
  name: string,
  data: unknown,
  opts?: { idempotencyKey?: string | null; logger?: Pick<Console, 'warn'> },
): Promise<DispatchResult> {
  const log = opts?.logger ?? console;
  const subscribers = engineSubscribers(name).filter((d) => routedToEngine(d.id));
  if (subscribers.length === 0) {
    return { eventId: null, enqueued: [], alreadyEnqueued: [], failed: [] };
  }

  const payload = (data ?? {}) as { workspaceId?: string | null };
  const workspaceId = payload.workspaceId ?? null;

  const event = await withSystemContext((tx) =>
    jobEventRepository.create(
      {
        name,
        data: (data ?? {}) as Prisma.InputJsonValue,
        workspaceId,
        idempotencyKey: opts?.idempotencyKey ?? null,
      },
      tx,
    ),
  );

  const enqueued: string[] = [];
  const alreadyEnqueued: string[] = [];
  const failed: Array<{ jobId: string; error: string }> = [];

  // Sequential and individually guarded — property (1) in the header. A
  // `Promise.all` would be faster and would make one rejection reject the whole
  // batch, which is the behaviour this must not have.
  for (const sub of subscribers) {
    try {
      await withSystemContext((tx) =>
        jobQueueRepository.create(
          {
            jobId: sub.id,
            eventId: event.id,
            eventName: name,
            workspaceId,
            runAt: new Date(),
            maxAttempts: sub.maxAttempts,
          },
          tx,
        ),
      );
      enqueued.push(sub.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Property (2): the constraint did its job. Not an error.
        alreadyEnqueued.push(sub.id);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ jobId: sub.id, error: message });
      log.warn(
        `[job-dispatch] could not enqueue "${sub.id}" for event "${name}"; ` +
          `its sibling subscribers are unaffected:`,
        message,
      );
    }
  }

  // Wake a listening worker so the run starts now rather than at its next poll
  // boundary. Best-effort by construction — see `notify.ts`.
  if (enqueued.length > 0) {
    await withSystemContext(async (tx) => {
      await notifyQueuedJob((sql) => tx.$executeRawUnsafe(sql));
    });
  }

  return { eventId: event.id, enqueued, alreadyEnqueued, failed };
}

/**
 * Does this event have at least one subscriber still on Inngest?
 *
 * `sendEvent` uses it to decide whether the Inngest transport is still needed
 * for this event at all. Once every subscriber of an event has moved, the
 * `inngest.send()` for it is dead weight — and once EVERY event's has, the
 * retirement story removes the transport.
 */
export function hasInngestSubscribers(name: string): boolean {
  const subs = engineSubscribers(name);
  // ⚠️ AN EVENT WITH NO REGISTERED SUBSCRIBER STILL GOES TO INNGEST. The engine
  // registry is complete only for definition modules that have been EVALUATED
  // (see `registry.ts`), and `sendEvent` is called from request paths that may
  // not have imported them. Reading an empty subscriber set as "nothing is on
  // Inngest" would silently drop the event on exactly those paths. Defaulting to
  // the old lane is the safe direction, and it matches the switch's own default.
  if (subs.length === 0) return true;
  return subs.some((d) => !routedToEngine(d.id));
}
