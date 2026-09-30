import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  ciRunnerAdmissionService,
  BALANCE_UNAVAILABLE_DETAIL,
  CREDITS_INSUFFICIENT_DETAIL,
} from '@/lib/services/ciRunnerAdmissionService';
import { ciLiveChargeService } from '@/lib/services/ciLiveChargeService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { periodStartFor } from '@/lib/ciMetering/period';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import {
  FLEET_CONTAINER_SIZE,
  fakeFleetInventory,
  fakeOrchestrator,
  type ContainerHandle,
} from '@motir/orchestrator';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// THE INTEGRATION GATE for Story MOTIR-6906 (MOTIR-6912) —
// `docs/decisions/fleet-per-org-pool.md`.
//
// Each sibling tested its own half with its neighbours faked. This file runs the
// ASSEMBLED path — the plan check, the org's pool, coverage, the live charge, the
// org stop and the attribution reconciler — against the real Postgres, with only
// the far side of three boundaries faked at their clients: motir-ai (plan,
// balance and the ci-overage ledger, through global `fetch`), GitHub (never
// reached: no org here has a Motir-hosted repository to cancel runs on), and the
// provider (the fake orchestrator and its fleet inventory).
//
// The ledger is a real ledger in miniature: a debit LOWERS the balance the next
// read returns, so a charge the next admission never sees cannot pass here.
//
// The CI boot → reconcile seam through the real mint and boot is in
// `tests/ciFleet/fleetStoryGate.test.ts` (it owns the GitHub fake that path
// needs); hosted runs, index containers and agent instances are matched by
// record in `tests/ciFleet/fleetAttribution.test.ts`.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
/** A fixed instant, so the period the fixtures meter into is the period read. */
const NOW = new Date('2026-07-15T12:00:00.000Z');
const PERIOD = periodStartFor(NOW);
/** The §1 included pool of a one-member org (the 1,000-minute floor). */
const POOL_MINUTES = 1_000;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-org-gate-${suffix}@example.com`,
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
    identifier: `G${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; startedAt?: Date | null; handle?: ContainerHandle } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  const handle = overrides.handle;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: `run-${jobSeq}`,
      runAttempt: 1,
      jobId: String(90_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
      startedAt: overrides.startedAt ?? null,
      containerProvider: handle?.provider ?? null,
      containerId: handle?.id ?? null,
      containerRegion: handle?.region ?? null,
      bootedAt: handle ? NOW : null,
    },
  });
}

/** A CI container actually running on the fake provider, with its intent. */
async function runningContainer(fx: Fixture, startedAt: Date) {
  const handle = await fakeOrchestrator.provision({
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: `${MOTIR_ORG}/acme-web`,
    workload: 'ci_runner',
    workflowJobId: 90_000 + jobSeq + 1,
    image: 'motir/runner@sha256:gate',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 3600,
    region: 'iad',
  });
  const intent = await seedIntent(fx, { status: 'running', startedAt, handle });
  return { handle, intent };
}

/** Spend the org's whole included pool this period — every further minute is credits. */
async function exhaustPool(fx: Fixture, minutes = POOL_MINUTES): Promise<void> {
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        periodStart: PERIOD,
        billableMinutes: minutes,
        rawWallClockSeconds: minutes * 60,
        linearEquivalentMinutes: minutes,
      },
      tx,
    ),
  );
}

// ── motir-ai, in miniature ───────────────────────────────────────────────────

/** Per-org credit balance; a debit lowers it. Absent means 1,000. */
let ledger: Map<string, number>;
/** Per-org subscription status; `'unknown'` answers 500. Absent means `active`. */
let plans: Map<string, string | null>;
/** Orgs whose balance read fails. */
let unreachable: Set<string>;
let debits: { org: string; credits: number }[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubMotirAi(): void {
  const seenRefs = new Set<string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(url));
      const org = u.searchParams.get('coreOrganizationId') ?? '';
      if (u.pathname === '/v1/usage') {
        if (unreachable.has(org)) throw new Error('ECONNREFUSED');
        return json(200, { balance: ledger.get(org) ?? 1_000 });
      }
      if (u.pathname === '/v1/stripe/subscription') {
        const status = plans.has(org) ? plans.get(org)! : 'active';
        if (status === 'unknown') return json(500, { code: 'internal_error' });
        return json(200, { status });
      }
      if (u.pathname === '/v1/credits/ci-overage') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const target = String(body['coreOrganizationId']);
        const credits = Number(body['credits']);
        const ref = String(body['externalRef']);
        const replay = seenRefs.has(ref);
        if (!replay) {
          seenRefs.add(ref);
          ledger.set(target, (ledger.get(target) ?? 1_000) - credits);
          debits.push({ org: target, credits });
        }
        const after = ledger.get(target)!;
        return json(200, {
          transactionId: `tx_${seenRefs.size}`,
          aiOrganizationId: 'ai_org',
          credits: -credits,
          balanceAfter: after,
          exhausted: after <= 0,
          idempotent: replay,
        });
      }
      throw new Error(`unexpected fetch to ${u.toString()}`);
    }),
  );
}

