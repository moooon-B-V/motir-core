import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { ciMinutesReconciliationService } from '@/lib/services/ciMinutesReconciliationService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// THE STORY GATE for Motir's ephemeral CI runner fleet (Story MOTIR-1916 ·
// MOTIR-1927) — the coverage the story's SUBTASKS structurally cannot give
// themselves.
//
// Every feature card here shipped with its own real-Postgres units (the
// code-and-tests-ship-together floor), and those are not re-covered: this file
// exists for the two things a per-card suite cannot reach.
//
//   §2 INTEGRATION SEAMS. Each card's units mock the boundary to the NEXT card,
//      which is exactly where a key, a family name or an id silently drifts.
//      Here one real fixture is driven THROUGH the real consumers against real
//      Postgres — webhook → intent → gate → boot → container-seconds → cost row;
//      establishment → runner group → JIT mint; a fleet job's metered row → the
//      RECONCILIATION's fleet side.
//   §3 CONTRACT GUARDS. Assertions a coverage percentage cannot make, because
//      they are about what NEVER happens: no intent for a job that is not ours,
//      never a second usage row, never a re-used runner, never the `Default`
//      group, never a boot before the gate, never one tenant's state deciding
//      another's.
//
// ⚠️ ONE GUARD IS DELIBERATELY NOT HERE. "No `fly` import or type outside
// `lib/orchestrator/adapters/fly/`" ships as `orchestratorPortBoundary.test.ts`
// — a dependency guard that already carries its OWN mutation check ("the guard
// actually detects a leak"). Restating it here would be a second, weaker copy of
// a guard that is already total; the story gate's job is the coverage that does
// not exist, not a louder version of coverage that does.
//
// What is real: Postgres, every service, the intent table and its RLS contexts,
// the admission lock's `FOR UPDATE`, the claim's compare-and-set, the rate
// table, the period rollups, the reconciliation. What is faked: GitHub (global
// `fetch`), the Inngest transport, and the ORCHESTRATOR — via the `fake`
// adapter, which is production code selected by env exactly as a deployment
// selects Fly (ADR §4 rule 2 ships it for this file).

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const WEBHOOK_SECRET = 'test-webhook-secret';

/** ⚠️ RELATIVE to now, never a pinned calendar instant — boot latency is
 *  `startedAt - queuedAt` against the wall clock, so a hardcoded date reads as a
 *  FUTURE instant on any machine whose clock sits before it and clamps the
 *  latency to zero. */
const QUEUED_AT = new Date(Date.now() - 5_000);

/** Supervision at test speed: the REAL loop, tiny deadlines. Mocking the clock
 *  would test a different program. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

/** One RSA key for the file — a 2048-bit pair per test costs more than every
 *  assertion in it. */
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const RUN_COMPLETED_AT = new Date('2026-07-30T12:00:00.000Z');

interface GithubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let githubCalls: GithubCall[];
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;
let captured: { events: CapturedJobEvent[]; restore: () => void };
/** The `workflow_run` jobs payload the minute meter reads. Set per test. */
let jobsBody: unknown;
let mintedRunnerSeq = 0;
/** What motir-ai reports for the org's credit balance. Zero + past the pool is
 *  the `ci_credits_exhausted` state the gate's third limb refuses on. */
let creditBalance = 1_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mintCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.url.includes('generate-jitconfig'));
}

/** Every `runner_group_id` a JIT mint asked for, in order — the value §7.3 is
 *  about. */
function mintedGroupIds(): number[] {
  return mintCalls().map((c) => Number(c.body?.['runner_group_id']));
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  githubRepoId: string;
  /** The mirror row's PROVIDER id — what a delivery carries. */
  providerRepoId: string;
  installationId: string;
  repoName: string;
}

let tenantSeq = 0;

/**
 * A tenant shaped like a real Motir-created project repo by the time its CI
 * queues: an installation, a mirrored repo in Motir's org, a repo-set row
 * realizing it, and (unless the test is about its absence) a runner group.
 *
 * `runnerGroupId` is written directly here for the cases that are NOT about
 * establishment; the seam test below provisions it through the REAL
 * `projectRunnerGroupService` instead, which is the whole point of that test.
 */
async function seedTenant(
  options: { withRunnerGroup?: boolean; withProjectRepo?: boolean; isMeta?: boolean } = {},
): Promise<Fixture> {
  tenantSeq += 1;
  const suffix = `${tenantSeq}-${randomInt(1_000_000)}`;
  const installationId = String(55_900 + tenantSeq);
  const providerRepoId = String(99_900 + tenantSeq);
  const repoName = `acme-web-${tenantSeq}`;

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
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  if (options.withRunnerGroup !== false) {
    await db.project.update({
      where: { id: project.id },
      data: {
        // Deliberately NEVER 1: the `Default` group is what §7.3 forbids, and a
        // fixture that used it would make the guard below unfalsifiable.
        runnerGroupId: 7_000 + tenantSeq,
        runnerGroupName: `motir-project-${project.id}`,
        runnerGroupSyncedAt: new Date(),
      },
    });
  }

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: MOTIR_ORG, accountType: 'Organization' },
    // `archived` is REQUIRED on `NormalizedRepo` (MOTIR-1959) — a liveness fact
    // distinct from every permission the seam carries.
    repos: [
      { providerRepoId, owner: MOTIR_ORG, name: repoName, defaultBranch: 'main', archived: false },
    ],
  });
  const githubRepo = await db.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });

  if (options.withProjectRepo !== false) {
    await db.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: 'web',
        name: repoName,
        // ESTABLISHED — the state the runner group's access list is derived
        // from. A `proposed` row names no repository that exists, so a fixture
        // that left the default would make §2.2's access-list assertion vacuous.
        state: 'created',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: githubRepo.id,
      },
    });
  }

  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    githubRepoId: githubRepo.id,
    providerRepoId,
    installationId,
    repoName,
  };
}

