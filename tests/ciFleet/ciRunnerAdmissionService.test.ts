import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE PROVISIONING GATE against real Postgres (Story MOTIR-1916 · MOTIR-1922).
//
// Everything load-bearing here is REAL: Postgres, the admission lock rows and
// their `FOR UPDATE`, the intent table's RLS contexts, the claim's
// compare-and-set, the org tier resolution, and the whole entitlement service
// down to its period rollup. The ONE thing stubbed is the motir-ai HTTP boundary
// (global `fetch`, the convention the metering suites established), because a
// credit balance is by definition on the other side of it.
//
// ⚠️ WHY THE POOL TESTS CANNOT BE SERIAL. The pool is a read-derived write —
// *count what is in flight → decide → claim a slot* — and a serial test passes
// against an implementation with NO LOCK AT ALL. That is `notes.html` #35's
// whole point, so the file carries a genuine `Promise.all` race and the lock is
// mutation-checked in a comment there: delete `lockScope` and it must go red.
//
// ⚠️ THE CLOCK IS PINNED, for the reason the sibling allowance suite documents
// at length: `getEntitlementState` resolves its own period from `new Date()`,
// so a fixture that meters into a FIXED month only exercises the real branch
// while the wall clock happens to sit inside it. Pinning is what keeps the
// credit-guard tests from silently going vacuous on the 1st of a month.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
/** A fixed instant INSIDE `JULY_2026` — the period every fixture meters into. */
const NOW_WITHIN_JULY_2026 = new Date('2026-07-15T12:00:00.000Z');
/** The §1 included pool for a solo org (the 1,000-minute floor). Consumption
 *  past this is what `drawing_on_credits` / `ci_credits_exhausted` mean. */
