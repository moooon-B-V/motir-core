import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import {
  fleetCeilingService,
  describeFleetCensus,
  type FleetInFlightCensus,
  type FleetSlotVerdict,
} from '@/lib/services/fleetCeilingService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  FLEET_WORKLOADS,
  FLEET_WORKLOAD_KINDS,
  SLOT_BACKED_WORKLOADS,
  type FleetWorkloadKind,
} from '@/lib/ciFleet/workloads';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { truncateAuthTables } from '../helpers/db';

// THE CROSS-WORKLOAD FLEET CEILING against real Postgres (Story MOTIR-1916 ·
// MOTIR-1997).
//
// ⚠️ WHAT THIS SUITE HAS TO PROVE THAT MOTIR-1922's CANNOT. That suite proves a
// ceiling over CI. This one proves a ceiling over CI *and* the workloads that
// share the Fly org and write no runner intent — index containers (MOTIR-1981 /
// MOTIR-1990) and hosted agents (Epic 9). The failure it exists to catch is the
// one measured in production on 2026-08-02: two workloads each individually
// within a cap of 2, four containers actually running, and neither number
// meaning what it said. So every case here mixes workloads on purpose; a case
// that only exercises CI belongs in the sibling file.
//
// Everything load-bearing is REAL: Postgres, the shared `fleet` admission lock
// and its `FOR UPDATE`, both counted tables, the claim's compare-and-set and the
// slot's `ON CONFLICT`. The ONE thing stubbed is the motir-ai HTTP boundary
// (global `fetch`), because the CI gate's third guard reads a credit balance
// that is by definition on the other side of it.
//
// ⚠️ THE CLOCK IS PINNED because slot expiry is a real comparison against a
// Date the service binds. An unpinned clock would make the expiry cases race the
// wall clock instead of asserting the branch.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-08-02T12:00:00.000Z');
/** Longer than any container Motir boots — the shipped default's shape. */
const TTL_SECONDS = 3_600;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const suffix = Math.floor(Math.random() * 1_000_000);
  const user = await usersService.createUser({
    email: `fleet-ceiling-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${Math.floor(Math.random() * 900 + 100)}`,
  });
  if (options.isMeta) {
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedIntent(
  fx: Fixture,
  overrides: { status?: string } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9001',
      runAttempt: 1,
      jobId: String(90_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
    },
  });
}

let refSeq = 0;

/** Reserve one container for a NON-CI workload through the real path — the
 *  admission every future workload gets by calling `reserve` and nothing more. */
async function reserve(
  workload: FleetWorkloadKind,
  fx?: Fixture,
  ref = `run-${(refSeq += 1)}`,
): Promise<{ ref: string; verdict: FleetSlotVerdict }> {
  const verdict = await fleetCeilingService.reserve(
    {
      workload,
      ref,
      organizationId: fx?.organizationId ?? null,
      workspaceId: fx?.workspaceId ?? null,
      ttlSeconds: TTL_SECONDS,
    },
    NOW,
  );
  return { ref, verdict };
}

function stubMotirAi(balance = 1_000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}

async function census(): Promise<FleetInFlightCensus> {
  return withSystemContext((tx) => fleetCeilingService.census(NOW, tx));
}

beforeEach(async () => {
  await truncateAuthTables();
  await db.fleetInFlightSlot.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // The per-project cap is deliberately lifted in nearly every case here: this
  // suite is about the case per-workload caps CANNOT catch, so a per-project
  // refusal would mask exactly the branch under test.
  vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '50');
  stubMotirAi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// ── The registry, and the totality guard that keeps it honest ───────────────

describe('the fleet workload REGISTRY', () => {
  // The compile-time guard is the `Record<FleetWorkloadKind, …>` itself; this is
  // the runtime half — a counter that was registered but wired to nothing would
  // type-check and count nothing.
  it('gives EVERY workload kind a counter, and counts them all', async () => {
    expect(FLEET_WORKLOAD_KINDS.length).toBeGreaterThanOrEqual(3);
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(FLEET_WORKLOADS[kind].kind).toBe(kind);
      expect(FLEET_WORKLOADS[kind].label).toBeTruthy();
      const counted = await withSystemContext((tx) => FLEET_WORKLOADS[kind].countInFlight(NOW, tx));
      expect(counted).toBe(0);
    }
    expect(Object.keys((await census()).byWorkload).sort()).toEqual(
      [...FLEET_WORKLOAD_KINDS].sort(),
    );
  });

  // CI counts its OWN table and writes no slot — the union is what makes both
  // representations legal at once, and this is the assertion that says so.
  it('counts CI from the intent table and every other workload from the slot table', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await reserve('code_graph_index', fx);

    const seen = await census();
    expect(seen.byWorkload['ci_runner']).toBe(1);
    expect(seen.byWorkload['code_graph_index']).toBe(1);
    expect(seen.total).toBe(2);
    // The CI runner left NO slot row behind: a dual write on the hottest path in
    // the fleet is exactly what the union exists to avoid.
    expect(await db.fleetInFlightSlot.count({ where: { workload: 'ci_runner' } })).toBe(0);
    expect(SLOT_BACKED_WORKLOADS).not.toContain('ci_runner');
  });

  it('names each workload in the operator breakdown', async () => {
    const described = describeFleetCensus(await census());
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(described).toContain(FLEET_WORKLOADS[kind].label);
    }
  });
});