/** A `workflow_job` delivery shaped like GitHub's own. */
function delivery(
  fx: Fixture,
  overrides: { labels?: string[]; jobId?: number; runId?: number; action?: string } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? 'queued',
    workflow_job: {
      id: overrides.jobId ?? 44_900 + tenantSeq,
      run_id: overrides.runId ?? 7_900 + tenantSeq,
      run_attempt: 1,
      name: 'build',
      workflow_name: 'CI',
      status: 'queued',
      labels: overrides.labels ?? [MOTIR_RUNNER_LABEL],
      started_at: QUEUED_AT.toISOString(),
    },
    repository: {
      id: Number(fx.providerRepoId),
      name: fx.repoName,
      owner: { login: MOTIR_ORG },
    },
    installation: { id: Number(fx.installationId) },
  };
}

/** Drive a raw delivery through the webhook the way the route does. */
function handle(payload: Record<string, unknown>) {
  return githubWebhookService.handleEvent('workflow_job', payload);
}

/** The intent ids the hot path dispatched boots for, in order. */
function dispatchedIntentIds(): string[] {
  return captured.events
    .filter((e) => e.name === 'system.ci-runner-boot')
    .map((e) => (e.data as { intentId: string }).intentId);
}

/** Run the supervised boot to a COMPLETED job — the happy path, driven through
 *  the real loop by finishing the container on its first poll. */
function runToCompletion(intentId: string) {
  return ciRunnerBootService.runIntent(intentId, {
    ...FAST,
    sleep: async () => {
      const live = fakeOrchestrator.liveContainerIds();
      if (live[0]) fakeOrchestrator.completeJob(live[0]);
    },
  });
}

async function statusOf(intentId: string): Promise<string> {
  const row = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intentId } });
  return row.status;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_workflow_run_usage", "ci_period_usage", "ci_container_usage", "ci_container_period_cost", "fleet_in_flight_slot" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fakeOrchestrator.reset();
  githubCalls = [];
  mintedRunnerSeq = 0;
  jobsBody = null;
  creditBalance = 1_000;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
  runnerGroups = createRunnerGroupFake(MOTIR_ORG);

  // The fleet is CONFIGURED and this is a CLOUD deployment — the two conditions
  // the whole path is gated on. The fake adapter is selected exactly as a
  // deployment selects Fly.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', WEBHOOK_SECRET);
  // Generous by default: the caps are asserted where a test sets them, never by
  // accident from a default that happens to bind.
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '50');
  vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '20');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  captured = captureJobEvents();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: GithubCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      githubCalls.push(call);

      const group = await runnerGroups.handle(call.url, call.method, call.body);
      if (group) return group;

      // The org's FLEET RUNNER VARIABLE (MOTIR-2015) — establishing a repository
      // now ensures `MOTIR_RUNNER`, so this suite's GitHub has to know about those
      // endpoints too. The service swallows its own failures by contract, so an
      // unfaked call here would be INVISIBLE rather than loud: green, silent, and
      // no longer describing what the product does.
      const variable = actionsVariables.handle(call.url, call.method, call.body);
      if (variable) return variable;

      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json(200, { id: 556677 });
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (call.url.includes('generate-jitconfig')) {
        mintedRunnerSeq += 1;
        return json(201, {
          runner: { id: 9_000 + mintedRunnerSeq, name: `motir-runner-${mintedRunnerSeq}` },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      // The minute meter's workflow-jobs read.
      if (call.url.includes('/actions/runs/')) return json(200, jobsBody ?? { jobs: [] });
      // The CREDIT BALANCE, on the other side of the open-core boundary. Stubbed
      // because a balance is by definition over there; the STATE derived from it
      // is the shipped `getEntitlementState`'s, never re-derived here.
      if (call.url.includes('/v1/usage')) return json(200, { balance: creditBalance });
      // De-registration and anything else benign.
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  captured.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// ════════════════════════════════════════════════════════════════════════════
// §2 · INTEGRATION SEAMS — real output through real consumers
// ════════════════════════════════════════════════════════════════════════════

describe('§2.1 — one queued job walks the WHOLE pipeline to a cost row', () => {
  it('webhook → intent → gate → boot → container-seconds → the persisted cost row and rollup', async () => {
    const fx = await seedTenant();

    // 1 · The delivery. The webhook records the intent AND dispatches its boot
    // in the same request (MOTIR-1920 + MOTIR-1996).
    const result = await handle(delivery(fx, { jobId: 51_001, runId: 61_001 }));
    expect(result).toEqual({ event: 'workflow_job', outcome: 'recorded' });

    const intentIds = dispatchedIntentIds();
    expect(intentIds).toHaveLength(1);
    const intentId = intentIds[0]!;

    const intent = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(intent).toMatchObject({
      status: 'pending',
      jobId: '51001',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    // 2 · The boot. The gate admits and claims, the JIT config is minted for the
    // project's own group, one container runs and is destroyed.
    const outcome = await runToCompletion(intentId);
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(await statusOf(intentId)).toBe('completed');

    // 3 · THE SEAM THE UNITS CANNOT SEE. The §5 record the orchestrator emitted
    // is the row MOTIR-1924 persisted — same handle, same attribution, same job
    // id — reached through the real sink, not handed to the meter by a test.
    const usage = outcome.outcome === 'settled' ? outcome.usage : null;
    expect(usage).not.toBeNull();

    const rows = await db.ciContainerUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      containerProvider: 'fake',
      handleId: usage!.handleId,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      // The job id survives the whole chain — delivery → intent → spec →
      // attribution → usage → row. A drift anywhere in it lands here.
      workflowJobId: '51001',
      repoFullName: `${MOTIR_ORG}/${fx.repoName}`,
      workload: 'ci',
      teardownReason: 'job_completed',
    });

    // And the org's period rollup was incremented in the SAME transaction — the
    // margin readout's half of the record.
    const rollups = await db.ciContainerPeriodCost.findMany();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      organizationId: fx.organizationId,
      containerCount: 1,
    });
    expect(rollups[0]!.containerSeconds).toBe(rows[0]!.billableSeconds);
  });

  it('a GATE REFUSAL stops the pipeline before the cost row — no mint, no container, no row', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();

    await handle(delivery(fx, { jobId: 51_002, runId: 61_002 }));
    const intentId = dispatchedIntentIds()[0]!;

    const outcome = await ciRunnerBootService.runIntent(intentId, FAST);

    expect(outcome).toMatchObject({ outcome: 'gate_deferred', reason: 'fleet_ceiling' });
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await db.ciContainerUsage.count()).toBe(0);
    expect(await db.ciContainerPeriodCost.count()).toBe(0);
    // Deferred, never failed: the intent waits for the next sweep.
    expect(await statusOf(intentId)).toBe('pending');
  });
});

