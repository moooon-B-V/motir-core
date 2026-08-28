import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { manifestSubscribers } from './manifest';
import { ensureJobManifestLoaded } from './subscribers';
import { resolveIdempotencyKey } from './idempotency';
import { debouncedRunAt, resolveDebounceKey } from './debounce';
import { notifyQueuedJob } from './notify';
import type { JobManifestEntry } from './manifest';

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
//
// 5. ⚠️ DEBOUNCE IS THE SAME PATTERN ONE STEP FURTHER (MOTIR-3483). A job
//    declaring `debounce` resolves its coalescing key here and, instead of
//    inserting a second run, PUSHES the pending one's `run_at` forward and
//    repoints it at the newer event. `docs/decisions/job-queue-foundation.md` §9
//    chose that shape while rejecting pg-boss: "a `run_at` that is pushed forward
//    on each same-key arrival, which is a column and an upsert on a table we own,
//    not a subsystem."
//
//    It differs from dedup in what it needs and therefore in how it is written.
//    Dedup asks "does this exist?", which a UNIQUE constraint answers with no
//    read at all. Coalescing has to READ the pending row (its
//    `debounce_first_seen_at`, for the deferral cap) and then WRITE based on what
//    it read — a read-derived write, so the row is locked with `SELECT … FOR
//    UPDATE` inside one transaction, per CLAUDE.md's lock-before-a-contended-
//    update contract.
//
//    ⚠️ AND THE LOCK CANNOT COVER THE FIRST ARRIVAL, which is where the `P2002`
//    pattern comes back. Two concurrent first pushes for one key lock nothing —
//    there is no row yet — and both insert. The partial unique index catches the
//    loser, and the loser's answer is NOT "already enqueued": it retries the
//    coalesce, so the winner's row ends up carrying the LATEST of the two events.
//    Reading it as already-enqueued would silently discard a push.

/** What one dispatch did — returned so `sendEvent` can log it and the tests can assert it. */
export interface DispatchResult {
  /** The `job_event` row id, or null when nothing subscribed and no row was written. */
  eventId: string | null;
  /** Job ids enqueued by THIS call. */
  enqueued: string[];
  /** Job ids that were already enqueued for this event — the idempotent path, not an error. */
  alreadyEnqueued: string[];
  /**
   * Job ids whose event was COALESCED into a pending debounced run rather than
   * enqueued (MOTIR-3483). Its own field rather than a fold into `enqueued` or
   * `alreadyEnqueued`, because it is neither: a run was neither created nor left
   * untouched — an existing one was moved and repointed at this event.
   */
  coalesced: string[];
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