// ── The case per-workload caps structurally cannot catch ────────────────────

describe('ONE ceiling over ALL workloads', () => {
  // ⚠️ THE POINT OF THE WHOLE CARD. Every per-workload cap is satisfied — CI has
  // zero runners in flight and its project cap is 50 — and the fleet is still
  // full, because indexing and agents are spending on the same invoice. A
  // runner-only ceiling admits this job; the cross-workload one does not.
  it('refuses a CI job when INDEX and AGENT containers have filled the fleet', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '4');
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);
    await reserve('code_graph_index', fx);
    await reserve('hosted_agent', fx);
    await reserve('hosted_agent', fx);

    const queued = await seedIntent(fx);
    const verdict = await ciRunnerAdmissionService.admit(queued);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    // QUEUED, not failed — a ceiling must feel like waiting.
    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(after.status).toBe('pending');
    // And the refusal names WHICH workload filled it, or an operator cannot act
    // on it.
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('code-graph index 2'),
    });
    expect((verdict as { detail: string }).detail).toContain('hosted agents 2');
  });

  // The mirror case, and the one that proves the ceiling is not a CI feature
  // wearing a general name: CI fills the fleet, and an INDEX container is the
  // one refused.
  it('refuses an INDEX container when CI RUNNERS have filled the fleet', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '3');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'provisioning' });

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    expect((verdict as { detail: string }).detail).toContain('CI runners 3');
    expect(await db.fleetInFlightSlot.count()).toBe(0);
  });

  it('refuses an AGENT container when INDEX containers have filled the fleet', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);
    await reserve('code_graph_index', fx);

    const { verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
  });

  it('admits while the CROSS-WORKLOAD total is still under the ceiling', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '4');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await reserve('code_graph_index', fx);

    const { verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({ outcome: 'reserved', ceiling: 4 });
    expect(verdict).toMatchObject({ census: { total: 2 } });
    expect((await census()).total).toBe(3);
  });

  it('ZERO stops EVERY workload — the product-side kill switch', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();

    expect((await reserve('code_graph_index', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'fleet_ceiling',
    });
  });

  // Configurable per environment, never a hardcoded constant — asserted by
  // moving the ceiling and watching the SAME world flip verdict.
  it('reads the ceiling from the environment, not from a constant', async () => {
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);
    await reserve('hosted_agent', fx);

    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '2');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });

    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '3');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ outcome: 'reserved' });
  });
});

// ── Completion frees a slot, whoever's container it was ─────────────────────