describe('§2.2 — establishment → the PERSISTED runner group → the JIT mint', () => {
  it('mints against the id the establishment sync actually persisted, not a literal', async () => {
    // No group yet: this test provisions one through the REAL service.
    const fx = await seedTenant({ withRunnerGroup: false });

    const sync = await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });
    expect(sync.outcome).toBe('synced');
    const created = runnerGroups.onlyGroup();

    // The value GitHub minted, as Motir persisted it. Neither card's own units
    // can see this hop: MOTIR-1972's stop at the column, MOTIR-1921's start from
    // a fixture.
    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.runnerGroupId).toBe(created.id);

    await handle(delivery(fx, { jobId: 52_001, runId: 62_001 }));
    await runToCompletion(dispatchedIntentIds()[0]!);

    expect(mintedGroupIds()).toEqual([created.id]);
    // …and the group GitHub holds access-lists exactly this project's repo set,
    // which is what makes the label unambiguous for the runner just minted.
    const repo = await db.githubRepo.findUniqueOrThrow({ where: { id: fx.githubRepoId } });
    expect(created.repositoryIds).toEqual([Number(repo.repoId)]);
  });

  it('two projects mint against two DIFFERENT persisted groups', async () => {
    const a = await seedTenant({ withRunnerGroup: false });
    const b = await seedTenant({ withRunnerGroup: false });
    for (const fx of [a, b]) {
      await projectRunnerGroupService.syncForProject({
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
      });
    }

    await handle(delivery(a, { jobId: 52_002, runId: 62_002 }));
    await handle(delivery(b, { jobId: 52_003, runId: 62_003 }));
    for (const intentId of dispatchedIntentIds()) await runToCompletion(intentId);

    const [groupA, groupB] = await Promise.all(
      [a, b].map(
        async (fx) =>
          (await db.project.findUniqueOrThrow({ where: { id: fx.projectId } })).runnerGroupId,
      ),
    );
    expect(groupA).not.toBe(groupB);
    expect(mintedGroupIds().sort()).toEqual([groupA, groupB].sort());
  });
});

