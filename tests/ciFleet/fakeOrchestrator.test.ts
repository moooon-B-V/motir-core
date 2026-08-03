import { beforeEach, describe, expect, it } from 'vitest';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import type { ContainerSpec, UsageAttribution } from '@/lib/orchestrator/types';

// THE PORT'S CONTRACT, asserted against the `fake` adapter (Story MOTIR-1916 ·
// MOTIR-1921) — `docs/decisions/ci-runner-fleet.md` §4, rule 2.
//
// ⚠️ THESE ARE STATEMENTS ABOUT THE PORT, NOT ABOUT THE FAKE. Every one of them
// is a guarantee the Fly adapter must also keep, and several are unassertable
// against Fly without booting real machines — "exactly one usage row per
// provisioned handle" and "a handle that reached `job_completed` is never
// provisioned again" are properties of a SEQUENCE, and a sequence against a real
// provider is an integration environment, not a test. This is the file
// MOTIR-1927 extends; it exists now because shipping the fake in this PR is what
// makes the port demonstrably a port rather than an interface with one caller.

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: 'motir/ci-runner@sha256:abc',
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit' },
  timeoutSeconds: 3600,
  region: 'iad',
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

beforeEach(() => {
  fakeOrchestrator.reset();
});

describe('the fake satisfies the same port contract as Fly', () => {
  it('declares itself as a provider, so a usage row is attributable to it', () => {
    expect(fakeOrchestrator.provider).toBe('fake');
  });

  it('boots one container per provision and hands back an opaque handle', async () => {
    const a = await fakeOrchestrator.provision(SPEC);
    const b = await fakeOrchestrator.provision(SPEC);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ provider: 'fake', region: 'iad' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([a.id, b.id]);
  });

  it('a provision that throws leaves NO container behind', async () => {
    // The port's words: "throws a typed error; NEVER leaves an untracked
    // container".
    fakeOrchestrator.failNextProvision('nope');
    await expect(fakeOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
    });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('teardown RETURNS the cost row — metering cannot be skipped', async () => {
    // §4's one non-obvious decision: you cannot destroy a container without
    // producing its cost row, because the same call does both.
    const handle = await fakeOrchestrator.provision(SPEC);
    const usage = await fakeOrchestrator.teardown(handle, 'job_completed', ATTRIBUTION);
    expect(usage.handleId).toBe(handle.id);
    expect(usage.teardownReason).toBe('job_completed');
    expect(usage.orgId).toBe('org-1');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('teardown is IDEMPOTENT and yields exactly ONE usage row per handle', async () => {
    // §5's invariant. Both the `finally` path and the reaper can reach the same
    // container; a second row would break the invariant as surely as none would.
    const handle = await fakeOrchestrator.provision(SPEC);
    const first = await fakeOrchestrator.teardown(handle, 'job_completed', ATTRIBUTION);
    const second = await fakeOrchestrator.teardown(handle, 'reaped', ATTRIBUTION);
    expect(second).toBe(first);
    expect(second.teardownReason).toBe('job_completed');
  });

  it('describe reports GONE for a handle the provider no longer has', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id);
    expect(await fakeOrchestrator.describe(handle)).toMatchObject({
      exists: false,
      terminal: true,
      state: 'destroyed',
    });
  });

  it('a `never_start` container reports no start instant', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const handle = await fakeOrchestrator.provision(SPEC);
    const status = await fakeOrchestrator.describe(handle);
    expect(status).toMatchObject({ exists: true, state: 'created', startedAt: null });
  });

  it("a `hang` container never becomes terminal — only the caller's timeout ends it", async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).terminal).toBe(false);
    expect((await fakeOrchestrator.describe(handle)).terminal).toBe(false);
  });

  it('a handle that reached `job_completed` is never live again — NO REUSE (§7.1)', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    await fakeOrchestrator.teardown(handle, 'job_completed', ATTRIBUTION);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    // A second provision is a NEW container with a new id, never the old one
    // brought back. Reuse is a cross-tenant compromise path (§7.1).
    const next = await fakeOrchestrator.provision(SPEC);
    expect(next.id).not.toBe(handle.id);
  });

  it('surfaces a teardown failure rather than pretending the container is gone', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.failNextTeardown();
    await expect(
      fakeOrchestrator.teardown(handle, 'job_completed', ATTRIBUTION),
    ).rejects.toMatchObject({ code: 'ORCHESTRATOR_API_FAILED' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([handle.id]);
  });

  // ── the EXIT REASON, driven through the fake (MOTIR-2025) ───────────────

  it('a container can be completed with a chosen exit code, and `describe` reports it', async () => {
    // The control the index dispatcher is built against: the whole classification
    // it will do — `20` re-dispatch, `50` mint a fresh credential — is a function
    // of this number, and this is the only way to exercise every branch of it
    // without booting real containers.
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id, { exitCode: 50 });
    expect((await fakeOrchestrator.describe(handle)).exitCode).toBe(50);
  });

  it('reports the code of a container that has already SELF-DESTROYED', async () => {
    // ⚠️ `exists: false` IS THE HAPPY PATH — `auto_destroy` means a successful
    // run ends with the machine deleting itself. A fake that dropped the code
    // there could not exercise the one case that matters most: a container that
    // ran, failed at BUILD, and took itself away.
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id, { exitCode: 30 });
    const status = await fakeOrchestrator.describe(handle);
    expect(status.exists).toBe(false);
    expect(status.exitCode).toBe(30);
  });

  it('distinguishes exit 0 from "stopped, code unknown"', async () => {
    const succeeded = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(succeeded.id, { exitCode: 0 });
    expect((await fakeOrchestrator.describe(succeeded)).exitCode).toBe(0);

    // The DEFAULT is `null`, not `0`: a machine that deleted itself before
    // anyone read it genuinely has no observable code, and defaulting to success
    // would let a consumer that never handles the unknown case pass its tests.
    const unknown = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(unknown.id);
    expect((await fakeOrchestrator.describe(unknown)).exitCode).toBeNull();
  });

  it('a running container has no exit code yet', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).exitCode).toBeNull();
  });

  it('an INDEX spec — no job id at all — provisions and is recorded as itself', async () => {
    // The type-level half of the card: a spec with `workload:
    // 'code_graph_index'` and a NULL `workflowJobId` type-checks and provisions.
    // Before this it could not be expressed at all.
    const indexSpec: ContainerSpec = {
      ...SPEC,
      workload: 'code_graph_index',
      workflowJobId: null,
    };
    const handle = await fakeOrchestrator.provision(indexSpec);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([handle.id]);
    expect(fakeOrchestrator.specs.at(-1)).toMatchObject({
      workload: 'code_graph_index',
      workflowJobId: null,
    });

    const usage = await fakeOrchestrator.teardown(handle, 'job_completed', {
      ...ATTRIBUTION,
      workload: 'code_graph_index',
      workflowJobId: null,
    });
    // The cost row says WHICH workload it was — the fleet org is shared, so a
    // row that could not would merge three margins into one number.
    expect(usage.workload).toBe('code_graph_index');
    expect(usage.workflowJobId).toBeNull();
  });
});