  // ⚠️ THE MANIFEST LOAD IS EXPENSIVE AND IT LANDS ON A REQUEST PATH. Emitting is
  // POST-COMMIT and `createWorkItem` AWAITS it, so the first dispatch in a fresh
  // process sits inside a user's mutation: **6224 ms** measured, against 0 ms for
  // every dispatch after it. The bill is the SERVICE BAG the definitions reach
  // through `defineJob` — `lib/jobs/services.ts` alone is 8808 ms, against 3 ms
  // for the manifest module and 158 ms for the registry once services are warm.
  //
  // ⚠️ THERE USED TO BE A GUARD ABOVE THIS LINE AND ITS PREMISE IS GONE
  // (MOTIR-3418). While two substrates ran side by side, an empty
  // `MOTIR_POSTGRES_JOB_IDS` meant "enqueue nothing", so a deployment that had not
  // cut over could return before the load and pay nothing at all. With one lane
  // there is no such state: every emit has to resolve its subscribers, so every
  // process pays the load once, on its first emit. That is the cost of the
  // migration finishing, not a regression — production has paid it since the
  // event jobs were routed (MOTIR-3463).
  //
  // ⚠️ AND IT MUST NOT BE "FIXED" BY WARMING EAGERLY. That was tried twice —
  // during module evaluation, and from a `setTimeout(0)` — and both re-entered a
  // module graph that was still initializing (vite-node resolves imports through
  // promises, so a macrotask interleaves with graph evaluation): eleven job suites
  // failed to load with `ReferenceError: Cannot access '__vite_ssr_import_3__'
  // before initialization`. The same temporal-dead-zone shape ADR §12 measured at
  // build time, one level down.
  // The manifest is populated by evaluating the definition modules, and nothing
  // on a request path does that on its own — without this the subscriber set
  // reads empty and NOTHING IS ENQUEUED AT ALL (MOTIR-3458). Memoised: one
  // dynamic import per process, a resolved promise thereafter.
  await ensureJobManifestLoaded();
  const subscribers = manifestSubscribers(name);
  if (subscribers.length === 0) {
    return { eventId: null, enqueued: [], alreadyEnqueued: [], coalesced: [], failed: [] };
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
  const coalesced: string[] = [];
  const failed: Array<{ jobId: string; error: string }> = [];
  /** Set when at least one row became claimable NOW. A debounced row is due in the
   *  future, so waking a worker for it would be a poll that finds nothing. */
  let dueNow = false;

  // Sequential and individually guarded — property (1) in the header. A
  // `Promise.all` would be faster and would make one rejection reject the whole
  // batch, which is the behaviour this must not have.
  for (const sub of subscribers) {
    // Property (5): the job's own coalescing key, resolved PER SUBSCRIBER
    // because the option is declared per job. Null for every job that declares
    // none, AND for an event whose payload cannot supply one — which means "this
    // event gets its own row", never "merge it with everything else".
    const debounceKey = resolveDebounceKey(sub.debounce, data, sub.id);
    try {
      if (sub.debounce !== undefined && debounceKey !== null) {
        const outcome = await enqueueDebounced(sub, sub.debounce, debounceKey, {
          eventId: event.id,
          eventName: name,
          workspaceId,
        });
        (outcome === 'enqueued' ? enqueued : coalesced).push(sub.id);
        continue;
      }

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
      dueNow = true;
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
  if (dueNow) {
    await withSystemContext(async (tx) => {
      await notifyQueuedJob((sql) => tx.$executeRawUnsafe(sql));
    });
  }

  return { eventId: event.id, enqueued, alreadyEnqueued, coalesced, failed };
}

/**
 * ONE debounced subscriber's enqueue: coalesce into the pending run this key
 * already holds, or open a new window (MOTIR-3483).
 *
 * The read and the write are ONE transaction with the candidate row locked —
 * `findPendingDebouncedForUpdate` takes `FOR UPDATE` — because deciding the new
 * `run_at` from the row's `debounce_first_seen_at` is a read-derived write.
 *
 * ⚠️ A `P2002` HERE IS NOT "ALREADY ENQUEUED", and reading it that way would
 * silently drop a push. It means a CONCURRENT first arrival won the insert
 * between our empty read and our own, so the correct answer is to retry the
 * whole transaction ONCE: the second pass finds the winner's row, locks it, and
 * coalesces this event into it — which is exactly the outcome a serialized pair
 * of arrivals would have produced.
 *
 * One retry rather than a loop: the second pass can only lose the same way if a
 * THIRD arrival both inserted and was claimed in the interval, and at that point
 * reporting the failure is more useful than spinning on a request path.
 */
async function enqueueDebounced(
  sub: JobManifestEntry,
  debounce: NonNullable<JobManifestEntry['debounce']>,
  debounceKey: string,
  event: { eventId: string; eventName: string; workspaceId: string | null },
): Promise<'enqueued' | 'coalesced'> {
  const attempt = async (): Promise<'enqueued' | 'coalesced'> =>
    withSystemContext(async (tx) => {
      const pending = await jobQueueRepository.findPendingDebouncedForUpdate(
        sub.id,
        debounceKey,
        tx,
      );
      const now = new Date();
      if (pending) {
        await jobQueueRepository.coalesceDebounced(
          pending.id,
          {
            runAt: debouncedRunAt(debounce, now, pending.debounceFirstSeenAt),
            eventId: event.eventId,
            eventName: event.eventName,
            workspaceId: event.workspaceId,
          },
          tx,
        );
        return 'coalesced';
      }
      await jobQueueRepository.create(
        {
          jobId: sub.id,
          eventId: event.eventId,
          eventName: event.eventName,
          workspaceId: event.workspaceId,
          // The first arrival opens the window: due one whole `period` from now,
          // with nothing to cap against yet.
          runAt: debouncedRunAt(debounce, now, null),
          maxAttempts: sub.maxAttempts,
          idempotencyKey: null,
          debounceKey,
          debounceFirstSeenAt: now,
        },
        tx,
      );
      return 'enqueued';
    });

  try {
    return await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return attempt();
  }
}
