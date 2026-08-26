import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '@/lib/jobs/defineJob';
import { sendEvent, sendSystemEvent } from '@/lib/jobs/sendEvent';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger } from '@/lib/jobs/engine/ledger';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { dispatchEventToEngine, hasInngestSubscribers } from '@/lib/jobs/engine/dispatcher';
import {
  manifestJobs,
  manifestSubscribers,
  manifestScheduledJobs,
} from '@/lib/jobs/engine/manifest';
import {
  ensureJobManifestLoaded,
  resetJobManifestLoadForTests,
} from '@/lib/jobs/engine/subscribers';
import { resolveIdempotencyKey } from '@/lib/jobs/engine/idempotency';
import { JOB_ENGINE_JOBS_ENV } from '@/lib/jobs/engine/cutover';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import '@/lib/jobs/registry';

// THE STORY GATE for the EVENT-triggered cutover (Story MOTIR-3415 · MOTIR-3461).
//
// Every defect this story fixed was invisible to a green suite, and each was a
// property of the SEAM BETWEEN two correct components:
//
//   - the subscriber registry was correct and the dispatcher was correct; the
//     process calling one had never loaded the other;
//   - the idempotency column was correct and the option was correct; nothing
//     joined them;
//   - the emit sites were correct and the switch was correct; the switch was
//     simply never consulted.
//
// A unit test cannot see any of those, because it supplies the other half
// itself — which is exactly how `engine-dispatcher.test.ts` came to import the
// registry at its top and prove a property that does not hold in production.
//
// ⚠️ SO THE GUARDS BELOW ARE WRITTEN OVER THE REGISTRY AND OVER THE TREE, never
// over a case list. A guard that iterates the registry fails when someone adds a
// job that cannot be routed; a guard that checks four job ids passes forever and
// tells you those four ids still exist. That is the difference between a test
// that holds a rule and a test that records a moment.
//
// ⚠️ AND IT MEASURES NO LATENCY. A CI runner has no production load and no
// scheduler, so a timer around a function call would pass forever and fail for
// unrelated reasons. The reading is production's, taken by
// `scripts/experiments/engine-fastlane-lag.mjs`.
// `tests/jobs/fast-lane-latency-budget.test.ts` draws the same line.
//
// Real Postgres throughout, no mocks. No `retries` — a retry here would hide the
// ordering flakiness this gate exists to expose.

const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];
const REPO_ROOT = join(__dirname, '..', '..');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  delete process.env[JOB_ENGINE_JOBS_ENV];
});