describe('§2.3 — a fleet job lands on the FLEET side of the reconciliation', () => {
  it('the REAL minute meter and the REAL cost meter agree the run was the fleet, not GitHub-hosted', async () => {
    const fx = await seedTenant();

    // 1 · The customer-facing meter, driven for real: the run's jobs carry the
    // fleet label, so `classifyRunner` files them under `motir_fleet` and
    // MOTIR-1923's ×1.00 row prices them. Nothing here writes a breakdown by
    // hand — a family-name or breakdown-key drift is exactly what this catches.
    const startedAt = new Date('2026-07-30T11:00:00.000Z');
    jobsBody = {
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          started_at: startedAt.toISOString(),
          completed_at: new Date(startedAt.getTime() + 6 * 60_000).toISOString(),
          labels: [MOTIR_RUNNER_LABEL],
          run_attempt: 1,
        },
      ],
    };
    const metered = await ciMinutesMeterService.meterWorkflowRun(
      {
        providerRepoId: fx.providerRepoId,
        runId: 'run-fleet-1',
        attempt: 1,
        repoOwner: MOTIR_ORG,
        repoName: fx.repoName,
        workflowName: 'CI',
        completedAt: RUN_COMPLETED_AT,
      },
      fx.installationId,
    );
    expect(metered.outcome).toBe('metered');

    // 2 · Motir's own COGS record for the container that served it, through the
    // real cost meter.
    await handle(delivery(fx, { jobId: 53_001, runId: 63_001 }));
    const boot = await runToCompletion(dispatchedIntentIds()[0]!);
    expect(boot.outcome).toBe('settled');
    // The container's cost lands in the run's month, so the audit compares like
    // with like.
    await db.ciContainerUsage.updateMany({
      data: { periodStart: JULY_2026, containerStoppedAt: RUN_COMPLETED_AT },
    });

    // 3 · THE CLASSIFICATION. The metered minutes are on the FLEET side…
    const split = await ciMinutesReconciliationService.hostingSplitForMonth(JULY_2026);
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ repoName: fx.repoName, fleetMinutes: 6, fleetJobCount: 1 });
    expect(split[0]!.githubHostedMinutes).toBe(0);

    // …and therefore NOT in the GitHub-billed population, which is the §Q.1
    // failure this split exists to prevent (~100% phantom drift, every month).
    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([]);

    // 4 · The fleet audit sees both sides and reports no drift.
    const audit = await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026);
    expect(audit.outcome).toBe('reconciled');
    if (audit.outcome !== 'reconciled') throw new Error('unreachable');
    expect(audit.discrepancies).toEqual([]);
    expect(audit.repos).toHaveLength(1);
    expect(audit.repos[0]).toMatchObject({ repoName: fx.repoName, containerCount: 1 });
  });

  it('a GitHub-hosted run in the same repo stays on the GitHub side — the split is per breakdown entry', async () => {
    const fx = await seedTenant();
    const startedAt = new Date('2026-07-30T11:00:00.000Z');
    jobsBody = {
      total_count: 1,
      jobs: [
        {
          id: 2,
          name: 'build',
          started_at: startedAt.toISOString(),
          completed_at: new Date(startedAt.getTime() + 4 * 60_000).toISOString(),
          labels: ['ubuntu-latest'],
          run_attempt: 1,
        },
      ],
    };
    await ciMinutesMeterService.meterWorkflowRun(
      {
        providerRepoId: fx.providerRepoId,
        runId: 'run-hosted-1',
        attempt: 1,
        repoOwner: MOTIR_ORG,
        repoName: fx.repoName,
        workflowName: 'CI',
        completedAt: RUN_COMPLETED_AT,
      },
      fx.installationId,
    );

    const split = await ciMinutesReconciliationService.hostingSplitForMonth(JULY_2026);
    expect(split[0]).toMatchObject({ githubHostedMinutes: 4, fleetMinutes: 0, fleetJobCount: 0 });
    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: fx.repoName, billableMinutes: 4 },
    ]);

    // The fleet audit ignores it entirely — a purely GitHub-hosted repo must not
    // appear as a fleet row with zero containers.
    const audit = await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026);
    if (audit.outcome !== 'reconciled') throw new Error('expected a reconciled audit');
    expect(audit.repos).toEqual([]);
  });

  it('the fleet FAMILY the meter writes is the one the audit queries — no second spelling', async () => {
    // A cheap totality check on the constant both halves key off: the meter
    // stores the family on the row, the audit's SQL compares against it, and two
    // literals that agree today are not one constant (MOTIR-1964's lesson, one
    // layer over).
    const fx = await seedTenant();
    const startedAt = new Date('2026-07-30T11:00:00.000Z');
    jobsBody = {
      total_count: 1,
      jobs: [
        {
          id: 3,
          name: 'build',
          started_at: startedAt.toISOString(),
          completed_at: new Date(startedAt.getTime() + 60_000).toISOString(),
          labels: [MOTIR_RUNNER_LABEL],
          run_attempt: 1,
        },
      ],
    };
    await ciMinutesMeterService.meterWorkflowRun(
      {
        providerRepoId: fx.providerRepoId,
        runId: 'run-family-1',
        attempt: 1,
        repoOwner: MOTIR_ORG,
        repoName: fx.repoName,
        workflowName: 'CI',
        completedAt: RUN_COMPLETED_AT,
      },
      fx.installationId,
    );

    const row = await db.ciWorkflowRunUsage.findFirstOrThrow();
    const families = (row.runnerBreakdown as Array<{ family: string }>).map((e) => e.family);
    expect(families).toEqual([MOTIR_FLEET_RUNNER_FAMILY]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3 · CONTRACT GUARDS — what a coverage percentage cannot see
// ════════════════════════════════════════════════════════════════════════════

describe('§3.1 — LABEL SCOPING IS TOTAL: a job that is not ours provisions NOTHING', () => {
  /**
   * The story's highest-consequence failure, and the one a percentage will never
   * catch: `workflow_job.queued` fires for GitHub-HOSTED jobs too, on every repo
   * the App is installed on. A listener that reacted to event RECEIPT would
   * silently migrate Motir's own 31-job CI onto the fleet it is still building.
   *
   * So the negative case is enumerated rather than sampled — including the
   * shapes a naive `includes`/`startsWith` gate would wave through.
   */
  const NOT_OURS: Array<{ name: string; labels: string[] }> = [
    { name: 'the GitHub-hosted default', labels: ['ubuntu-latest'] },
    { name: 'NO labels at all', labels: [] },
    { name: "GitHub's own self-hosted defaults", labels: ['self-hosted', 'linux', 'x64'] },
    {
      name: 'a SUPERSTRING that merely contains the fleet label',
      labels: [`${MOTIR_RUNNER_LABEL}-preview`],
    },
    {
      name: 'a label the fleet label is a superstring OF',
      labels: ['motir'],
    },
    { name: 'a same-shaped label for someone else', labels: ['acme-runner', 'ubuntu-22.04'] },
    { name: 'blank labels', labels: ['', '   '] },
  ];

  for (const shape of NOT_OURS) {
    it(`emits NO intent, NO boot and NO container for ${shape.name}`, async () => {
      const fx = await seedTenant();

      const result = await handle(
        delivery(fx, { labels: shape.labels, jobId: 54_001, runId: 64_001 }),
      );

      // A deliberate no-op, never an error: the delivery is ACKED and the gate
      // says why, so GitHub is not made to retry a job there was nothing to do
      // for.
      expect(result).toEqual({ event: 'workflow_job', outcome: 'not_fleet_job' });
      expect(await db.ciRunnerProvisioningIntent.count()).toBe(0);
      expect(dispatchedIntentIds()).toEqual([]);
      expect(mintCalls()).toEqual([]);
      expect(fakeOrchestrator.provisioned).toEqual([]);
    });
  }

  // The positive control. Without it every assertion above would still pass
  // against a gate that refuses EVERYTHING — the vacuous-totality trap.
  const OURS: Array<{ name: string; labels: string[] }> = [
    { name: 'the label alone', labels: [MOTIR_RUNNER_LABEL] },
    { name: 'the label beside others', labels: ['self-hosted', MOTIR_RUNNER_LABEL] },
    { name: 'the label in another case', labels: [MOTIR_RUNNER_LABEL.toUpperCase()] },
    { name: 'the label with surrounding whitespace', labels: [` ${MOTIR_RUNNER_LABEL} `] },
  ];

  for (const shape of OURS) {
    it(`DOES provision for ${shape.name}`, async () => {
      const fx = await seedTenant();

      await handle(delivery(fx, { labels: shape.labels, jobId: 54_002, runId: 64_002 }));

      expect(await db.ciRunnerProvisioningIntent.count()).toBe(1);
      expect(dispatchedIntentIds()).toHaveLength(1);
    });
  }
});

describe('§3.2 — EXACTLY ONE usage row per provisioned handle, on every path', () => {
  it('the happy path records one row', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 55_001, runId: 65_001 }));
    await runToCompletion(dispatchedIntentIds()[0]!);

    const rows = await db.ciContainerUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teardownReason).toBe('job_completed');
  });

  it('a container that NEVER STARTS still records exactly one row — at zero seconds', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    await handle(delivery(fx, { jobId: 55_002, runId: 65_002 }));

    const outcome = await ciRunnerBootService.runIntent(dispatchedIntentIds()[0]!, FAST);
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });

    const rows = await db.ciContainerUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teardownReason: 'provision_failed', billableSeconds: 0 });
    // Zero seconds is not zero ROWS: "a container with no usage row is a bug
    // with a name" (§5), and a failed boot is exactly where that is tempting.
    expect(new Prisma.Decimal(rows[0]!.costUsd).toNumber()).toBe(0);
  });

  it('a REAPED orphan records exactly one row', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 55_003, runId: 65_003 }));
    const intentId = dispatchedIntentIds()[0]!;

    // Boot, then lose the supervisor: the container is left running and the
    // intent stays in flight — the ONE case a `finally` cannot cover.
    fakeOrchestrator.setBootBehaviour('hang');
    const admitted = await ciRunnerAdmissionService.admit(
      await db.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intentId } }),
    );
    expect(admitted.outcome).toBe('admitted');
    const intent = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    const handleRef = await fakeOrchestrator.provision(
      ciRunnerBootService.buildSpec({
        intent,
        workflowJobId: Number(intent.jobId),
        projectId: fx.projectId,
        encodedJitConfig: 'ZW5jb2RlZC1qaXQ=',
        timeoutSeconds: 60,
        orchestrator: fakeOrchestrator,
      }),
    );
    await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.recordBoot(
        intentId,
        {
          containerProvider: handleRef.provider,
          containerId: handleRef.id,
          containerRegion: handleRef.region,
          githubRunnerId: 9_555,
          runnerName: 'motir-orphan',
          bootedAt: new Date(),
        },
        tx,
      ),
    );
    fakeOrchestrator.backdate(handleRef.id, new Date(Date.now() - 60 * 60_000));

    const reap = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });
    expect(reap.reaped).toBe(1);

    const rows = await db.ciContainerUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handleId: handleRef.id, teardownReason: 'reaped' });

    // …and a SECOND reap of the same container adds nothing. Both the `finally`
    // and the reaper can reach one handle; the row is per handle, not per call.
    await ciRunnerBootService.reapOrphans({ olderThan: new Date() });
    expect(await db.ciContainerUsage.count()).toBe(1);
  });

  it('a reaper arriving AFTER the supervised teardown adds no second row', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 55_004, runId: 65_004 }));
    await runToCompletion(dispatchedIntentIds()[0]!);
    expect(await db.ciContainerUsage.count()).toBe(1);

    // Nothing is left to reap, and the sweep is inert rather than duplicating.
    const reap = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });
    expect(reap.reaped).toBe(0);
    expect(await db.ciContainerUsage.count()).toBe(1);
  });

  it('a provision that THREW leaves no handle and therefore no row — and no leak', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.failNextProvision('the provider refused');
    await handle(delivery(fx, { jobId: 55_005, runId: 65_005 }));

    const outcome = await ciRunnerBootService.runIntent(dispatchedIntentIds()[0]!, FAST);
    expect(outcome.outcome).toBe('provision_failed');

    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    // No container was ever provisioned, so there is no handle to account for —
    // the invariant is per PROVISIONED handle, and honouring it here means
    // writing nothing rather than writing a row about nothing.
    expect(await db.ciContainerUsage.count()).toBe(0);
  });
});

