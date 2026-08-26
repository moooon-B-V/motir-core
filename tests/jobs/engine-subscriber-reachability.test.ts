import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_ENGINE_JOBS_ENV } from '@/lib/jobs/engine/cutover';

// THE EMIT PATH RESOLVES THE REAL SUBSCRIBER SET (Story MOTIR-3415 · MOTIR-3458).
//
// ⚠️ THIS FILE DELIBERATELY CARRIES NO TOP-LEVEL `import '@/lib/jobs/registry'`.
//
// That import — at `tests/jobs/engine-dispatcher.test.ts:24`, and at the top of
// sixteen other suites — is precisely what kept this defect invisible through a
// nine-child story, a full vitest run and a green E2E lane. The engine's
// subscriber table is populated by MODULE EVALUATION, so any process that has
// imported the definitions for its own reasons sees a complete table. The
// process that emits events in production is not one of them.
//
// So the ONE shape that can fail for the right reason is to build the two sets
// from DIFFERENT MODULE GRAPHS and compare them. Deriving both from a single
// import makes the assertion unfalsifiable — which is the failure mode this file
// exists to catch, not a style preference.
//
// ⚠️ AND THE EMIT-PATH SIDE DRIVES `dispatchEventToEngine` RATHER THAN CALLING
// THE LOADER. The manifest is populated by a dynamic import the dispatcher
// awaits, so a test that invoked that loader by hand would be asserting its own
// setup rather than the production path. Dispatching an event with nothing
// routed returns before touching the database and is exactly the call every real
// emit makes.
//
// ADR: `docs/decisions/job-queue-foundation.md` §12.

/** What the EMIT PATH sees, after doing what the emit path does. */
async function jobsVisibleToTheEmitPath(): Promise<string[]> {
  vi.resetModules();
  // Exactly what a Next.js request path pulls in, and nothing else.
  await import('@/lib/jobs/sendEvent');
  const { dispatchEventToEngine } = await import('@/lib/jobs/engine/dispatcher');
  await dispatchEventToEngine('work-item/transitioned', { workspaceId: null });
  // Read the manifest from THE SAME fresh graph.
  const { manifestJobs } = await import('@/lib/jobs/engine/manifest');
  return manifestJobs()
    .map((d) => d.id)
    .sort();
}

/** What the WORKER sees — the full registry graph, the ground truth. */
async function jobsVisibleToTheWorker(): Promise<string[]> {
  vi.resetModules();
  await import('@/lib/jobs/registry');
  const { engineJobs } = await import('@/lib/jobs/engine/registry');
  return engineJobs()
    .map((d) => d.id)
    .sort();
}

/** The fan-out an EMIT-PATH graph resolves for one event name. */
async function fanOutVisibleToTheEmitPath(eventName: string): Promise<string[]> {
  vi.resetModules();
  await import('@/lib/jobs/sendEvent');
  const { dispatchEventToEngine } = await import('@/lib/jobs/engine/dispatcher');
  await dispatchEventToEngine(eventName, { workspaceId: null });
  const { manifestSubscribers } = await import('@/lib/jobs/engine/manifest');
  return manifestSubscribers(eventName)
    .map((d) => d.id)
    .sort();
}

// ⚠️ SOMETHING MUST BE ROUTED FOR THE EMIT PATH TO RESOLVE SUBSCRIBERS AT ALL.
// `dispatchEventToEngine` returns before loading the manifest when the routing
// set is empty — correctly, because with nothing routed the answer is "enqueue
// nothing" whatever the manifest holds, and the load is expensive enough that
// paying it on every emit of an un-cut-over deployment was a real regression.
// So this guard routes a job first, which is also the state it is describing:
// the question it asks is whether an operator who HAS cut a job over gets the
// real subscriber set.
const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];

