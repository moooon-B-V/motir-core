import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  codeGraphIndexAdmissionService,
  indexSlotRef,
  type IndexAdmissionVerdict,
} from '@/lib/services/codeGraphIndexAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  DEFAULT_INDEX_IN_FLIGHT_CAP,
  indexInFlightCap,
  workspaceIndexInFlightCap,
} from '@/lib/ciFleet/limits';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { truncateAuthTables } from '../helpers/db';

// THE INDEX ADMISSION CAP against real Postgres (Story MOTIR-1981 · MOTIR-1990) —
// `docs/decisions/code-graph-index-fleet.md` §7 · §7.2.
//
// ⚠️ WHAT THIS SUITE HAS TO PROVE THAT THE SIBLINGS CANNOT.
// `fleetCeiling.test.ts` proves ONE ceiling over every workload — the invoice.
// `codeGraphIndexDispatch.test.ts` proves the dispatch service's spec, taxonomy
// and supervision, with the gate stubbed and no database at all. This file is the
// only place the CAP ITSELF is decided against real transactions, so every
// case here either races them or moves a configured number and watches the same
// world flip verdict.
//
// Everything load-bearing is REAL: Postgres, the shared `fleet` admission lock
// and its `FOR UPDATE`, the slot table's `ON CONFLICT`, and both counted tables.
// The ONE thing stubbed is the motir-ai HTTP boundary, and only in the cases that
// reach through MOTIR-1922's CI gate (its third guard reads a credit balance).
//
// ⚠️ THE CLOCK IS PINNED, because slot expiry is a real comparison against a Date
// the service binds; an unpinned clock would race the wall clock instead of
// asserting a branch.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-08-03T12:00:00.000Z');
/** The shipped container hard kill — the slot TTL is derived from it. */
const CONTAINER_TIMEOUT_MS = 1_800_000;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