describe('§3.3 — NO RUNNER REUSE', () => {
  it('every provisioned handle is distinct, and a completed one never comes back', async () => {
    const fx = await seedTenant();

    for (const n of [1, 2, 3]) {
      await handle(delivery(fx, { jobId: 56_000 + n, runId: 66_000 + n }));
    }
    const intentIds = dispatchedIntentIds();
    expect(intentIds).toHaveLength(3);
    for (const intentId of intentIds) {
      expect((await runToCompletion(intentId)).outcome).toBe('settled');
    }

    const handles = fakeOrchestrator.provisioned.map((h) => h.id);
    expect(handles).toHaveLength(3);
    // STRUCTURAL, not observed on a happy path: three jobs, three containers,
    // no id ever seen twice.
    expect(new Set(handles).size).toBe(3);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    // One usage row per handle, and their handle ids are the three booted.
    const rows = await db.ciContainerUsage.findMany({ orderBy: { handleId: 'asc' } });
    expect(rows.map((r) => r.handleId).sort()).toEqual([...handles].sort());
  });

  it('re-running a SETTLED intent boots nothing — the claim is not re-takeable', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 56_010, runId: 66_010 }));
    const intentId = dispatchedIntentIds()[0]!;
    await runToCompletion(intentId);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    // A redelivered boot event, a duplicated sweep, an operator re-fire: the
    // compare-and-set refuses, so a completed job can never get a second runner.
    const again = await ciRunnerBootService.runIntent(intentId, FAST);

    expect(again).toEqual({ outcome: 'already_claimed' });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(mintCalls()).toHaveLength(1);
    expect(await db.ciContainerUsage.count()).toBe(1);
  });
});