describe('reap against the fake', () => {
  it('destroys only containers older than the cutoff', async () => {
    const old = await fakeOrchestrator.provision(SPEC);
    const fresh = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.backdate(old.id, new Date(Date.now() - 7_200_000));

    const usages = await fakeOrchestrator.reap(
      new Date(Date.now() - 3_600_000),
      async () => ATTRIBUTION,
    );

    expect(usages.map((u) => u.handleId)).toEqual([old.id]);
    expect(usages[0]!.teardownReason).toBe('reaped');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([fresh.id]);
  });

  it('destroys an unattributable orphan but emits no cost row for it', async () => {
    const orphan = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.backdate(orphan.id, new Date(Date.now() - 7_200_000));
    const usages = await fakeOrchestrator.reap(new Date(Date.now() - 3_600_000), async () => null);
    expect(usages).toEqual([]);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('skips containers that are already gone', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.backdate(handle.id, new Date(Date.now() - 7_200_000));
    fakeOrchestrator.completeJob(handle.id);
    expect(await fakeOrchestrator.reap(new Date(), async () => ATTRIBUTION)).toEqual([]);
  });
});

describe('the control surface fails loudly on an unknown container', () => {
  it('completeJob throws rather than silently no-opping', async () => {
    // A test that arranges the wrong id would otherwise assert against a
    // lifecycle that never happened.
    expect(() => fakeOrchestrator.completeJob('nope')).toThrow(/no container nope/);
  });

  it('backdate throws rather than silently no-opping', () => {
    expect(() => fakeOrchestrator.backdate('nope', new Date())).toThrow(/no container nope/);
  });

  it('reset clears every container and every arranged failure', async () => {
    await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.failNextProvision();
    fakeOrchestrator.setBootBehaviour('hang');
    fakeOrchestrator.reset();

    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([]);
    // The arranged failure was cleared, so this resolves.
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).state).toBe('started');
  });
});

// ── A handle the provider has never heard of ────────────────────────────────

describe('a handle from BEFORE a restart — the provider knows nothing about it', () => {
  /**
   * The port persists handles precisely so teardown and the reaper survive the
   * process that booted the container (`ContainerHandle`'s own doc). So both
   * operations are reachable with a handle the in-memory adapter has no record
   * of, and neither may throw: the reason the handle was persisted is that the
   * process holding the state died.
   */
  const STRANGER = {
    provider: 'fake' as const,
    id: 'machine-from-a-previous-life',
    region: 'iad',
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
  };

  it('describe reports it GONE, dating it from the HANDLE rather than inventing one', async () => {
    const status = await fakeOrchestrator.describe(STRANGER);

    expect(status).toMatchObject({ exists: false, terminal: true, state: 'destroyed' });
    // The handle's own instant is the only honest source left.
    expect(status.createdAt).toEqual(STRANGER.createdAt);
    expect(status.startedAt).toBeNull();
    expect(status.stoppedAt).toBeNull();
  });

  it('teardown still produces its cost row, from the handle and the caller’s observation', async () => {
    const observedStartedAt = new Date(STRANGER.createdAt.getTime() + 4_000);

    const usage = await fakeOrchestrator.teardown(STRANGER, 'reaped', {
      ...ATTRIBUTION,
      observedStartedAt,
    });

    // The metering guarantee does not weaken just because the adapter lost its
    // memory — that is the case `observedStartedAt` exists for.
    expect(usage.handleId).toBe(STRANGER.id);
    expect(usage.createdAt).toEqual(STRANGER.createdAt);
    expect(usage.startedAt).toEqual(observedStartedAt);
    expect(usage.teardownReason).toBe('reaped');
    expect(usage.billableSeconds).toBeGreaterThan(0);
  });

  it('teardown of an unknown handle with NO observed start costs nothing, and still writes a row', async () => {
    const usage = await fakeOrchestrator.teardown(STRANGER, 'provision_failed', ATTRIBUTION);

    expect(usage.startedAt).toBeNull();
    expect(usage.billableSeconds).toBe(0);
    expect(Number(usage.costUsd)).toBe(0);
  });
});
