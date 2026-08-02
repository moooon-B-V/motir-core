import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import * as orchestrator from '@/lib/orchestrator';
import { OrchestratorNotConfiguredError } from '@/lib/orchestrator/errors';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables } from '../helpers/db';

// THE PROVISIONER against real Postgres (Story MOTIR-1916 · MOTIR-1921).
//
// This is where the card's acceptance criteria are answered, and they are almost
// all about what is TRUE AFTER a failure: the container is gone, the runner is
// de-registered, the intent tells the truth about which path it took. Boot
// working is the easy half.
//
// What is real here: Postgres, the intent table and its RLS contexts, the claim's
// concurrency guard, `projectRunnerGroupService`'s refusal, and the whole
// service. What is faked: GitHub (`fetch`) and the orchestrator (the `fake`
// adapter, selected by env exactly as a deployment would select Fly — the
// adapter is production code, not a test double bolted on).
//
// ⚠️ SUPERVISION IS DRIVEN WITH TINY DEADLINES, not with fake timers. The real
// loop polls and sleeps; passing millisecond deadlines exercises the SAME code
// paths at speed, whereas mocking the clock would test a different program.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
/** GitHub's queue instant for the seeded job, RELATIVE to now.
 *
 * ⚠️ NOT a hardcoded calendar instant. Boot latency is measured as
 * `startedAt - queuedAt` against the wall clock, so a pinned date is a time bomb:
 * it reads as a plausible past instant on the day it is written and as a FUTURE
 * one from any machine whose clock sits before it — which clamps the latency to
 * zero and fails a test the code never broke. */
const QUEUED_AT = new Date(Date.now() - 5_000);

/** Supervision, at test speed. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

interface GithubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let githubCalls: GithubCall[];
/** Override the JIT mint / delete answers per test. */
let jitHandler: (call: GithubCall) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mintCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.url.includes('generate-jitconfig'));
}

function deleteRunnerCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.method === 'DELETE' && /\/actions\/runners\/\d+$/.test(c.url));
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { withRunnerGroup?: boolean; email?: string } = {}) {
  const email = options.email ?? `fleet-boot-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${Math.floor(Math.random() * 900 + 100)}`,
  });
  if (options.withRunnerGroup !== false) {
    await db.project.update({
      where: { id: project.id },
      data: {
        runnerGroupId: RUNNER_GROUP_ID,
        runnerGroupName: `motir-project-${project.id}`,
        runnerGroupSyncedAt: new Date(),
      },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  } satisfies Fixture;
}

/** One pending intent, exactly as MOTIR-1920's handler writes it. */
async function seedIntent(
  fx: Fixture,
  overrides: { jobId?: string; projectId?: string | null } = {},
) {
  return db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: overrides.jobId ?? String(44000 + Math.floor(Math.random() * 900)),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: QUEUED_AT,
      status: 'pending',
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  githubCalls = [];
  jitHandler = (call) => {
    if (call.url.includes('generate-jitconfig')) {
      return json(201, {
        runner: { id: 9001, name: 'motir-runner', status: 'offline' },
        encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
      });
    }
    return new Response(null, { status: 204 });
  };

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  // Select the FAKE adapter the same way a deployment selects Fly.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: GithubCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      githubCalls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: 556677 });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return jitHandler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the happy path — ONE intent produces ONE ephemeral runner', () => {
  it("mints a JIT config for the PROJECT's group with exactly the fleet label, boots one container, and destroys it", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      // Simulate the job finishing right after the first poll — the runner takes
      // its one job, de-registers and exits, and `auto_destroy` removes the
      // machine.
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome.outcome).toBe('settled');
    expect(outcome).toMatchObject({ reason: 'job_completed' });

    // ONE mint, naming the project's group and the single §M label (§7.3/§7.4).
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({
      runner_group_id: RUNNER_GROUP_ID,
      labels: [MOTIR_RUNNER_LABEL],
    });
    // No registration token is minted anywhere on this card.
    expect(githubCalls.some((c) => c.url.includes('registration-token'))).toBe(false);

    // EXACTLY ONE container, and it is GONE.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: fakeOrchestrator.provisioned[0]!.id, reason: 'job_completed' },
    ]);

    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('completed');
    expect(settled.teardownReason).toBe('job_completed');
    expect(settled.containerProvider).toBe('fake');
    expect(settled.containerId).toBe(fakeOrchestrator.provisioned[0]!.id);
    expect(settled.githubRunnerId).toBe(9001);
    expect(settled.settledAt).not.toBeNull();
  });

  it('the container spec carries `--no-default-labels` and the single fleet label', async () => {
    // The card's acceptance criterion, asserted on what the boot ASKS FOR. The
    // real guarantee is the JIT config's `labels` array (above); this is the
    // second, independent statement of it — the one that still holds if the
    // runner image ever falls back to a `config.sh` path, where GitHub WOULD add
    // `self-hosted`/`Linux`/`X64`.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');
    await ciRunnerBootService.runIntent(intent.id, FAST);

    const spec = fakeOrchestrator.specs[0]!;
    expect(spec.env['ACTIONS_RUNNER_CONFIG_ARGS']).toBe('--no-default-labels');
    expect(spec.env['MOTIR_RUNNER_LABEL']).toBe(MOTIR_RUNNER_LABEL);
    expect(spec.env['ACTIONS_RUNNER_INPUT_JITCONFIG']).toBe('ZW5jb2RlZC1qaXQ=');
    expect(spec.size).toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 8192 });
  });

  it("RECORDS BOOT LATENCY, measured from GitHub's own queue instant", async () => {
    // ADR §6's budget made measurable rather than aspirational — MOTIR-1928
    // measures the real p50/p95 against it, and this is what makes that a query.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.bootLatencyMs).not.toBeNull();
    expect(settled.startedAt).not.toBeNull();
    // Measured from `queuedAt`, not from the boot: the span a USER experiences.
    // A window, never an equality — different clocks, different stamp sites.
    const expected = Date.now() - QUEUED_AT.getTime();
    expect(settled.bootLatencyMs!).toBeGreaterThan(0);
    expect(settled.bootLatencyMs!).toBeLessThanOrEqual(expected + 5_000);
  });

  it('emits a costed container-seconds record attributed to the org', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    // The §5 record rides out on the outcome, which is the job's return value
    // and therefore the `job_run` ledger row — the durable, queryable home for
    // it until MOTIR-1924's table lands.
    expect(outcome.outcome).toBe('settled');
    expect((outcome as Extract<typeof outcome, { outcome: 'settled' }>).usage).toMatchObject({
      orgId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName: `${MOTIR_ORG}/acme-web`,
      teardownReason: 'job_completed',
      // The rate came from the effective-dated table, not a constant in code.
      usdPerSecond: '0.000031636049',
      cpuKind: 'performance',
    });
  });
});