describe('§3.4 — the GATE is consulted BEFORE provision, on all three limbs', () => {
  /** The three refusals, each asserted to spend NOTHING: no JIT mint (which
   *  registers a runner at GitHub), no container, no cost row. */
  it('the PER-PROJECT cap refuses before anything is spent', async () => {
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '1');
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 57_001, runId: 67_001 }));
    await handle(delivery(fx, { jobId: 57_002, runId: 67_002 }));
    const [first, second] = dispatchedIntentIds();

    // The first occupies the project's single slot by staying in flight.
    expect(
      (
        await ciRunnerAdmissionService.admit(
          await db.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: first! } }),
        )
      ).outcome,
    ).toBe('admitted');

    const outcome = await ciRunnerBootService.runIntent(second!, FAST);

    expect(outcome).toMatchObject({ outcome: 'gate_deferred', reason: 'project_cap' });
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await db.ciContainerUsage.count()).toBe(0);
  });

  it('the FLEET-WIDE ceiling refuses before anything is spent', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 57_003, runId: 67_003 }));

    const outcome = await ciRunnerBootService.runIntent(dispatchedIntentIds()[0]!, FAST);

    expect(outcome).toMatchObject({ outcome: 'gate_deferred', reason: 'fleet_ceiling' });
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('CI_CREDITS_EXHAUSTED refuses before anything is spent, and gives the slot back', async () => {
    const fx = await seedTenant();
    // Past the 1,000-minute pool floor AND no credits — the shipped
    // `getEntitlementState`'s own definition of exhausted, not a re-derivation.
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
          billableMinutes: 1_500,
          rawWallClockSeconds: 1_500 * 60,
          linearEquivalentMinutes: 1_500,
        },
        tx,
      ),
    );
    vi.stubEnv('MOTIR_AI_URL', 'https://motir-ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    // Past the pool AND no credits. Past the pool ALONE is `drawing_on_credits`,
    // which boots — conflating the two would block orgs still inside their
    // allowance, so the fixture has to say both.
    creditBalance = 0;
    await handle(delivery(fx, { jobId: 57_004, runId: 67_004 }));
    const intentId = dispatchedIntentIds()[0]!;

    const outcome = await ciRunnerBootService.runIntent(intentId, FAST);

    expect(outcome).toMatchObject({ outcome: 'gate_deferred', reason: 'ci_credits_exhausted' });
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await db.ciContainerUsage.count()).toBe(0);
    // The slot is RELEASED — an exhausted org's queue must not squeeze paying
    // tenants out of the fleet.
    expect(await statusOf(intentId)).toBe('pending');
    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    );
    expect(inFlight).toBe(0);
  });

  it('the CREDIT limb holds under REAL concurrency — N racers, zero runners', async () => {
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
          billableMinutes: 1_500,
          rawWallClockSeconds: 1_500 * 60,
          linearEquivalentMinutes: 1_500,
        },
        tx,
      ),
    );
    vi.stubEnv('MOTIR_AI_URL', 'https://motir-ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    // Past the pool AND no credits. Past the pool ALONE is `drawing_on_credits`,
    // which boots — conflating the two would block orgs still inside their
    // allowance, so the fixture has to say both.
    creditBalance = 0;
    for (const n of [1, 2, 3, 4] as const) {
      await handle(delivery(fx, { jobId: 57_100 + n, runId: 67_100 + n }));
    }
    const intents = await db.ciRunnerProvisioningIntent.findMany();
    expect(intents).toHaveLength(4);

    const verdicts = await Promise.all(
      intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
    );

    expect(verdicts.every((v) => v.outcome === 'deferred')).toBe(true);
    expect(
      verdicts.filter((v) => v.outcome === 'deferred' && v.reason === 'ci_credits_exhausted'),
    ).toHaveLength(4);
    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    );
    expect(inFlight).toBe(0);
  });
});