async function intentRow(id: string) {
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.setSystemTime(NOW);
  _resetAiPlanCache();
  fakeOrchestrator.reset();
  fakeFleetInventory.reset();
  ledger = new Map();
  plans = new Map();
  unreachable = new Set();
  debits = [];
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '');
  stubMotirAi();
  // Every refusal logs; the assertions are on verdicts and rows.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

// ── The admission-order seam: plan, then pool, then coverage ────────────────

describe('the admission ORDER — plan, then pool, then coverage (§4)', () => {
  /** An org that fails EVERY check at once: no plan, a full pool, no credits. */
  async function failingEverything(): Promise<Fixture> {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running', startedAt: NOW });
    await exhaustPool(fx);
    ledger.set(fx.organizationId, 0);
    return fx;
  }

  it('no paid plan is the answer while it holds, whatever the pool and balance', async () => {
    const fx = await failingEverything();
    plans.set(fx.organizationId, null);
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'ai_plan_required',
    });
  });

  it('an unreadable plan refuses as plan_unknown before the pool is read', async () => {
    const fx = await failingEverything();
    plans.set(fx.organizationId, 'unknown');
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'plan_unknown',
    });
  });

  it('with a plan, the full pool is the answer — not the empty balance', async () => {
    const fx = await failingEverything();
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'org_pool',
    });
  });

  it('with a plan and room in the pool, coverage is the answer', async () => {
    const fx = await failingEverything();
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '5');
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'ci_credits_exhausted',
    });
    ledger.set(fx.organizationId, 9); // not exhausted, short of (1 + 1) × 5
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toEqual({
      outcome: 'deferred',
      reason: 'credits_insufficient',
      detail: CREDITS_INSUFFICIENT_DETAIL,
    });
    ledger.set(fx.organizationId, 10);
    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
  });
});

// ── The live charge feeds the next admission ────────────────────────────────

describe('a tick’s REAL debit is the balance the next admission reads (§3)', () => {
  it('admits before the tick and refuses after it, on the minutes the tick charged', async () => {
    const fx = await seedTenant();
    await exhaustPool(fx);
    ledger.set(fx.organizationId, 16);
    // One container started three minutes ago.
    await runningContainer(fx, new Date(NOW.getTime() - 3 * 60_000 - 5_000));

    // Before: (1 + 1) × 5 = 10 ≤ 16 — admitted, and now two run.
    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');

    const tick = await ciLiveChargeService.tick(NOW);
    expect(tick).toMatchObject({
      outcome: 'ticked',
      organizations: [{ organizationId: fx.organizationId, accruedMinutes: 3, charge: 'charged' }],
      stopped: [],
    });
    expect(debits).toEqual([{ org: fx.organizationId, credits: 3 }]);
    expect(ledger.get(fx.organizationId)).toBe(13);

    // After: (2 + 1) × 5 = 15 > 13. Without the debit the balance would still be
    // 16 and this would have been admitted.
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'credits_insufficient',
    });
  });
});

// ── Stop at zero, through the REAL stop service ─────────────────────────────