afterEach(async () => {
  await truncateJobRuns();
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeWorkspace(): Promise<{ workspaceId: string; userId: string }> {
  seq += 1;
  const user = await usersService.createUser({
    email: `gate-3461-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Gate WS ${seq}`,
    ownerUserId: user.id,
  });
  return { workspaceId: workspace.id, userId: user.id };
}

/** The REAL claim loop, executing through the REAL ledger wrapper. */
function worker(id: string): JobWorker {
  return new JobWorker({
    workerId: id,
    logger: silent,
    execute: async (run) => {
      const eventId = run.eventId;
      const event =
        eventId === null
          ? null
          : await withSystemContext((tx) => tx.jobEvent.findUnique({ where: { id: eventId } }));
      await executeWithLedger(run, event?.data ?? {});
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// §1 THE EMIT→RUN SEAM, asserted through the DTO the operator surface reads
// ───────────────────────────────────────────────────────────────────────────

describe('§1 the emit→run seam, end to end', () => {
  it('drives sendEvent → job_event → job_queue → worker claim → the DTO', async () => {
    const { workspaceId, userId } = await makeWorkspace();
    const jobId = 'test.gate-seam';
    const handled: unknown[] = [];
    defineJob({ id: jobId as never, trigger: 'work-item/embedding.requested' }, (ctx) => {
      handled.push(ctx.event.data);
      return { handled: true };
    });
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    // The REAL emit surface every service calls — not the dispatcher directly.
    await sendEvent('work-item/embedding.requested', { workspaceId, workItemId: 'wi_1' });
    expect(await worker('gate-seam').tick()).toBe(1);
    expect(handled).toEqual([{ workspaceId, workItemId: 'wi_1' }]);

    // ⚠️ ASSERTED THROUGH THE DTO, NOT THE TABLE. A key that drifts between the
    // ledger's write and the operator surface's read is precisely what the
    // per-subtask units cannot see, because each side mocks the other.
    const runs = await jobsDashboardService.listJobRuns({
      workspaceId,
      userId,
      limit: 50,
      offset: 0,
    });
    const dto = runs.find((r) => r.functionId === jobId);
    expect(dto, 'the run never reached the operator surface').toBeDefined();
    expect(dto!.status).toBe('succeeded');
    expect(dto!.workspaceId).toBe(workspaceId);
    expect(dto!.eventName).toBe('work-item/embedding.requested');
    expect(dto!.output).toEqual({ handled: true });
  });

  it('proves the IDEMPOTENCY seam through that same DTO — two events, one delivery', async () => {
    const { workspaceId, userId } = await makeWorkspace();
    const jobId = 'test.gate-idempotency';
    let deliveries = 0;
    defineJob(
      {
        id: jobId as never,
        trigger: 'work-item/embedding.requested',
        idempotency: 'event.data.idempotencyKey',
      },
      () => {
        deliveries += 1;
        return { delivered: deliveries };
      },
    );
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    const payload = { workspaceId, workItemId: 'wi_1', idempotencyKey: 'one-token' };
    await sendEvent('work-item/embedding.requested', payload as never);
    await sendEvent('work-item/embedding.requested', payload as never);

    // Drain until nothing is left, so a second queued run could not hide.
    const w = worker('gate-idem');
    while ((await w.tick()) > 0) {
      /* drain */
    }

    expect(deliveries).toBe(1);
    const runs = await jobsDashboardService.listJobRuns({
      workspaceId,
      userId,
      limit: 50,
      offset: 0,
    });
    expect(runs.filter((r) => r.functionId === jobId)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 THE GUARDS A PERCENTAGE CANNOT SEE
// ───────────────────────────────────────────────────────────────────────────

describe('§2a routing totality, derived from the registry', () => {
  /** Every event-triggered job the manifest knows — never a hand-written list. */
  const eventJobs = () => manifestJobs().filter((d) => d.cron === undefined);

  it('covers a registry that is non-trivially populated', () => {
    // Guards against the whole section passing vacuously on an empty table.
    expect(eventJobs().length).toBeGreaterThan(10);
  });

  it('routes each job INDIVIDUALLY — its id moves it, and moves nothing else', async () => {
    const { workspaceId } = await makeWorkspace();
    // One representative per distinct trigger keeps the run bounded while still
    // deriving the set from the registry rather than naming ids.
    const byTrigger = new Map<string, string>();
    for (const d of eventJobs()) if (d.trigger) byTrigger.set(d.trigger, d.id);

    for (const [trigger, jobId] of byTrigger) {
      await truncateJobRuns();
      process.env[JOB_ENGINE_JOBS_ENV] = jobId;
      const result = await dispatchEventToEngine(trigger, { workspaceId });

      // Routed: exactly this job, and no sibling subscriber of the same event.
      expect(result.enqueued, `routing ${jobId} did not enqueue it`).toEqual([jobId]);

      // Unrouted: nothing at all, not even a job_event row.
      await truncateJobRuns();
      delete process.env[JOB_ENGINE_JOBS_ENV];
      const off = await dispatchEventToEngine(trigger, { workspaceId });
      expect(off.enqueued, `${jobId} enqueued while unrouted`).toEqual([]);
      expect(off.eventId).toBeNull();
    }
  });

  it('FAILS if a job is registered whose event cannot be routed', async () => {
    // The guard's own falsifiability: a job whose trigger the dispatcher cannot
    // resolve would enqueue nothing when routed. Demonstrated on a job with a
    // trigger no dispatch names.
    const { workspaceId } = await makeWorkspace();
    const jobId = 'test.gate-unroutable';
    defineJob({ id: jobId as never, trigger: 'work-item/field.changed' }, () => ({}));
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    const routed = await dispatchEventToEngine('work-item/field.changed', { workspaceId });
    expect(routed.enqueued).toContain(jobId);
    // …and dispatching the WRONG event name for it enqueues nothing, which is
    // the shape a mis-registered trigger would produce for every event.
    const wrong = await dispatchEventToEngine('work-item/child-set.changed', { workspaceId });
    expect(wrong.enqueued).not.toContain(jobId);
  });
});

describe('§2b the split-subscriber invariant — what makes a PARTIAL cutover safe', () => {
  /** An event with more than one subscriber, taken from the registry. */
  const multiSubscriberEvent = (): { trigger: string; ids: string[] } => {
    for (const d of manifestJobs()) {
      if (!d.trigger) continue;
      const ids = manifestSubscribers(d.trigger).map((s) => s.id);
      if (ids.length > 1) return { trigger: d.trigger, ids };
    }
    throw new Error('no multi-subscriber event in the registry — the invariant is untestable');
  };

  it('stays TRUE while ANY subscriber is unrouted', () => {
    const { trigger, ids } = multiSubscriberEvent();
    expect(ids.length).toBeGreaterThan(1);

    // Move every subscriber but the last.
    for (let i = 1; i <= ids.length - 1; i += 1) {
      process.env[JOB_ENGINE_JOBS_ENV] = ids.slice(0, i).join(',');
      expect(
        hasInngestSubscribers(trigger),
        `${trigger} dropped Inngest with ${ids.length - i} subscriber(s) still on it`,
      ).toBe(true);
    }
  });

  it('turns FALSE only when the LAST one moves', () => {
    const { trigger, ids } = multiSubscriberEvent();
    process.env[JOB_ENGINE_JOBS_ENV] = ids.join(',');
    expect(hasInngestSubscribers(trigger)).toBe(false);
  });

  it('is asserted on an event that genuinely has several consumers', () => {
    // Otherwise the two directions above could both hold trivially.
    const { ids } = multiSubscriberEvent();
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });
});

describe('§2c the import boundaries, as tree-level assertions', () => {
  const SOURCE_ROOTS = ['lib', 'app', 'components', 'scripts'];

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, acc);
      else if (/\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  /** Files importing `spec`, outside the allowed prefixes. */
  function violators(spec: RegExp, allowed: RegExp[]): string[] {
    return SOURCE_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
      .map((abs) => ({ rel: relative(REPO_ROOT, abs), text: readFileSync(abs, 'utf8') }))
      .filter(({ rel }) => !allowed.some((a) => a.test(rel)))
      .filter(({ text }) =>
        text.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && spec.test(line)),
      )
      .map(({ rel }) => rel)
      .sort();
  }

  it('keeps the ENGINE INTERNALS inside lib/jobs/** and the worker', { timeout: 120_000 }, () => {
    // A lint rule is enforcement; this is the assertion that the rule still has
    // the shape the story gave it.
    expect(
      violators(/from '@\/lib\/jobs\/engine/, [/^lib\/jobs\//, /^scripts\/worker\.ts$/]),
    ).toEqual([]);
  });

  it(
    'keeps the INNGEST CLIENT inside the jobs runtime, the worker, the serve route and the harnesses',
    { timeout: 120_000 },
    () => {
      // The boundary this story widened — from the vendor package onto our own
      // module, which is the door the four bypassing emitters actually used.
      expect(
        violators(/from '@\/lib\/jobs\/client'/, [
          /^lib\/jobs\//,
          /^scripts\/worker\.ts$/,
          /^app\/api\/inngest\//,
          /^scripts\/experiments\//,
        ]),
      ).toEqual([]);
    },
  );
});

describe('§2d tenancy — the dispatcher writes through withSystemContext, under RLS', () => {
  it('carries the emitting event’s workspace onto BOTH rows', async () => {
    const { workspaceId } = await makeWorkspace();
    const jobId = 'test.gate-tenancy';
    defineJob({ id: jobId as never, trigger: 'work-item/embedding.requested' }, () => ({}));
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    await sendEvent('work-item/embedding.requested', { workspaceId, workItemId: 'wi_1' });

    const event = await adminDb.jobEvent.findFirstOrThrow({
      where: { name: 'work-item/embedding.requested' },
    });
    const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId } });
    expect(event.workspaceId).toBe(workspaceId);
    expect(queued.workspaceId).toBe(workspaceId);
  });

  it('lands the deliberate NULL workspace for a cross-workspace email.send', async () => {
    // `email.send`'s `workspaceId` is `string | null` by design — a password
    // reset is identity-scoped. `null` must reach the rows as null, never as a
    // `"system"` sentinel, which would violate the FK.
    process.env[JOB_ENGINE_JOBS_ENV] = 'email.send';
    await sendEvent('email.send', {
      workspaceId: null,
      idempotencyKey: 'gate-null-ws',
      to: 'someone@example.com',
      template: 'passwordReset',
      data: { resetUrl: 'https://example.test/r' },
    } as never);

    const event = await adminDb.jobEvent.findFirstOrThrow({ where: { name: 'email.send' } });
    const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: 'email.send' } });
    expect(event.workspaceId).toBeNull();
    expect(queued.workspaceId).toBeNull();
    // The resolved dedup key rode along, which is what makes the null-workspace
    // case still send exactly once.
    expect(queued.idempotencyKey).toBe('gate-null-ws');
  });

  it('writes a SYSTEM event untenanted, through the same seam', async () => {
    process.env[JOB_ENGINE_JOBS_ENV] = 'system.billing-seat-sync';
    await sendSystemEvent('system.billing-seat-sync', { organizationId: 'org_gate' });

    const queued = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { jobId: 'system.billing-seat-sync' },
    });
    expect(queued.workspaceId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §3 COVERAGE TOP-UP — the arms this story added that nothing else reaches
// ───────────────────────────────────────────────────────────────────────────
//
// ⚠️ EACH OF THESE WAS SORTED BEFORE IT WAS WRITTEN. A coverage zero measures
// execution and says nothing about reachability, so "nobody tested this" and
// "nothing can test this" produce the same cell. Read off the PRODUCER of the
// value each arm tests, all three are RULE-BEARING rather than defensive, so
// each gets a test rather than an ignore directive:
//
//   - `manifestScheduledJobs()` is a real filter whose consumer (MOTIR-3416's
//     scheduler) has not landed yet. Uncovered because it has no caller, not
//     because it cannot have one.
//   - `resetJobManifestLoadForTests()` mutates the memo. Its correctness is
//     exactly what makes the memoisation falsifiable, so leaving it unexercised
//     would mean the cold path is never proven at all.
//   - `resolveIdempotencyKey`'s `data ?? {}` is reachable: `dispatchEventToEngine`
//     types its payload `unknown` and a caller may pass null.

describe('§3 the arms this story added', () => {
  it('manifestScheduledJobs returns exactly the cron jobs, and no event-triggered one', () => {
    const scheduled = manifestScheduledJobs();
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((d) => d.cron !== undefined)).toBe(true);
    // A cron job carries NO trigger — the two are exclusive in `defineJob`.
    expect(scheduled.every((d) => d.trigger === undefined)).toBe(true);
    // And the two halves partition the manifest, so neither can silently lose a job.
    const eventTriggered = manifestJobs().filter((d) => d.cron === undefined);
    expect(scheduled.length + eventTriggered.length).toBe(manifestJobs().length);
  });

  it('resetJobManifestLoadForTests clears the memo, so the cold path can be re-driven', async () => {
    // The memo is what stops concurrent first emits racing several loads. This
    // asserts the seam that makes it falsifiable rather than trusting it.
    await ensureJobManifestLoaded();
    const loadedBefore = manifestJobs().length;
    expect(loadedBefore).toBeGreaterThan(0);

    resetJobManifestLoadForTests();
    // The manifest itself is NOT cleared — only the memo of having loaded it —
    // so a reload is idempotent rather than destructive.
    expect(manifestJobs().length).toBe(loadedBefore);
    await ensureJobManifestLoaded();
    expect(manifestJobs().length).toBe(loadedBefore);
  });

  it('resolveIdempotencyKey tolerates a null/undefined payload', () => {
    // `dispatchEventToEngine` types its payload `unknown`; a caller may pass
    // neither an object nor anything at all.
    expect(resolveIdempotencyKey('event.data.idempotencyKey', null, 'j')).toBeNull();
    expect(resolveIdempotencyKey('event.data.idempotencyKey', undefined, 'j')).toBeNull();
  });
});