beforeEach(() => {
  vi.resetModules();
  process.env[JOB_ENGINE_JOBS_ENV] = 'status-derivation/transitioned';
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

describe('the job manifest is complete on the emit path', () => {
  it('sees the SAME job set as the full registry, from a different module graph', async () => {
    const emitPath = await jobsVisibleToTheEmitPath();
    const worker = await jobsVisibleToTheWorker();

    // The worker's view is the ground truth — if IT is empty the harness is
    // broken rather than the code, and saying so here stops a vacuous pass.
    expect(worker.length, 'the full registry resolved no jobs at all').toBeGreaterThan(0);
    expect(emitPath).toEqual(worker);
  });

  it('resolves the FOUR fast-lane consumers of work-item/transitioned', async () => {
    // The concrete case the whole epic turns on: four consumers against a
    // five-slot account is the arithmetic behind MOTIR-3413.
    expect(await fanOutVisibleToTheEmitPath('work-item/transitioned')).toEqual([
      'automation-engine/transitioned',
      'notification-fan-in/transitioned',
      'status-derivation/transitioned',
      'watcher-notify/transitioned',
    ]);
  });

  it('answers the Inngest question from a REAL set once the emit path has loaded', async () => {
    vi.resetModules();
    await import('@/lib/jobs/sendEvent');
    const { dispatchEventToEngine, hasInngestSubscribers } =
      await import('@/lib/jobs/engine/dispatcher');

    // BEFORE the emit path has run, the manifest is empty and the SAFE DEFAULT is
    // what answers. That is the state which shipped, and it is exactly why the
    // defect was invisible: the fallback was doing the whole job.
    expect(hasInngestSubscribers('work-item/transitioned')).toBe(true);

    await dispatchEventToEngine('work-item/transitioned', { workspaceId: null });

    const { manifestSubscribers } = await import('@/lib/jobs/engine/manifest');
    expect(manifestSubscribers('work-item/transitioned')).toHaveLength(4);
    // Still true — but now because four real subscribers are unrouted, not
    // because nothing was known.
    expect(hasInngestSubscribers('work-item/transitioned')).toBe(true);
  });

  it('ORDERS the load before the synchronous Inngest question', async () => {
    // `hasInngestSubscribers` cannot await the loader, so it is correct only
    // because `sendEvent` dispatches to the engine FIRST. That ordering is
    // load-bearing, so it is asserted rather than assumed.
    const source = readFileSync(join(__dirname, '..', '..', 'lib', 'jobs', 'sendEvent.ts'), 'utf8');
    const dispatchAt = source.indexOf('await dispatchEventToEngine(');
    const askAt = source.indexOf('hasInngestSubscribers(name)');
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeLessThan(askAt);
  });

  it('keeps the MANIFEST and the engine REGISTRY in step — they are one registration', async () => {
    // The two tables are written on adjacent lines inside `defineJob`, so they
    // cannot drift by anyone forgetting. This asserts that property rather than
    // trusting it, because a second list is exactly the failure mode
    // `engine/registry.ts`'s own header refuses.
    vi.resetModules();
    await import('@/lib/jobs/registry');
    const { engineJobs } = await import('@/lib/jobs/engine/registry');
    const { manifestJobs } = await import('@/lib/jobs/engine/manifest');

    expect(manifestJobs()).toEqual(
      engineJobs().map((d) => ({
        id: d.id,
        trigger: d.trigger,
        cron: d.cron,
        maxAttempts: d.maxAttempts,
        retryPolicy: d.retryPolicy,
        idempotency: d.idempotency,
      })),
    );
    // …and the manifest carries NO handler, which is the one field that would
    // drag the service graph onto an emitting request — nor `catchUp`, which is
    // the scheduler's (MOTIR-3416) and is read off the registry in the worker.
    // The projection above is the manifest's OWN key set, so a field added to
    // the registry for a worker-side consumer does not have to appear here.
    for (const entry of manifestJobs()) {
      expect(entry).not.toHaveProperty('handler');
      expect(entry).not.toHaveProperty('catchUp');
    }
  });
});
