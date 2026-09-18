import { afterEach, describe, expect, it, vi } from 'vitest';

// A PARTIAL MANIFEST must not stand in for a loaded registry (Bug MOTIR-5716).
//
// `ensureJobManifestLoaded` short-circuited on "the manifest is non-empty",
// which is true the moment ANY module imports ONE job definition — the
// Monitoring page imports a constant from `monitorIssueReconcile` — and then
// the registry never loaded in that module layer: every event whose consumers
// had not been imported resolved to ZERO subscribers and was dropped with no
// log, no row and no dead letter. Found by MOTIR-5709's acceptance walk, where
// completing a bug after opening the Monitoring room emitted nothing at all.
//
// Each test starts from a FRESH module graph (`vi.resetModules`), because the
// failure only exists in a process whose first job-definition import is not
// the registry — which is exactly what every other job suite is not.

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('a partial manifest does not short-circuit the registry load', () => {
  it('importing ONE job definition first still resolves every transitioned consumer', async () => {
    vi.resetModules();
    // What `app/(authed)/settings/project/monitoring/page.tsx` does.
    await import('@/lib/jobs/definitions/monitorIssueReconcile');
    const { ensureJobManifestLoaded, manifestSubscribers, manifestJobs } =
      await import('@/lib/jobs/engine/subscribers');
    // The precondition the bug needs: the manifest is ALREADY non-empty.
    expect(manifestJobs().length).toBeGreaterThan(0);

    await ensureJobManifestLoaded();

    const { FAST_LANE_CONSUMER_IDS } = await import('@/lib/jobs/latencyBudget');
    expect(manifestSubscribers('work-item/transitioned').length).toBe(
      FAST_LANE_CONSUMER_IDS.length,
    );
  });

  it('the dispatcher, after that same partial import, reaches its first write instead of returning early', async () => {
    vi.resetModules();
    await import('@/lib/jobs/definitions/monitorIssueReconcile');
    const { jobEventRepository } = await import('@/lib/repositories/jobEventRepository');
    const { dispatchEventToEngine } = await import('@/lib/jobs/engine/dispatcher');
    // The event write is the first thing past the subscriber check. Refusing it
    // with a sentinel proves the check PASSED — and writes nothing.
    const create = vi
      .spyOn(jobEventRepository, 'create')
      .mockRejectedValue(new Error('reached the event write'));

    await expect(
      dispatchEventToEngine('work-item/transitioned', { workspaceId: 'ws-partial' }),
    ).rejects.toThrow('reached the event write');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