describe('§7.3 — a project with NO runner group is REFUSED', () => {
  it('refuses to provision, and never reaches for the `Default` group', async () => {
    // The card's acceptance criterion. Falling back to `Default` (id 1,
    // `visibility: all`) would silently restore the cross-tenant pickup the
    // per-project group exists to prevent.
    const fx = await seedTenant({ withRunnerGroup: false });
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('no_runner_group');
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    // Nothing anywhere named group 1.
    expect(
      githubCalls.some((c) => JSON.stringify(c.body ?? {}).includes('"runner_group_id":1')),
    ).toBe(false);

    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.failureDetail).toContain('no runner group');
  });

  it('refuses an intent that names no project at all', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { projectId: null });
    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);
    expect(outcome.outcome).toBe('no_runner_group');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('every failure path destroys the container — one test each', () => {
  it('BOOT REFUSED: no container exists, and the minted JIT runner is DE-REGISTERED', async () => {
    // ⚠️ The card's "minted-but-unused JIT config" criterion.
    // `generate-jitconfig` REGISTERS the runner before any container exists
    // (§7.4, verified), so a boot that never happens leaves a dangling runner
    // unless this path cleans it up — GitHub does not.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.failNextProvision();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(deleteRunnerCalls()).toHaveLength(1);
    expect(deleteRunnerCalls()[0]!.url).toMatch(/\/actions\/runners\/9001$/);

    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('provision_failed');
    // The runner id was persisted BEFORE the boot, which is what makes the
    // crash-in-this-window case recoverable at all.
    expect(settled.githubRunnerId).toBe(9001);
  });

  it('NEVER REGISTERED: a container that never starts is destroyed at the boot deadline', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: fakeOrchestrator.provisioned[0]!.id, reason: 'provision_failed' },
    ]);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    // It never ran, so it costs nothing — but it still produced a row.
    expect(outcome).toMatchObject({ billableSeconds: 0, costUsd: '0' });
  });

  it('HUNG PAST THE TIMEOUT: a container that starts and never stops is killed', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 40,
      jobTimeoutMs: 30,
      pollIntervalMs: 1,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.teardownReason).toBe('job_timed_out');
    // It DID run, so it costs something — the customer's hung job is Motir's
    // container-seconds either way.
    expect((outcome as { billableSeconds: number }).billableSeconds).toBeGreaterThanOrEqual(0);
  });

  it('a TRANSIENT provider blip does NOT kill a healthy job', async () => {
    // ⚠️ Without read tolerance, one 500 from the provider ends a customer's CI
    // run mid-test for a reason that has nothing to do with their code. The
    // first read fails; the run must survive it and settle normally.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const describe = vi.spyOn(fakeOrchestrator, 'describe');
    describe.mockRejectedValueOnce(new Error('502 from the provider'));

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('SUPERVISION CRASHED: a provider read that keeps throwing still tears the container down', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const describeSpy = vi
      .spyOn(fakeOrchestrator, 'describe')
      .mockRejectedValue(new Error('provider unreachable'));

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    describeSpy.mockRestore();
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.failureDetail).toContain('provider unreachable');
  });

  it('TEARDOWN ITSELF FAILED: the intent is LEFT IN FLIGHT for the reaper, not marked settled', async () => {
    // ⚠️ The one case where "tidy up the row" would be actively harmful. Marking
    // it settled would hide a container that may still be running from the one
    // mechanism that can still catch it.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');
    fakeOrchestrator.failNextTeardown();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    const stuck = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stuck.status).toBe('running');
    expect(stuck.settledAt).toBeNull();
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });

  it('a malformed job id fails the intent before anything is spent', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { jobId: 'not-a-number' });
    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);
    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('the registration ceiling releases the claim rather than failing the job', () => {
  it('returns `rate_limited` and puts the intent back in the PENDING pool', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) =>
      call.url.includes('generate-jitconfig')
        ? json(403, { message: 'secondary rate limit' }, { 'retry-after': '25' })
        : new Response(null, { status: 204 });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: 25 });
    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    // Back to pending: the next sweep retries it, which is a retry that costs
    // nothing. Failing it would drop a job GitHub is genuinely waiting on.
    expect(after.status).toBe('pending');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('the CLAIM is the concurrency guard', () => {
  it('two concurrent runs of the same intent boot exactly ONE container', async () => {
    // ⚠️ MUTATION CHECK: delete the `status: 'pending'` predicate from
    // `claimPending` and this fails with two containers — which is a runner that
    // has no job to claim, idling to its timeout, billed to the tenant.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');

    const [a, b] = await Promise.all([
      ciRunnerBootService.runIntent(intent.id, FAST),
      ciRunnerBootService.runIntent(intent.id, FAST),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['already_claimed', 'settled']);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(mintCalls()).toHaveLength(1);
  });

  it('an unknown intent id is a named outcome, not a throw', async () => {
    expect(await ciRunnerBootService.runIntent('does-not-exist', FAST)).toEqual({
      outcome: 'unknown_intent',
    });
  });

  it('an unconfigured deployment provisions nothing and claims nothing', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect(await ciRunnerBootService.runIntent(intent.id, FAST)).toEqual({
      outcome: 'not_configured',
    });
    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
  });
});

