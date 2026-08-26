import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { manifestSubscribers } from './manifest';
import { ensureJobManifestLoaded } from './subscribers';
import { resolveIdempotencyKey } from './idempotency';
import { routedToEngine, routedJobIds } from './cutover';
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
// 3. ⚠️ THE SUBSCRIBER SET IS DERIVED FROM THE MANIFEST, never a second list.
//    `manifestSubscribers(name)` filters the handler-free table `defineJob`
//    populates at the single choke point every job passes through, on the same
//    line as the engine registry. Two lists drift; one list cannot. The test
//    asserts the count against the REAL manifest, so adding a subscriber to a
//    job cannot silently change the fan-out without a test noticing.
//
//    ⚠️ IT READS THE MANIFEST RATHER THAN THE REGISTRY because the registry
//    carries the HANDLER, and the handler is what drags the service graph onto
//    an emitting request (MOTIR-3458; ADR §12). Nothing here needs it: the two
//    functions below read `id`, `trigger`, `maxAttempts` and `idempotency`, and
//    nothing else.
//
// 4. ⚠️ EVENT-LEVEL DEDUP IS A CONSTRAINT, NOT A LOOKUP (MOTIR-3459). A job
//    declaring `idempotency` resolves its key here and stores it on the queue
//    row, where a PARTIAL UNIQUE index on `(job_id, idempotency_key)` collapses
//    a repeat to one run. Same reasoning as property (2), and the same `P2002`
//    handling serves both: a check-then-insert is a read-derived write with a
//    race in the middle, and the race here is two clicks on one button.
//
//    ⚠️ ENGINE DEDUP IS UNBOUNDED WHERE INNGEST'S IS WINDOWED — a deliberate,
//    argued divergence from MOTIR-3413's "no job's observable behaviour changes",
//    recorded in `docs/jobs.md` rather than left to be discovered. Forever is the
//    right behaviour for the keys in use: a password-reset token and an invite
//    token should each produce ONE email, not one per window.

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

  // ⚠️ NOTHING ROUTED ⇒ NOTHING TO RESOLVE, and therefore nothing to LOAD.
  //
  // The subscriber set exists only to be filtered by `routedToEngine`, so when
  // the routing set is empty the answer is "enqueue nothing" whatever the
  // manifest says. Returning here is not an optimisation of a correct path — it
  // IS the correct path, one step earlier.
  //
  // It matters because loading the manifest is expensive and lands somewhere
  // costly. Emitting is POST-COMMIT on a request path and `createWorkItem`
  // AWAITS it, so the load would sit inside a user's mutation: the first
  // dispatch in a fresh process measured **6224 ms** (the second, 0 ms), and
  // `tests/integration/work-items/revisions.test.ts` went red on a one-second
  // freshness window it had always met. The bill is the SERVICE BAG the
  // definitions reach through `defineJob` — `lib/jobs/services.ts` alone is
  // 8808 ms, against 3 ms for the manifest module and 158 ms for the registry
  // once services are warm.
  //
  // So before any job is cut over — which is the state of every deployment today
  // and of every test that does not set the routing set — the emit path pays
  // NOTHING. The load happens on the first emit AFTER an operator routes a job,
  // which is the one moment it is actually needed.
  //
  // ⚠️ AND IT MUST STAY BEFORE THE LOAD, not after. Warming eagerly instead was
  // tried twice and is unsafe here: calling it during module evaluation, and
  // then from a `setTimeout(0)`, both re-entered a module graph that was still
  // initializing — vite-node resolves imports through promises, so a macrotask
  // interleaves with graph evaluation — and eleven job suites failed to load
  // with `ReferenceError: Cannot access '__vite_ssr_import_3__' before
  // initialization`. The same temporal-dead-zone shape ADR §12 measured at build
  // time, one level down.
  if (routedJobIds().size === 0) {
    return { eventId: null, enqueued: [], alreadyEnqueued: [], failed: [] };
  }

  // The manifest is populated by evaluating the definition modules, and nothing
  // on a request path does that on its own — without this the subscriber set
  // reads empty and the cutover switch cannot move anything (MOTIR-3458).
  // Memoised: one dynamic import per process, a resolved promise thereafter.
  await ensureJobManifestLoaded();
  const subscribers = manifestSubscribers(name).filter((d) => routedToEngine(d.id));
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
            // Property (4): the job's own dedup key, resolved PER SUBSCRIBER
            // because the template is declared per job. Null for every job that
            // declares none, which the partial unique index excludes.
            idempotencyKey: resolveIdempotencyKey(sub.idempotency, data, sub.id),
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
  const subs = manifestSubscribers(name);
  // ⚠️ AN EVENT WITH NO REGISTERED SUBSCRIBER STILL GOES TO INNGEST — the safe
  // default, kept deliberately.
  //
  // It USED TO BE LOAD-BEARING FOR THE WRONG REASON, and the correction is worth
  // stating rather than deleting. This comment previously read: "the registry is
  // complete only for definition modules that have been EVALUATED, and
  // `sendEvent` is called from request paths that may not have imported them."
  // That was true, and it meant this arm was silently taken on EVERY production
  // emit — the manifest was empty, so every event read as "still on Inngest"
  // while the engine enqueued nothing. The safe default was doing the whole job,
  // and it hid the fact that nothing else was (MOTIR-3458; ADR §12).
  //
  // `sendEvent` now loads `./subscribers` explicitly, so an empty set here means
  // what it says: no job subscribes to this event. The default stays because that
  // case is still real — an event may legitimately ship before its consumer — and
  // routing it to the lane that has always carried it remains the safe direction.
  if (subs.length === 0) return true;
  return subs.some((d) => !routedToEngine(d.id));
}