let seq = 0;

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  seq += 1;
  const user = await usersService.createUser({
    email: `index-admission-${seq}-${Math.floor(Math.random() * 1_000_000)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${seq}`,
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

/** Ask for admission for one (repo × project), through the real gate. */
function admit(fx: Fixture, repoRef = `moooon/repo-${(seq += 1)}`): Promise<IndexAdmissionVerdict> {
  return codeGraphIndexAdmissionService.admit(
    {
      projectId: fx.projectId,
      repoRef,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      containerTimeoutMs: CONTAINER_TIMEOUT_MS,
    },
    NOW,
  );
}

/** How many index slots are live right now, fleet-wide. */
function indexInFlight(now = NOW): Promise<number> {
  return withSystemContext((tx) =>
    fleetInFlightSlotRepository.countLiveForWorkload('code_graph_index', now, tx),
  );
}

/** How many index slots one workspace is holding right now. */
function workspaceInFlight(workspaceId: string, now = NOW): Promise<number> {
  return withSystemContext((tx) =>
    fleetInFlightSlotRepository.countLiveForWorkloadInWorkspace(
      'code_graph_index',
      workspaceId,
      now,
      tx,
    ),
  );
}

let jobSeq = 0;

/** A queued CI job — the OTHER workload on the same invoice. */
async function seedIntent(fx: Fixture, overrides: { status?: string } = {}) {
  jobSeq += 1;
  return db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9001',
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
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

function stubMotirAi(balance = 1_000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${parsed.href}`);
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  await db.fleetInFlightSlot.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // Room above the index cap by default, so a fleet_ceiling refusal never masks
  // the branch a case is actually about. The ceiling gets its own cases below.
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '100');
  vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '50');
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

// ── The numbers are CONFIG, and the per-tenant one is DERIVED ────────────────

describe('the caps are configuration, and the per-workspace one is a RELATION', () => {
  it('reads the global cap from the environment, not from a constant', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    // Two DIFFERENT workspaces, so the per-workspace cap cannot be what refuses.
    const other = await seedTenant();
    expect((await admit(fx)).outcome).toBe('admitted');
    expect((await admit(other)).outcome).toBe('admitted');

    expect(await admit(await seedTenant())).toMatchObject({
      outcome: 'deferred',
      reason: 'index_cap',
      detail: expect.stringContaining('2/2'),
    });

    // Move the number; the SAME world flips verdict, with no code change. That is
    // the criterion — the cap is sized against the fleet spend cap and must
    // follow when that moves (§7.2).
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    expect((await admit(await seedTenant())).outcome).toBe('admitted');
  });

  // ⚠️ DERIVED, NEVER SEPARATELY CONFIGURED. Two independent numbers drift, and
  // the invariant that matters ("no tenant holds more than half") is only
  // expressible as a relation between them.
  it('derives the per-workspace cap as ceil(global / 2) at every value', () => {
    for (const global of [0, 1, 2, 3, 6, 7, 24]) {
      expect(workspaceIndexInFlightCap(global)).toBe(Math.ceil(global / 2));
    }
    // ceil, not floor: at a global of 1 the floor would be 0, which is not "fair"
    // but "nothing indexes, ever".
    expect(workspaceIndexInFlightCap(1)).toBe(1);
    // And there is deliberately no env var for it — moving the global moves both.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT_PER_WORKSPACE', '99');
    expect(workspaceIndexInFlightCap(indexInFlightCap())).toBe(
      Math.ceil(DEFAULT_INDEX_IN_FLIGHT_CAP / 2),
    );
  });

  it('falls back to the shipped default, and to it again on a malformed value', () => {
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', 'lots');
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    expect(warn).toHaveBeenCalled();
  });

  // Zero is the index-only kill switch: it stops indexing without touching CI,
  // which is what distinguishes it from the fleet ceiling's zero.
  it('ZERO stops indexing and nothing else', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '0');
    stubMotirAi();

    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'workspace_index_cap' });
    // CI is untouched — the two caps are different numbers about different things.
    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
  });
});

// ── The two caps, and which one refuses ─────────────────────────────────────

describe('the GLOBAL cap and the PER-WORKSPACE cap', () => {
  it('lets a workspace take up to half the lane and no more', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();

    for (let i = 0; i < 3; i += 1) expect((await admit(fx)).outcome).toBe('admitted');

    expect(await admit(fx)).toMatchObject({
      outcome: 'deferred',
      reason: 'workspace_index_cap',
      detail: expect.stringContaining('3/3'),
    });
    expect(await workspaceInFlight(fx.workspaceId)).toBe(3);
  });

  // ⚠️ THE FAIRNESS PROPERTY, STATED AS THE CARD STATES IT. One tenant's burst
  // must not delay another tenant's FIRST index — the measured failure of the
  // old global unkeyed `concurrency: 2`.
  it('leaves room for another tenant when one workspace bursts', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    const busy = await seedTenant();
    const quiet = await seedTenant();

    // The busy tenant asks for six containers and gets its half.
    const bursts = [];
    for (let i = 0; i < 6; i += 1) bursts.push(await admit(busy));
    expect(bursts.filter((v) => v.outcome === 'admitted')).toHaveLength(2);

    // The other tenant's FIRST index is admitted immediately — not queued behind
    // the whole burst.
    expect((await admit(quiet)).outcome).toBe('admitted');
  });

  it('reports the SPECIFIC reason — a workspace pacing itself is not a full fleet', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();
    for (let i = 0; i < 3; i += 1) await admit(fx);

    const verdict = await admit(fx);

    expect(verdict).toMatchObject({ reason: 'workspace_index_cap' });
    // Indexing as a whole is nowhere near its cap, which is exactly why the two
    // reasons must not be collapsed: an operator reads different actions off them.
    expect(await indexInFlight()).toBe(3);
    expect((verdict as { detail: string }).detail).toContain('global 6');
  });

  it('refuses on the GLOBAL cap when many tenants filled the lane', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '3');
    for (let i = 0; i < 3; i += 1)
      expect((await admit(await seedTenant())).outcome).toBe('admitted');

    expect(await admit(await seedTenant())).toMatchObject({
      outcome: 'deferred',
      reason: 'index_cap',
      detail: expect.stringContaining('3/3'),
    });
  });

  // The slot really is per (repo × project): the same workspace indexing a
  // second repo takes a second slot, and the same repo into a second project
  // takes another. That is §6's unit of work, and it is what the cap counts.
  it('counts one slot per (repo × project), not per repo and not per workspace', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '20');
    const fx = await seedTenant();
    const second = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: (
        await db.workspaceMembership.findFirstOrThrow({
          where: { workspaceId: fx.workspaceId },
        })
      ).userId,
      name: 'Second',
      identifier: `B${Math.floor(Math.random() * 900 + 100)}`,
    });

    await admit(fx, 'moooon/a');
    await admit(fx, 'moooon/b');
    await codeGraphIndexAdmissionService.admit(
      {
        projectId: second.id,
        repoRef: 'moooon/a',
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        containerTimeoutMs: CONTAINER_TIMEOUT_MS,
      },
      NOW,
    );

    expect(await workspaceInFlight(fx.workspaceId)).toBe(3);
  });
});

// ── The cross-workload ceiling still binds (MOTIR-1997) ─────────────────────

describe('the fleet CEILING binds indexing too — a cap that only counted index containers is not a bound', () => {
  // ⚠️ THE CASE A PER-WORKLOAD CAP STRUCTURALLY CANNOT CATCH. Indexing is nowhere
  // near its own cap; the fleet is full of CI runners on the same invoice, and
  // §7.2 records that nothing sits underneath that number.
  it('refuses an index container when CI RUNNERS filled the fleet', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '2');
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'provisioning' });

    const verdict = await admit(fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    expect((verdict as { detail: string }).detail).toContain('CI runners 2');
    expect(await indexInFlight()).toBe(0);
  });

  // And the mirror — an admitted index container is COUNTED by the ceiling, which
  // is the whole reason the dispatcher must take a slot at all (§7.2).
  it('makes an admitted index container visible to the CI gate', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    stubMotirAi();
    const fx = await seedTenant();

    expect((await admit(fx)).outcome).toBe('admitted');

    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: expect.stringContaining('code-graph index 1'),
    });
  });
});

// ── Over the cap means WAIT, never drop ─────────────────────────────────────

describe('a refused index WAITS and later runs — nothing is dropped', () => {
  // ⚠️ THE ACCEPTANCE CRITERION, at the gate's own altitude: a burst over the cap
  // is REFUSED, not dropped, and every one of its repos gets through as capacity
  // frees. Dropping would leave a repo permanently unindexed behind a
  // `succeeded`-looking ledger — the failure the whole story exists to remove.
  it('admits every repo of an over-cap burst as the earlier ones settle', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    const repos = ['moooon/a', 'moooon/b', 'moooon/c', 'moooon/d', 'moooon/e'];
    const admitted = new Set<string>();
    const pending = [...repos];

    // The dispatcher's loop, in miniature: ask, and if refused, come back after
    // the containers ahead have ended.
    for (let round = 0; round < repos.length && pending.length > 0; round += 1) {
      const stillPending: string[] = [];
      for (const repo of pending) {
        const verdict = await admit(fx, repo);
        if (verdict.outcome === 'admitted') admitted.add(repo);
        else stillPending.push(repo);
      }
      pending.length = 0;
      pending.push(...stillPending);
      // The admitted containers finish and give their capacity back.
      for (const repo of admitted) {
        await codeGraphIndexAdmissionService.release(indexSlotRef(fx.projectId, repo));
      }
    }

    expect([...admitted].sort()).toEqual([...repos].sort());
    expect(pending).toEqual([]);
  });

  it('a released slot immediately lets the next queued index in', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    await admit(fx, 'moooon/first');
    const other = await seedTenant();
    await admit(other, 'moooon/second');

    expect(await admit(await seedTenant(), 'moooon/third')).toMatchObject({
      reason: 'index_cap',
    });

    expect(
      await codeGraphIndexAdmissionService.release(indexSlotRef(fx.projectId, 'moooon/first')),
    ).toBe(true);

    expect((await admit(await seedTenant(), 'moooon/third')).outcome).toBe('admitted');
  });

  // TWO WORKSPACES BURSTING SIMULTANEOUSLY BOTH MAKE PROGRESS — neither is
  // starved behind the other's whole queue. This is the property the old global
  // unkeyed `concurrency: 2` did not have.
  it('lets two simultaneously-bursting workspaces BOTH make progress', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    const left = await seedTenant();
    const right = await seedTenant();

    // Interleaved, as two real dispatchers would arrive.
    const verdicts = await Promise.all([
      ...['a', 'b', 'c', 'd'].map((r) => admit(left, `left/${r}`)),
      ...['a', 'b', 'c', 'd'].map((r) => admit(right, `right/${r}`)),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(4);
    // Exactly half each: the derived cap is what makes "both progress" a
    // guarantee rather than a hope about scheduling order.
    expect(await workspaceInFlight(left.workspaceId)).toBe(2);
    expect(await workspaceInFlight(right.workspaceId)).toBe(2);
  });
});

// ── The real-concurrency contract (notes.html #35) ──────────────────────────

describe('the caps hold under REAL concurrency', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `codeGraphIndexAdmissionService.admit` and it MUST go red. Every racer then
  // reads the same "0 in flight" snapshot and all of them take a slot — the
  // TOCTOU that a count-then-write with no shared row allows, and the exact bug a
  // serial loop cannot see.
  it('never exceeds the GLOBAL cap when many dispatches race', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    // Eight different workspaces, so ONLY the global cap can be what binds.
    const tenants = await Promise.all(Array.from({ length: 8 }, () => seedTenant()));

    const verdicts = await Promise.all(tenants.map((fx, i) => admit(fx, `moooon/r${i}`)));

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(4);
    expect(await indexInFlight()).toBe(4);
  });

  // The per-tenant half of the same guarantee: one workspace racing its own
  // repo-connect burst cannot walk past `ceil(global / 2)`.
  it('never exceeds the PER-WORKSPACE cap when one tenant races itself', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();

    const verdicts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => admit(fx, `moooon/burst-${i}`)),
    );

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(3);
    expect(await workspaceInFlight(fx.workspaceId)).toBe(3);
    // …and the global lane still has room, which is the point of a per-tenant cap.
    expect(await indexInFlight()).toBe(3);
  });

  // ⚠️ RACED AGAINST THE OTHER WORKLOADS, not just against itself. A same-workload
  // race would pass against an implementation that took a per-workload lock —
  // which is exactly the shape MOTIR-1997 exists to replace.
  it('never exceeds the fleet CEILING when index and CI dispatches race', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '3');
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    stubMotirAi();
    const fx = await seedTenant();
    const intents = await Promise.all([1, 2, 3].map(() => seedIntent(fx)));

    const results = await Promise.all([
      ...intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
      ...[1, 2, 3].map((i) => admit(fx, `moooon/race-${i}`)),
    ]);

    const won = results.filter((r) => r.outcome === 'admitted');
    expect(won).toHaveLength(3);
    const census = await withSystemContext((tx) => fleetCeilingService.census(NOW, tx));
    expect(census.total).toBe(3);
  });

  // A redelivered job / replayed step must occupy ONE slot, not two — the
  // `(workload, ref)` uniqueness is what makes the take idempotent.
  it('takes exactly one slot when the same (repo × project) is admitted twice', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    const fx = await seedTenant();

    const verdicts = await Promise.all([
      admit(fx, 'moooon/redelivered'),
      admit(fx, 'moooon/redelivered'),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_held')).toHaveLength(1);
    expect(await indexInFlight()).toBe(1);
    // And both got a usable ticket naming the SAME slot — the redelivery boots
    // on the capacity it already holds.
    for (const verdict of verdicts) {
      if (verdict.outcome === 'deferred') throw new Error('expected a ticket');
      expect(verdict.admission.slotRef).toBe(indexSlotRef(fx.projectId, 'moooon/redelivered'));
    }
  });

  // ⚠️ AN ALREADY-HELD REF IS NOT JUDGED AGAINST THE CAPS. Refusing a redelivery
  // capacity it is already occupying would make the caller tear down a live
  // container to honour a refusal.
  it('admits an already-held ref even when indexing is at its cap', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await admit(fx, 'moooon/held');
    expect(await admit(await seedTenant(), 'moooon/other')).toMatchObject({ reason: 'index_cap' });

    expect(await admit(fx, 'moooon/held')).toMatchObject({ outcome: 'already_held' });
    expect(await indexInFlight()).toBe(1);
  });
});

// ── Fail CLOSED ─────────────────────────────────────────────────────────────

describe('the index gate fails CLOSED', () => {
  it('DECLINES AND LOGS when a count cannot be established', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkload').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();

    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
    // The transaction rolled back, so no slot was taken either.
    expect(await db.fleetInFlightSlot.count()).toBe(0);
  });

  it('DECLINES when the per-WORKSPACE count throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkloadInWorkspace').mockRejectedValue(
      new Error('connection reset'),
    );

    expect(await admit(await seedTenant())).toMatchObject({ reason: 'gate_unavailable' });
  });

  it('DECLINES AND LOGS when the shared admission lock cannot be taken', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(false);

    expect(await admit(await seedTenant())).toMatchObject({ reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
  });

  it('reports a NON-ERROR rejection as `unknown` rather than losing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'ensureScope').mockRejectedValue('a bare string');

    expect(await admit(await seedTenant())).toMatchObject({
      reason: 'gate_unavailable',
      detail: expect.stringContaining('unknown'),
    });
  });

  // The lost-insert race the `ON CONFLICT DO NOTHING` closes: another transaction
  // committed the same ref between this one's read and its write.
  it('a LOST INSERT RACE reports already_held, never a second slot', async () => {
    const fx = await seedTenant();
    await admit(fx, 'moooon/raced');
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValue(null);

    expect(await admit(fx, 'moooon/raced')).toMatchObject({ outcome: 'already_held' });
    expect(await indexInFlight()).toBe(1);
  });
});

// ── The slot's own bookkeeping ──────────────────────────────────────────────

describe('the slot a granted admission takes', () => {
  it('is attributed, and expires LATER than the container it stands for', async () => {
    const fx = await seedTenant();
    const verdict = await admit(fx, 'moooon/ttl');
    expect(verdict.outcome).toBe('admitted');

    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef(
        'code_graph_index',
        indexSlotRef(fx.projectId, 'moooon/ttl'),
        tx,
      ),
    );
    expect(slot).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
    });
    // ⚠️ THE ONE DIRECTION THAT WOULD BREAK THE CEILING. A TTL shorter than the
    // container's real life stops counting a container that is still spending.
    expect(slot!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime() + CONTAINER_TIMEOUT_MS);
  });

  it('stops counting once its safety net has passed', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await admit(fx, 'moooon/stale');
    expect(await admit(await seedTenant(), 'moooon/next')).toMatchObject({ reason: 'index_cap' });

    const later = new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS + 3_600_000);
    const verdict = await codeGraphIndexAdmissionService.admit(
      {
        projectId: fx.projectId,
        repoRef: 'moooon/next',
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        containerTimeoutMs: CONTAINER_TIMEOUT_MS,
      },
      later,
    );

    expect(verdict.outcome).toBe('admitted');
  });

  it('releasing a slot that was never held is visible, not silent', async () => {
    expect(await codeGraphIndexAdmissionService.release('never:taken')).toBe(false);
  });

  it('keys the slot by (projectId, repoRef) — deterministic, never run-scoped', () => {
    expect(indexSlotRef('proj-1', 'moooon/core')).toBe('proj-1:moooon/core');
    expect(indexSlotRef('proj-1', 'moooon/core')).toBe(indexSlotRef('proj-1', 'moooon/core'));
    expect(indexSlotRef('proj-2', 'moooon/core')).not.toBe(indexSlotRef('proj-1', 'moooon/core'));
  });
});

// ── No bypass ───────────────────────────────────────────────────────────────

describe('nothing bypasses the index caps', () => {
  // §8/§9.1: meta's OWN index containers run through this identical code, into
  // the same org. `isMeta` decides whether a cost is CHARGED, never whether work
  // runs somewhere else — and a meta-org runaway costs exactly as much.
  it('the META org is not exempt from either cap', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const meta = await seedTenant({ isMeta: true });

    expect((await admit(meta, 'moooon/a')).outcome).toBe('admitted');
    expect(await admit(meta, 'moooon/b')).toMatchObject({ reason: 'workspace_index_cap' });
  });

  it('MOTIR_CLOUD=false does not lift them either', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();

    expect((await admit(fx, 'moooon/a')).outcome).toBe('admitted');
    expect(await admit(await seedTenant(), 'moooon/b')).toMatchObject({ reason: 'index_cap' });
  });
});