describe('the ADMISSION GATE is consulted BEFORE anything is spent (MOTIR-1922)', () => {
  // The wiring assertion, and the one that matters most: a cap that is decided
  // AFTER the JIT config is minted or the container is booted has already cost
  // the money it exists to save. So the assertion is not just the outcome — it
  // is that GitHub was never called and the orchestrator never provisioned.
  it('a fleet at its ceiling leaves the job QUEUED, with no mint and no container', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    // One runner already in flight — the fleet is full.
    await db.ciRunnerProvisioningIntent.update({
      where: { id: (await seedIntent(fx, { jobId: '90001' })).id },
      data: { status: 'running' },
    });
    const queued = await seedIntent(fx, { jobId: '90002' });

    const result = await ciRunnerBootService.runIntent(queued.id, FAST);

    expect(result).toMatchObject({ outcome: 'gate_deferred', reason: 'fleet_ceiling' });
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // PENDING, so the next sweep retries it — queued, never failed.
    const after = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(after.status).toBe('pending');
  });

  it('boots normally when the gate admits', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect((await ciRunnerBootService.runIntent(intent.id, FAST)).outcome).toBe('settled');
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('the REAPER — the backstop for the orchestrator crashing mid-flight', () => {
  it('finds and destroys an orphan the in-process path missed, and settles its intent', async () => {
    // ⚠️ THE CRASH IS SIMULATED FAITHFULLY: the container is booted and recorded,
    // and then the supervising call simply never happens — which is exactly what
    // a process dying between provision and teardown leaves behind. Nothing is
    // stubbed to make the reaper's job easier.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');

    // Boot + record, then "crash": abandon supervision by rejecting the very
    // first describe, and swallow the teardown so the container is left alive.
    fakeOrchestrator.failNextTeardown();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('process died'));
    await ciRunnerBootService.runIntent(intent.id, FAST);
    vi.restoreAllMocks();

    const orphanId = fakeOrchestrator.provisioned[0]!.id;
    expect(fakeOrchestrator.liveContainerIds()).toEqual([orphanId]);
    const inFlight = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(inFlight.status).toBe('running');

    // Age the container past the cutoff and sweep.
    fakeOrchestrator.backdate(orphanId, new Date(Date.now() - 3 * 3_600_000));
    const result = await ciRunnerBootService.reapOrphans({
      olderThan: new Date(Date.now() - 3_600_000),
    });

    expect(result.reaped).toBe(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('reaped');
  });

  it('leaves a container that is not yet old enough alone', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');
    fakeOrchestrator.failNextTeardown();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('process died'));
    await ciRunnerBootService.runIntent(intent.id, FAST);
    vi.restoreAllMocks();

    const result = await ciRunnerBootService.reapOrphans({
      olderThan: new Date(Date.now() - 3_600_000),
    });
    expect(result.reaped).toBe(0);
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });

  it('sweeps a CLAIMED-BUT-NEVER-BOOTED intent and de-registers its dangling runner', async () => {
    // The crash-between-mint-and-boot window. GitHub holds a registered runner
    // with no machine; the only thing that knows its id is the column written
    // before the boot.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    await db.ciRunnerProvisioningIntent.update({
      where: { id: intent.id },
      data: {
        status: 'provisioning',
        githubRunnerId: 9001,
        runnerName: 'motir-orphan',
        updatedAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const result = await ciRunnerBootService.reapOrphans();

    expect(result.staleClaims).toBe(1);
    expect(deleteRunnerCalls()).toHaveLength(1);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.failureDetail).toContain('de-registered');
  });

  it('is inert on a deployment with no orchestrator', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await ciRunnerBootService.reapOrphans()).toEqual({
      reaped: 0,
      staleClaims: 0,
      usages: [],
    });
  });
});

describe('the pending-intent seam', () => {
  it('lists pending intents oldest-QUEUED first, and nothing else', async () => {
    const fx = await seedTenant();
    const older = await seedIntent(fx, { jobId: '1' });
    await db.ciRunnerProvisioningIntent.update({
      where: { id: older.id },
      data: { queuedAt: new Date(QUEUED_AT.getTime() - 60_000) },
    });
    const newer = await seedIntent(fx, { jobId: '2' });
    const settledAlready = await seedIntent(fx, { jobId: '3' });
    await db.ciRunnerProvisioningIntent.update({
      where: { id: settledAlready.id },
      data: { status: 'completed' },
    });

    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([older.id, newer.id]);
  });

  it('is empty on a deployment with no orchestrator', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fx = await seedTenant();
    await seedIntent(fx);
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([]);
  });
});