const POOL_FLOOR_MINUTES = 1_000;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-gate-${suffix}@example.com`,
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
    identifier: `A${randomInt(100, 1000)}`,
  });
  if (options.isMeta) {
    await adminDb.organization.update({
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

/** One intent, in whatever lifecycle state the case needs. `pending` is what
 *  MOTIR-1920's handler writes; `running` is what "already in flight" means. */
async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; projectId?: string | null } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW_WITHIN_JULY_2026,
      status: overrides.status ?? 'pending',
    },
  });
}

/** Put `minutes` of metered consumption into the org's period rollup — the
 *  meter's output, without driving a whole webhook delivery. */
async function meter(fx: Fixture, minutes: number): Promise<void> {
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        periodStart: JULY_2026,
        billableMinutes: Math.ceil(minutes),
        rawWallClockSeconds: minutes * 60,
        linearEquivalentMinutes: minutes,
      },
      tx,
    ),
  );
}

/** motir-ai's balance read — the only call this path makes across the boundary. */
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

async function statusOf(intentId: string): Promise<string> {
  const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
    where: { id: intentId },
  });
  return row.status;
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  vi.setSystemTime(NOW_WITHIN_JULY_2026);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // The kill switch disengaged; the pool is the default unless a case sets it.
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '');
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
  await adminDb.$disconnect();
});

// ── Guard 1 · the organisation's pool ───────────────────────────────────────

describe("guard 1 — the ORGANISATION'S pool (fleet-per-org-pool.md §2)", () => {
  it('admits and CLAIMS when the org is below its pool', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'admitted', orgInFlight: 0, orgPool: 500 });
    // The claim is part of the decision, not a later step — the slot is taken
    // the moment the gate says yes, which is what makes the count exact.
    expect(await statusOf(intent.id)).toBe('provisioning');
  });

  it('leaves the intent QUEUED, with the §4 words, when the org holds its pool', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'provisioning' });
    const queued = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(queued);

    expect(verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'org_pool',
      detail: expect.stringContaining(
        'Your organization is running 2 of its 2 CI containers. This job starts when one finishes.',
      ),
    });
    // QUEUED, not failed. A full pool must feel like waiting, never like an
    // error — and pending is what makes the next sweep retry it.
    expect(await statusOf(queued.id)).toBe('pending');
  });

  it('counts EVERY project of the org — the pool is the org’s, not a project’s', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    // Another project of the SAME org, and an intent naming no project at all.
    await seedIntent(fx, { status: 'running', projectId: null });
    const queued = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(queued)).toMatchObject({ reason: 'org_pool' });
  });

  it('another ORG’s full pool never holds this org’s job', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const other = await seedTenant();
    await seedIntent(other, { status: 'running' });
    const mine = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(mine)).outcome).toBe('admitted');
  });

  it('an ENTERPRISE org’s own number replaces the default', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 3 },
    });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'running' });
    const third = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(third)).toMatchObject({
      outcome: 'admitted',
      orgPool: 3,
    });
  });

  it('a COMPLETED runner frees the slot and the queued intent proceeds', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const inFlight = await seedIntent(fx, { status: 'running' });
    const queued = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(queued)).outcome).toBe('deferred');

    // Exactly what MOTIR-1921's teardown writes when a container ends.
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: inFlight.id },
      data: { status: 'completed', settledAt: new Date(), teardownReason: 'job_completed' },
    });

    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect((await ciRunnerAdmissionService.admit(after)).outcome).toBe('admitted');
  });

  it('a busy fleet is NO LONGER a reason to wait — there is no fleet-wide number', async () => {
    // What the retired ceiling used to decide. A positive MOTIR_FLEET_MAX_IN_FLIGHT
    // is now inert (§6): only 0 means anything.
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const a = await seedTenant();
    const b = await seedTenant();
    await seedIntent(a, { status: 'running' });
    await seedIntent(a, { status: 'running' });
    const queued = await seedIntent(b);

    expect((await ciRunnerAdmissionService.admit(queued)).outcome).toBe('admitted');
  });
});

// ── The kill switch ─────────────────────────────────────────────────────────

describe('the KILL SWITCH (§6)', () => {
  it('ZERO stops every boot, for every org', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
    });
    expect(await statusOf(intent.id)).toBe('pending');
  });

  it('the META org is not exempt from it', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant({ isMeta: true });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      reason: 'fleet_ceiling',
    });
  });
});

// ── The real-concurrency contract ───────────────────────────────────────────

describe('the pool holds under REAL concurrency (notes.html #35)', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `ciRunnerAdmissionService.admit` and it MUST go red. Every racer then reads
  // the same "0 in flight" snapshot and all six claim — the warm-pool TOCTOU a
  // count-then-claim with no shared lock allows, and the exact bug a serial test
  // cannot see.
  it('never exceeds the ORG pool when N intents of one org race', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '3');
    const fx = await seedTenant();
    const intents = await Promise.all([1, 2, 3, 4, 5, 6].map(() => seedIntent(fx)));

    const verdicts = await Promise.all(
      intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
    );

    const admitted = verdicts.filter((v) => v.outcome === 'admitted');
    // Every legitimate race outcome is accepted — WHICH three win is the
    // scheduler's business. What is asserted is the invariant: the pool is a
    // ceiling, and it is exact because none of the six ever completes.
    expect(admitted).toHaveLength(3);
    expect(verdicts.filter((v) => v.outcome === 'deferred')).toHaveLength(3);

    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightForOrganization(fx.organizationId, tx),
    );
    expect(inFlight).toBe(3);
  });

  it('two orgs racing each hold exactly their OWN pool', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '2');
    const a = await seedTenant();
    const b = await seedTenant();
    const intents = await Promise.all([a, a, a, a, b, b, b, b].map((fx) => seedIntent(fx)));

    await Promise.all(intents.map((intent) => ciRunnerAdmissionService.admit(intent)));

    for (const fx of [a, b]) {
      const inFlight = await withSystemContext((tx) =>
        ciRunnerProvisioningIntentRepository.countInFlightForOrganization(fx.organizationId, tx),
      );
      expect(inFlight).toBe(2);
    }
  });

  it('two admissions of the SAME intent produce exactly one claim', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const verdicts = await Promise.all([
      ciRunnerAdmissionService.admit(intent),
      ciRunnerAdmissionService.admit(intent),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_claimed')).toHaveLength(1);
  });
});

// ── Guard 3 · the credit refusal ────────────────────────────────────────────

describe('guard 3 — the ci_credits_exhausted refusal', () => {
  it('DECLINES at ci_credits_exhausted and puts the slot back', async () => {
    const fx = await seedTenant();
    await meter(fx, POOL_FLOOR_MINUTES + 500);
    stubMotirAi(0); // past the pool AND no credits = exhausted
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'ci_credits_exhausted' });
    // The claim is RELEASED, not left occupying capacity — otherwise one
    // exhausted org's queue could squeeze paying tenants out of the fleet.
    expect(await statusOf(intent.id)).toBe('pending');
    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    );
    expect(inFlight).toBe(0);
  });

  it('BOOTS at drawing_on_credits — crossing the pool is not a refusal', async () => {
    const fx = await seedTenant();
    await meter(fx, POOL_FLOOR_MINUTES + 500);
    stubMotirAi(500);
    const intent = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(intent)).outcome).toBe('admitted');
  });

  it('BOOTS at within_allowance', async () => {
    const fx = await seedTenant();
    await meter(fx, 100);
    const intent = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(intent)).outcome).toBe('admitted');
  });

  it('BOOTS at bypassed — off-cloud there is no meter and no refusal', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(intent)).outcome).toBe('admitted');
  });

  // FAIL-OPEN, asserted by making the read throw. Motir's own outage must never
  // read to a user as "you are out of credits".
  it('BOOTS AND LOGS when the entitlement read throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciAllowanceService, 'getEntitlementState').mockRejectedValue(
      new Error('motir-ai unreachable'),
    );
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect((await ciRunnerAdmissionService.admit(intent)).outcome).toBe('admitted');
    expect(await statusOf(intent.id)).toBe('provisioning');
    expect(error).toHaveBeenCalled();
  });
});

// ── The asymmetry: the pool fails CLOSED ────────────────────────────────────

describe('the pool fails CLOSED', () => {
  // The opposite posture to guard 3, deliberately: an unestablished count is
  // treated as a FULL pool, because the failure on the other side is unbounded
  // spend on an account with no provider-side cap.
  it('DECLINES AND LOGS when the org count throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countInFlightForOrganization',
    ).mockRejectedValue(new Error('connection reset'));
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    // The transaction rolled back, so no slot was taken either.
    expect(await statusOf(intent.id)).toBe('pending');
    expect(error).toHaveBeenCalled();
  });

  it('DECLINES AND LOGS when the org’s pool cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(organizationRepository, 'findFleetPoolCapInTx').mockRejectedValue(
      new Error('the org read failed'),
    );
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    // The real catch, not a stubbed return: an org whose pool cannot be
    // established must not be handed the default by accident.
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'gate_unavailable',
    });
    expect(await statusOf(intent.id)).toBe('pending');
    expect(error).toHaveBeenCalled();
  });
});

// ── What is NEVER bypassed ──────────────────────────────────────────────────

describe('bypasses — and what is NEVER bypassed', () => {
  // ⚠️ moooon B.V. pays its own AI bill, but a meta-org runaway costs Motir
  // exactly as much per container-second as any other org's. §1: meta keeps the
  // same pool.
  it('the META org is NOT exempt from its pool', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant({ isMeta: true });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'running' });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'org_pool',
    });
  });

  it('MOTIR_CLOUD=false does NOT lift the pool — it bounds whoever pays', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'org_pool',
    });
  });

  it('an intent naming NO project is still admitted against its org’s pool', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { projectId: null });

    expect((await ciRunnerAdmissionService.admit(intent)).outcome).toBe('admitted');
  });
});

// ── The gate's own failure modes ────────────────────────────────────────────

describe('the gate refuses when its SERIALIZATION cannot be established', () => {
  /**
   * `lockScope` answering false means the scope's anchor row was not there to
   * lock — a programming error rather than a runtime condition, and the ONE
   * failure the gate must not read as "the pool is empty".
   */
  it('DECLINES AND LOGS when the FLEET scope cannot be locked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(false);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(verdict).toMatchObject({ detail: expect.stringContaining('fleet admission lock') });
    // FAIL CLOSED: the transaction rolled back, so nothing was claimed.
    expect(await statusOf(intent.id)).toBe('pending');
    expect(error).toHaveBeenCalled();
  });

  it('reports a NON-ERROR rejection as `unknown` rather than losing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    // Not everything thrown is an Error — a driver can reject with a plain
    // object, and the gate's detail must still be readable.
    vi.spyOn(ciFleetAdmissionLockRepository, 'ensureScope').mockRejectedValue({ pg: '40P01' });

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(verdict).toMatchObject({ detail: expect.stringContaining('unknown') });
    expect(error).toHaveBeenCalled();
  });
});

describe('releaseClaim degrades rather than throwing', () => {
  it('releaseClaim LOGS and returns rather than throwing at its caller', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'releaseClaim').mockRejectedValue(
      new Error('the release write failed'),
    );

    // The worst case is an intent that sits in `provisioning` until the
    // stale-claim sweep writes it off — visible and bounded. A throw here would
    // be neither, and it would propagate into a teardown path.
    await expect(ciRunnerAdmissionService.releaseClaim('some-intent')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