describe('at zero, the REAL stop settles the org’s intents and destroys its containers', () => {
  it('stops the org the tick drove to zero, within that tick, and never the other', async () => {
    const broke = await seedTenant();
    const paying = await seedTenant();
    await exhaustPool(broke);
    await exhaustPool(paying);
    ledger.set(broke.organizationId, 2);
    ledger.set(paying.organizationId, 500);
    const startedAt = new Date(NOW.getTime() - 4 * 60_000);
    const brokeRun = await runningContainer(broke, startedAt);
    const payingRun = await runningContainer(paying, startedAt);

    const tick = await ciLiveChargeService.tick(NOW);

    expect(tick).toMatchObject({ stopped: [broke.organizationId] });
    expect(ledger.get(broke.organizationId)).toBe(-2);
    // The broke org's intent is settled as a zero-credit stop, its container gone…
    expect(await intentRow(brokeRun.intent.id)).toMatchObject({
      status: 'failed',
      teardownReason: 'credits_exhausted',
    });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([payingRun.handle.id]);
    // …and the paying org's run is untouched.
    expect(await intentRow(payingRun.intent.id)).toMatchObject({
      status: 'running',
      teardownReason: null,
    });
    // The stopped org no longer counts anything in its own pool.
    const census = await withSystemContext((tx) =>
      fleetCeilingService.orgCensus(broke.organizationId, NOW, tx),
    );
    expect(census.total).toBe(0);
  });

  it('an UNREADABLE balance stops nothing already running, and admits nothing new', async () => {
    const fx = await seedTenant();
    await exhaustPool(fx);
    const run = await runningContainer(fx, new Date(NOW.getTime() - 2 * 60_000));
    unreachable.add(fx.organizationId);

    expect(await ciLiveChargeService.tick(NOW)).toMatchObject({ stopped: [] });
    expect(await intentRow(run.intent.id)).toMatchObject({ status: 'running' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([run.handle.id]);

    const pending = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(pending)).toEqual({
      outcome: 'deferred',
      reason: 'balance_unavailable',
      detail: BALANCE_UNAVAILABLE_DETAIL,
    });
    expect((await intentRow(pending.id)).status).toBe('pending');
  });
});

// ── Attribution after the stop ──────────────────────────────────────────────

describe('the reconciler agrees with admission and with the stop', () => {
  const pastGrace = () => new Date(Date.now() + 11 * 60_000);

  it('spares what admission and a live record own, and kills only the machine nobody owns', async () => {
    const fx = await seedTenant();
    const run = await runningContainer(fx, NOW);
    fakeFleetInventory.addStray({ app: 'fake-fleet', machineId: 'm-leak', createdAt: NOW });

    const pass = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(pass).toMatchObject({
      outcome: 'reconciled',
      matched: 1,
      killed: [{ machineId: 'm-leak', reason: 'no_record' }],
    });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([run.handle.id]);
  });

  it('a failed provider listing destroys NOTHING', async () => {
    const fx = await seedTenant();
    const run = await runningContainer(fx, NOW);
    fakeFleetInventory.addStray({ app: 'fake-fleet', machineId: 'm-leak', createdAt: NOW });
    fakeFleetInventory.failNextAppList();

    expect(await fleetAttributionService.reconcile({ now: pastGrace })).toMatchObject({
      outcome: 'inventory_unavailable',
    });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-leak']);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([run.handle.id]);
  });
});

// ── Tenant isolation, under real concurrency ────────────────────────────────

describe('GUARD: one org’s burst, stop or zero never moves another org', () => {
  it('org A at zero and bursting, org B paying — in parallel transactions', async () => {
    vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '3');
    const a = await seedTenant();
    const b = await seedTenant();
    await exhaustPool(a);
    await exhaustPool(b);
    ledger.set(a.organizationId, 0);
    ledger.set(b.organizationId, 1_000);
    const aRun = await runningContainer(a, new Date(NOW.getTime() - 60_000));

    const aBurst = await Promise.all([1, 2, 3, 4].map(() => seedIntent(a)));
    const bBurst = await Promise.all([1, 2, 3, 4].map(() => seedIntent(b)));

    // A's stop, A's burst and B's burst, all at once.
    const [stop, aVerdicts, bVerdicts] = await Promise.all([
      ciLiveChargeService.tick(NOW),
      Promise.all(aBurst.map((intent) => ciRunnerAdmissionService.admit(intent))),
      Promise.all(bBurst.map((intent) => ciRunnerAdmissionService.admit(intent))),
    ]);

    expect(stop).toMatchObject({ stopped: [a.organizationId] });
    // A admits nothing: at zero it is exhausted, and its pool is its own.
    expect(aVerdicts.every((v) => v.outcome === 'deferred')).toBe(true);
    // B fills exactly its OWN pool of 3 — A's load and A's stop take nothing from it.
    expect(bVerdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(3);
    expect(bVerdicts.filter((v) => v.outcome === 'deferred')).toEqual([
      expect.objectContaining({ reason: 'org_pool' }),
    ]);

    // A's stop settled only A's intent; none of B's rows carry a stop.
    expect(await intentRow(aRun.intent.id)).toMatchObject({ teardownReason: 'credits_exhausted' });
    const bStopped = await adminDb.ciRunnerProvisioningIntent.count({
      where: { organizationId: b.organizationId, teardownReason: { not: null } },
    });
    expect(bStopped).toBe(0);
    const bCensus = await withSystemContext((tx) =>
      fleetCeilingService.orgCensus(b.organizationId, NOW, tx),
    );
    expect(bCensus.total).toBe(3);
  });
});