describe('§3.5 — the admission LOCK is load-bearing: an executable mutation check', () => {
  /**
   * The card requires this DEMONSTRATED, not asserted in prose.
   *
   * `notes.html` #35 is the class: the caps are read-derived writes — *count what
   * is in flight → decide → claim* — and a SERIAL test passes against an
   * implementation with no lock at all. The shipped suites carry a genuine
   * `Promise.all` race, which is necessary but still not sufficient: a race that
   * happens to serialize on a cold pool is green either way. What proves the
   * lock is load-bearing is showing the SAME race break when it is removed.
   *
   * So the mutation is applied here rather than described: `lockScope` is
   * replaced with a function that reports success WITHOUT taking `FOR UPDATE` —
   * precisely the diff "delete the lock" would produce — and the ceiling is
   * observed to be exceeded. Both directions run in one file, so neither can rot
   * without the other noticing.
   *
   * The barrier is what makes it deterministic in both directions. Every racer
   * waits, inside its own transaction, until all of them have reached the count
   * or a short grace elapses:
   *   * WITH the lock, they cannot be inside together — each waits out the grace
   *     and the ceiling still binds exactly. Slower, never wrong.
   *   * WITHOUT it, they arrive together, the barrier releases at once, every one
   *     of them reads the same pre-claim count, and all of them admit.
   */
  const RACERS = 4;
  const CEILING = 1;
  /** Long enough that the unlocked racers reliably meet; short enough that the
   *  locked run is not slow. Never a correctness knob — see above. */
  const GRACE_MS = 250;

  function meetingBarrier(expected: number) {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async function arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= expected) release();
      await Promise.race([all, new Promise((r) => setTimeout(r, GRACE_MS))]);
    };
  }

  async function raceForSlots(): Promise<number> {
    const tenants = await Promise.all(
      Array.from({ length: RACERS }, () => seedTenant({ withProjectRepo: true })),
    );
    const intents = await Promise.all(
      tenants.map((fx, i) =>
        db.ciRunnerProvisioningIntent.create({
          data: {
            workspaceId: fx.workspaceId,
            organizationId: fx.organizationId,
            projectId: fx.projectId,
            installationId: fx.installationId,
            runId: `race-${i}`,
            runAttempt: 1,
            jobId: `race-job-${i}`,
            jobName: 'build',
            workflowName: 'CI',
            repoOwner: MOTIR_ORG,
            repoName: fx.repoName,
            requestedLabels: [MOTIR_RUNNER_LABEL],
            queuedAt: QUEUED_AT,
            status: 'pending',
          },
        }),
      ),
    );

    const arrive = meetingBarrier(RACERS);
    const realCount = ciRunnerProvisioningIntentRepository.countInFlightFleetWide.bind(
      ciRunnerProvisioningIntentRepository,
    );
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'countInFlightFleetWide').mockImplementation(
      async (tx) => {
        await arrive();
        return realCount(tx);
      },
    );

    const verdicts = await Promise.all(
      intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
    );
    return verdicts.filter((v) => v.outcome === 'admitted').length;
  }

  it('WITH the lock, a race over one slot admits exactly one', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', String(CEILING));

    expect(await raceForSlots()).toBe(CEILING);

    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    );
    expect(inFlight).toBe(CEILING);
  });

  it('WITHOUT the lock, the SAME race overruns the ceiling — the guard is real', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', String(CEILING));
    // THE MUTATION: report the scope as locked without ever taking `FOR UPDATE`.
    // Every other line of the gate is untouched.
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(true);

    const admitted = await raceForSlots();

    expect(admitted).toBeGreaterThan(CEILING);
    const inFlight = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
    );
    expect(inFlight).toBe(admitted);
  });
});

describe('§3.6 — the JIT mint NAMES THE PROJECT’S OWN GROUP, or refuses', () => {
  it('never mints against the `Default` group (id 1)', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 58_001, runId: 68_001 }));
    await runToCompletion(dispatchedIntentIds()[0]!);

    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(mintedGroupIds()).toEqual([project.runnerGroupId]);
    // §7.3's forbidden value, named explicitly: `Default` is id 1 with
    // `visibility: "all"`, and provisioning into it restores exactly the
    // cross-tenant pickup the per-project group exists to prevent — including
    // for a job the admission gate DECLINED.
    expect(mintedGroupIds()).not.toContain(1);
  });

  it('REFUSES a project with no persisted group rather than defaulting', async () => {
    const fx = await seedTenant({ withRunnerGroup: false });
    await handle(delivery(fx, { jobId: 58_002, runId: 68_002 }));
    const intentId = dispatchedIntentIds()[0]!;

    const outcome = await ciRunnerBootService.runIntent(intentId, FAST);

    expect(outcome.outcome).toBe('no_runner_group');
    // Nothing was minted, so no runner was registered at GitHub — the failure is
    // free, which is what makes refusing better than defaulting.
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await statusOf(intentId)).toBe('failed');
  });

  it('mints EXACTLY the one fleet label — never GitHub’s defaults', async () => {
    const fx = await seedTenant();
    await handle(
      delivery(fx, { labels: ['self-hosted', MOTIR_RUNNER_LABEL], jobId: 58_003, runId: 68_003 }),
    );
    await runToCompletion(dispatchedIntentIds()[0]!);

    // The job ASKED for `self-hosted` too; the runner is still registered with
    // the single §M label, because a runner carrying `self-hosted` would match
    // some unrelated tenant's `runs-on: self-hosted` — §7.3's cross-tenant
    // pickup arriving through the label axis instead of the group axis.
    expect(mintCalls()[0]!.body?.['labels']).toEqual([MOTIR_RUNNER_LABEL]);
    const spec = fakeOrchestrator.specs[0]!;
    expect(spec.env['ACTIONS_RUNNER_CONFIG_ARGS']).toBe('--no-default-labels');
    expect(spec.env['MOTIR_RUNNER_LABEL']).toBe(MOTIR_RUNNER_LABEL);
  });
});