describe('completion frees a slot for ANY workload', () => {
  it('an INDEX container ending lets a queued CI job through', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const { ref } = await reserve('code_graph_index', fx);
    const queued = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(queued)).toMatchObject({
      reason: 'fleet_ceiling',
    });

    expect(await fleetCeilingService.release('code_graph_index', ref)).toBe(true);

    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect((await ciRunnerAdmissionService.admit(after)).outcome).toBe('admitted');
  });

  // The mirror, and the property CI gets for free: settling an intent drops it
  // out of the in-flight window in the same write that ends the container, with
  // no slot bookkeeping at all.
  it('a CI runner settling lets a queued INDEX container through', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const busy = await seedIntent(fx, { status: 'running' });

    expect((await reserve('code_graph_index', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });

    await db.ciRunnerProvisioningIntent.update({
      where: { id: busy.id },
      data: { status: 'completed', settledAt: NOW, teardownReason: 'job_completed' },
    });

    expect((await reserve('code_graph_index', fx)).verdict).toMatchObject({
      outcome: 'reserved',
    });
  });

  it('releasing a slot that was never held is visible, not silent', async () => {
    expect(await fleetCeilingService.release('hosted_agent', 'never-taken')).toBe(false);
  });

  // Release is best-effort ON PURPOSE, and this is the branch that says so: a
  // failure here must not fail the teardown path it hangs off. The cost is a
  // slot that occupies capacity until `expires_at` ages it out — visible and
  // bounded, which a thrown teardown would not be.
  it('LOGS and keeps going when the release write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'release').mockRejectedValue(new Error('conn reset'));

    expect(await fleetCeilingService.release('code_graph_index', 'whatever')).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

// ── The real-concurrency contract, across workloads ─────────────────────────

describe('the ceiling holds under REAL concurrency, across workloads (notes.html #35)', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `fleetCeilingService.reserve` (and/or in `ciRunnerAdmissionService.admit`)
  // and it MUST go red. Every racer then reads the same "0 in flight" snapshot
  // and all of them take a slot — the TOCTOU a count-then-write with no shared
  // row allows, and the exact bug a serial test cannot see.
  //
  // It races DIFFERENT workloads on purpose. A same-workload race would pass
  // against an implementation that took a per-workload lock, which is precisely
  // the shape ("two independent ceilings") this card exists to replace.
  it('never exceeds the ceiling when CI, INDEX and AGENT dispatches race', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '4');
    const fx = await seedTenant();
    const intents = await Promise.all([1, 2, 3].map(() => seedIntent(fx)));

    const results = await Promise.all([
      ...intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
      ...[1, 2, 3].map(() => reserve('code_graph_index', fx).then((r) => r.verdict)),
      ...[1, 2, 3].map(() => reserve('hosted_agent', fx).then((r) => r.verdict)),
    ]);

    const won = results.filter((r) => r.outcome === 'admitted' || r.outcome === 'reserved');
    // WHICH four win is the scheduler's business; the invariant is that the
    // ceiling is a ceiling, and it is exact because none of the nine ever
    // completes.
    expect(won).toHaveLength(4);

    const seen = await census();
    expect(seen.total).toBe(4);
    // The total really is the sum over every workload, not one workload's count
    // wearing a general name.
    expect(Object.values(seen.byWorkload).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('two reservations of the SAME ref take exactly one slot', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '10');
    const fx = await seedTenant();

    const verdicts = await Promise.all([
      reserve('code_graph_index', fx, 'same-run').then((r) => r.verdict),
      reserve('code_graph_index', fx, 'same-run').then((r) => r.verdict),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'reserved')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_held')).toHaveLength(1);
    expect((await census()).total).toBe(1);
  });

  // A redelivery of a job that is ALREADY running must not be judged against the
  // ceiling: it occupies capacity it already holds, and refusing it would make
  // the caller tear down a live container to honour a refusal.
  it('an already-held ref is admitted even when the fleet is full', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const { ref } = await reserve('code_graph_index', fx, 'redelivered');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });

    const { verdict } = await reserve('code_graph_index', fx, ref);

    expect(verdict).toMatchObject({ outcome: 'already_held' });
    expect((await census()).total).toBe(1);
  });
});

// ── Fail CLOSED ─────────────────────────────────────────────────────────────

describe('the ceiling fails CLOSED', () => {
  // The opposite posture to the CI gate's credit read, deliberately: an
  // unestablished count is treated as a FULL fleet, because the failure on the
  // other side is unbounded spend on an account with no provider-side cap.
  it('DECLINES AND LOGS a reservation when a workload counter throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'countInFlightFleetWide').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
    // The transaction rolled back, so no slot was taken either.
    expect(await db.fleetInFlightSlot.count()).toBe(0);
  });

  // And the same posture reached through the CI gate — a NON-CI counter failing
  // must stop a CI boot, which is only true because the ceiling is one number.
  it('DECLINES a CI admission when the SLOT counter throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkload').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
    expect(error).toHaveBeenCalled();
  });

  it('DECLINES AND LOGS when the shared admission lock cannot be taken', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(false);
    const fx = await seedTenant();

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
  });
});

// ── No bypass ───────────────────────────────────────────────────────────────

describe('nothing bypasses the ceiling', () => {
  // MOTIR-1981 decision 7 puts META's index containers on this same fleet, so
  // the exemption that lifts meta's per-project CI cap must not reach here: a
  // meta-org runaway costs Motir exactly as much per container-second as anyone
  // else's.
  it('the META org is NOT exempt — its INDEX containers are refused too', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '2');
    const meta = await seedTenant({ isMeta: true });
    await reserve('code_graph_index', meta);
    await reserve('hosted_agent', meta);

    expect((await reserve('code_graph_index', meta)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });
  });

  it('a META CI job is refused when NON-CI containers filled the fleet', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '2');
    const meta = await seedTenant({ isMeta: true });
    await reserve('code_graph_index', meta);
    await reserve('hosted_agent', meta);

    expect(await ciRunnerAdmissionService.admit(await seedIntent(meta))).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
    });
  });

  // Self-hosting lifts the per-tenant PLAN allowance — a GPL build has no plan —
  // but the ceiling is not an allowance. It bounds whoever pays the container
  // bill, and a self-hoster's runaway fleet is as real as Motir's.
  it('MOTIR_CLOUD=false does not lift it either', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await reserve('hosted_agent', fx);

    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'fleet_ceiling',
    });
  });
});