// ── The remaining refusals, one test each ───────────────────────────────────

describe('the boot’s defensive paths', () => {
  it('runs on its REAL default deadlines when the caller passes none', async () => {
    // Every other test drives supervision with tiny deadlines, so the shipped
    // constants are never the values in force. Here only `sleep` is supplied —
    // the job finishes on the first poll, so the real 120s/3600s/3s defaults are
    // the ones the loop is built with and cannot have rotted into `undefined`.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    // 3600s is the hard kill §11 fixes, and it reaches the container's spec.
    expect(fakeOrchestrator.specs[0]?.timeoutSeconds).toBe(3600);
  });

  it('uses the REAL sleep between polls — a zero interval resolves rather than hanging', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);

    // No `sleep` override: the shipped `sleepFor` runs, and its zero-or-less
    // short-circuit is what keeps a tight poll loop from queueing a timer per
    // iteration.
    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 5,
      jobTimeoutMs: 20,
      pollIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('a container that goes TERMINAL WITHOUT EVER STARTING is a provisioning failure', async () => {
    // Distinct from the boot-deadline case above: the provider says the machine
    // is gone, and it never ran. "Boot succeeded but nothing came up" is a
    // provisioning failure even though `provision` returned successfully.
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(outcome).toMatchObject({ billableSeconds: 0 });
  });

  it('a provider that keeps failing PAST THE JOB TIMEOUT still ends the container', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    // One good read (so the container is seen RUNNING), then a provider that is
    // down. The deadlines still bind: a provider outage must not extend a
    // container past its timeout.
    let reads = 0;
    const realDescribe = fakeOrchestrator.describe.bind(fakeOrchestrator);
    vi.spyOn(fakeOrchestrator, 'describe').mockImplementation(async (handle) => {
      reads += 1;
      if (reads === 1) return realDescribe(handle);
      throw new Error('the provider is down');
    });

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 1_000,
      jobTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('reports a NON-ERROR provider rejection as `unknown` rather than losing it', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValue('the provider hung up');

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(outcome).toMatchObject({ detail: expect.stringContaining('unknown') });
    // The minted-but-unused runner is still de-registered — a dangling
    // registered runner is the cost of skipping this.
    expect(deleteRunnerCalls()).toHaveLength(1);
  });

  it('a JIT mint refused for a NON-rate-limit reason fails the intent, not the fleet', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) =>
      call.url.includes('generate-jitconfig')
        ? json(422, { message: 'runner group not found' })
        : new Response(null, { status: 204 });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(outcome).toMatchObject({
      detail: expect.stringContaining('could not mint a JIT config'),
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const settled = await db.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
  });

  it('an UNEXPECTED runner-group failure is refused too, with its own detail', async () => {
    // Not `RunnerGroupNotProvisionedError` — a read that broke. The refusal is
    // the same (never the `Default` group), but the operator needs to see which
    // of the two happened.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(projectRunnerGroupService, 'requireRunnerGroupId').mockRejectedValue(
      new Error('the project read failed'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'no_runner_group' });
    expect(outcome).toMatchObject({
      detail: expect.stringContaining("could not read the project's runner group"),
    });
    expect(mintCalls()).toEqual([]);
  });

  it('RELEASES the claim when the orchestrator disappears between the check and the call', async () => {
    // Both reads are at CALL time (`appAuth`'s contract), so they can disagree
    // across a redeploy. The claim must go back to the pool rather than pinning
    // an intent to an instance that cannot serve it.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(orchestrator, 'getOrchestrator').mockImplementation(() => {
      throw new OrchestratorNotConfiguredError('the fleet credentials went away');
    });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'not_configured' });
    expect(mintCalls()).toEqual([]);
    // Released, so a configured instance can take it.
    expect(
      (await db.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    ).toBe('pending');
  });

  it('LOGS and keeps going when the intent cannot be settled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'settle').mockRejectedValue(
      new Error('the settle write failed'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    // The CONTAINER is what costs money, and it is gone. A bookkeeping failure
    // must not propagate out of the path that guarantees that.
    expect(outcome.outcome).toBe('settled');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it('LOGS and keeps going when de-registration fails — the runner may dangle, the container does not', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockRejectedValue(
      new Error('GitHub refused the delete'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome.outcome).toBe('settled');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });
});