describe('§3.7 — CROSS-TENANT ISOLATION: one org’s state never decides another’s', () => {
  it('an EXHAUSTED org does not refuse a healthy org’s job', async () => {
    const broke = await seedTenant();
    const paying = await seedTenant();
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: broke.workspaceId,
          organizationId: broke.organizationId,
          periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
          billableMinutes: 1_500,
          rawWallClockSeconds: 1_500 * 60,
          linearEquivalentMinutes: 1_500,
        },
        tx,
      ),
    );
    vi.stubEnv('MOTIR_AI_URL', 'https://motir-ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    // Past the pool AND no credits. Past the pool ALONE is `drawing_on_credits`,
    // which boots — conflating the two would block orgs still inside their
    // allowance, so the fixture has to say both.
    creditBalance = 0;

    await handle(delivery(broke, { jobId: 59_001, runId: 69_001 }));
    await handle(delivery(paying, { jobId: 59_002, runId: 69_002 }));
    const [brokeIntent, payingIntent] = await db.ciRunnerProvisioningIntent.findMany({
      orderBy: { jobId: 'asc' },
    });

    expect(await ciRunnerAdmissionService.admit(brokeIntent!)).toMatchObject({
      outcome: 'deferred',
      reason: 'ci_credits_exhausted',
    });
    expect((await ciRunnerAdmissionService.admit(payingIntent!)).outcome).toBe('admitted');
  });

  it('one org at its PROJECT cap does not consume another org’s allowance', async () => {
    vi.stubEnv('MOTIR_FLEET_PROJECT_CAP_FREE', '1');
    const a = await seedTenant();
    const b = await seedTenant();
    await handle(delivery(a, { jobId: 59_003, runId: 69_003 }));
    await handle(delivery(a, { jobId: 59_004, runId: 69_004 }));
    await handle(delivery(b, { jobId: 59_005, runId: 69_005 }));
    const intents = await db.ciRunnerProvisioningIntent.findMany({ orderBy: { jobId: 'asc' } });

    const first = await ciRunnerAdmissionService.admit(intents[0]!);
    const second = await ciRunnerAdmissionService.admit(intents[1]!);
    const other = await ciRunnerAdmissionService.admit(intents[2]!);

    expect(first.outcome).toBe('admitted');
    expect(second).toMatchObject({ outcome: 'deferred', reason: 'project_cap' });
    // B is a different org with its own allowance: A filling its cap must not
    // reach across.
    expect(other.outcome).toBe('admitted');
  });

  it('a container booted for org A is metered to A, and A’s row is invisible to B', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await handle(delivery(a, { jobId: 59_006, runId: 69_006 }));
    await runToCompletion(dispatchedIntentIds()[0]!);

    const rows = await db.ciContainerUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
    });
    expect(rows[0]!.organizationId).not.toBe(b.organizationId);

    // The rollup the margin readout reads is per org, so B's is untouched.
    const costB = await db.ciContainerPeriodCost.findMany({
      where: { organizationId: b.organizationId },
    });
    expect(costB).toEqual([]);
  });
});

describe('§3.8 — the REGISTRATION-TOKEN path is not merely unused, it is absent', () => {
  /**
   * §7.4 replaced the org-wide registration token with a JIT config, and the
   * card's acceptance says no test may assert the token path. The stronger
   * statement — and the one worth a guard — is that no PRODUCTION code can reach
   * it: a caller cannot reach for what is not there.
   */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  /** Strip line and block comments, so a doc comment EXPLAINING why the endpoint
   *  is not used does not read as a call to it. */
  function executableCode(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('nothing under lib/ or app/ calls the org registration-token endpoint', () => {
    const offenders: string[] = [];
    for (const dir of ['lib', 'app']) {
      for (const file of sourceFiles(join(process.cwd(), dir))) {
        if (/registration-token/.test(executableCode(readFileSync(file, 'utf8')))) {
          offenders.push(file.replace(`${process.cwd()}/`, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard would FIRE on a real reintroduction (mutation check)', () => {
    const reintroduced = `
      const res = await fetch(
        \`\${GITHUB_API}/orgs/\${org}/actions/runners/registration-token\`,
        { method: 'POST' },
      );
    `;
    expect(/registration-token/.test(executableCode(reintroduced))).toBe(true);
    // …and it does NOT fire on the prose that explains the choice.
    expect(
      /registration-token/.test(
        executableCode('// POST /orgs/{org}/actions/runners/registration-token is forbidden'),
      ),
    ).toBe(false);
  });

  it('the shipped boot path mints a JIT config and nothing else', async () => {
    const fx = await seedTenant();
    await handle(delivery(fx, { jobId: 59_100, runId: 69_100 }));
    await runToCompletion(dispatchedIntentIds()[0]!);

    expect(mintCalls()).toHaveLength(1);
    expect(githubCalls.some((c) => c.url.includes('registration-token'))).toBe(false);
  });
});