// ── The expiry safety net ───────────────────────────────────────────────────

describe('the expiry safety net', () => {
  // A release that never runs — a crashed dispatcher — must cost capacity for at
  // most the container's own budget, not forever. This is the ONLY thing
  // standing between a leaked row and a permanently smaller fleet.
  it('stops counting a slot whose safety net has passed', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      reason: 'fleet_ceiling',
    });

    const later = new Date(NOW.getTime() + (TTL_SECONDS + 60) * 1_000);
    const verdict = await fleetCeilingService.reserve(
      { workload: 'hosted_agent', ref: 'after-expiry', ttlSeconds: TTL_SECONDS },
      later,
    );

    expect(verdict).toMatchObject({ outcome: 'reserved' });
  });

  // ...and it does NOT free a container that is still inside its budget, which is
  // the direction that would break the ceiling rather than merely age it.
  it('keeps counting a slot that is still inside its budget', async () => {
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);

    const almost = new Date(NOW.getTime() + (TTL_SECONDS - 60) * 1_000);
    const seen = await withSystemContext((tx) => fleetCeilingService.census(almost, tx));
    expect(seen.byWorkload['code_graph_index']).toBe(1);
  });

  it('sweeps expired rows without touching live ones', async () => {
    const fx = await seedTenant();
    const { ref: stale } = await reserve('code_graph_index', fx);
    const later = new Date(NOW.getTime() + (TTL_SECONDS + 60) * 1_000);
    await fleetCeilingService.reserve(
      { workload: 'hosted_agent', ref: 'live', ttlSeconds: TTL_SECONDS },
      later,
    );

    expect(await fleetCeilingService.sweepExpired(later)).toBe(1);
    expect(
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.findByRef('code_graph_index', stale, tx),
      ),
    ).toBeNull();
    expect(
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.findByRef('hosted_agent', 'live', tx),
      ),
    ).not.toBeNull();
  });
});

// ── MOTIR-1922's own guarantees, unchanged ──────────────────────────────────

describe('the per-workload caps still behave exactly as before', () => {
  // The scope boundary, asserted rather than asserted-in-prose: this ceiling
  // sits ABOVE the per-project cap and replaces none of its semantics.
  it('the per-project CI cap still refuses first, on its own reason', async () => {
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '1');
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '50');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });

    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      outcome: 'deferred',
      reason: 'project_cap',
    });
  });

  it('a sibling workload does NOT consume a project’s CI cap', async () => {
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '1');
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '50');
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);
    await reserve('hosted_agent', fx);

    // Fairness is per workload; the invoice is not. Index containers must not
    // eat the tenant's CI concurrency allowance.
    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
  });
});

// ── The reserve path's remaining edges ──────────────────────────────────────

describe('the slot reservation’s defaults and its own race', () => {
  it('falls back to the CONFIGURED TTL when the caller names none', async () => {
    // A workload that does not know its own hard-kill budget still gets the
    // fleet-wide safety net rather than an undefined expiry.
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '120');
    const before = Date.now();

    const verdict = await fleetCeilingService.reserve({
      workload: 'code_graph_index',
      ref: 'ttl-default-1',
    });

    expect(verdict.outcome).toBe('reserved');
    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef('code_graph_index', 'ttl-default-1', tx),
    );
    expect(slot?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 5_000);
    expect(slot?.expiresAt.getTime()).toBeLessThanOrEqual(before + 120_000 + 5_000);
  });

  it('a LOST INSERT RACE reports `already_held`, never a second slot', async () => {
    // The window the `ON CONFLICT DO NOTHING` closes: another transaction
    // committed the same (workload, ref) between this one's read and its write.
    // Simulated by blinding the pre-read, which is exactly what that racer's
    // timing does.
    await fleetCeilingService.reserve({ workload: 'hosted_agent', ref: 'raced-ref' });
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValue(null);

    const verdict = await fleetCeilingService.reserve({
      workload: 'hosted_agent',
      ref: 'raced-ref',
    });

    expect(verdict).toEqual({ outcome: 'already_held' });
    const held = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.countLiveForWorkload('hosted_agent', new Date(), tx),
    );
    expect(held).toBe(1);
  });

  it('reports a NON-ERROR rejection as `unknown` rather than losing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'ensureScope').mockRejectedValue('a bare string');

    const verdict = await fleetCeilingService.reserve({
      workload: 'code_graph_index',
      ref: 'non-error-1',
    });

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(verdict).toMatchObject({ detail: expect.stringContaining('unknown') });
    expect(error).toHaveBeenCalled();
  });
});