describe('the REAPER’s attribution resolver refuses what it cannot attribute', () => {
  /** Boot a container OUTSIDE the supervised path, so it is left running for the
   *  reaper to find — the crash-mid-flight shape. */
  async function orphan(
    fx: Fixture,
    overrides: { projectId?: string | null; jobId?: string; githubRunnerId?: number | null } = {},
  ) {
    const intent = await db.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
        installationId: '556677',
        runId: `orphan-${Math.random().toString(36).slice(2, 8)}`,
        runAttempt: 1,
        jobId: overrides.jobId ?? String(45_000 + Math.floor(Math.random() * 900)),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: QUEUED_AT,
        status: 'running',
      },
    });
    const handle = await fakeOrchestrator.provision(
      ciRunnerBootService.buildSpec({
        intent,
        workflowJobId: 1,
        projectId: fx.projectId,
        encodedJitConfig: 'jit',
        timeoutSeconds: 60,
        orchestrator: fakeOrchestrator,
      }),
    );
    await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.recordBoot(
        intent.id,
        {
          containerProvider: handle.provider,
          containerId: handle.id,
          containerRegion: handle.region,
          githubRunnerId: overrides.githubRunnerId === undefined ? 9_777 : overrides.githubRunnerId,
          runnerName: 'motir-orphan',
          bootedAt: new Date(),
        },
        tx,
      ),
    );
    fakeOrchestrator.backdate(handle.id, new Date(Date.now() - 60 * 60_000));
    return { intent, handle };
  }

  it('DESTROYS an orphan whose intent names no project, but emits no cost row for it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const { handle } = await orphan(fx, { projectId: null });

    const result = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });

    // An orphan Motir cannot attribute is still an orphan that BILLS, so it is
    // destroyed anyway; a row attributed to nobody would be worse than none.
    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handle.id);
    expect(result.reaped).toBe(0);
  });

  it('DESTROYS an orphan whose job id is malformed, and emits no cost row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const { handle } = await orphan(fx, { jobId: 'not-a-number' });

    const result = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });

    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handle.id);
    expect(result.reaped).toBe(0);
  });

  it('reaps an orphan with NO registered runner without calling GitHub', async () => {
    const fx = await seedTenant();
    await orphan(fx, { githubRunnerId: null });

    const result = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });

    expect(result.reaped).toBe(1);
    // Nothing to de-register: the crash happened before the mint, so there is no
    // runner id to name and no call to make.
    expect(deleteRunnerCalls()).toEqual([]);
  });

  it('settles nothing when the intent vanishes between the reap and the write-back', async () => {
    const fx = await seedTenant();
    await orphan(fx);
    // The row is deleted (a tenant teardown, a cascade) after the container was
    // destroyed. The sweep must not throw over a row that is already gone.
    const findByContainerId = vi.spyOn(ciRunnerProvisioningIntentRepository, 'findByContainerId');
    let call = 0;
    const real = findByContainerId.getMockImplementation();
    findByContainerId.mockImplementation(async (provider, containerId, tx) => {
      call += 1;
      if (call > 1) return null;
      return real
        ? real(provider, containerId, tx)
        : tx.ciRunnerProvisioningIntent.findFirst({
            where: { containerProvider: provider, containerId },
          });
    });

    const result = await ciRunnerBootService.reapOrphans({ olderThan: new Date() });

    expect(result.reaped).toBe(1);
    expect(deleteRunnerCalls()).toEqual([]);
  });
});
