import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  runnerJitConfigClient,
  RunnerJitTimeoutError,
  RUNNER_JIT_REQUEST_TIMEOUT_MS,
} from '@/lib/github/runnerJitConfig';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// A CONNECTED-ORG intent through the boot path (Story MOTIR-8699 · MOTIR-8711).
//
// Every runner the fleet mints or removes for a job whose repository is NOT in
// the provisioning org must act in THAT org, through the installation the intent
// recorded, in the runner group that lives there. Faked: GitHub (`fetch`) and the
// orchestrator (the `fake` adapter) — the `ciRunnerBootService.test.ts`
// convention. Real: Postgres, the intent table, `projectRunnerGroupService`'s
// group read and the whole service.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const PROVISIONING_INSTALLATION = '556677';
/** The connected org as a webhook echoes it — NOT lower-cased. */
const CONNECTED_ORG = 'moooon-B-V';
const CONNECTED_INSTALLATION = '778899';
const PROVISIONING_GROUP_ID = 5042;
const CONNECTED_GROUP_ID = 6061;
const QUEUED_AT = new Date(Date.now() - 5_000);
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

interface GithubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let githubCalls: GithubCall[];
let jitHandler: (call: GithubCall) => Response;
/** How the token endpoint answers for the CONNECTED installation. */
let connectedToken: 'ok' | 'unreachable' | number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const connectedRunners = `/orgs/${CONNECTED_ORG}/actions/runners`;

/** Every call that touched a runner — mint, list, delete. */
function runnerCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.url.includes('/actions/runners'));
}

function mintCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.url.includes('generate-jitconfig'));
}

function deleteRunnerCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.method === 'DELETE' && /\/actions\/runners\/\d+$/.test(c.url));
}

/** The provisioning installation was never looked up and never minted for. */
function expectProvisioningNeverResolved(): void {
  expect(githubCalls.some((c) => c.url.endsWith(`/orgs/${MOTIR_ORG}/installation`))).toBe(false);
  expect(
    githubCalls.some((c) => c.url.includes(`/installations/${PROVISIONING_INSTALLATION}/`)),
  ).toBe(false);
  expect(githubCalls.some((c) => c.url.includes(`/orgs/${MOTIR_ORG}/`))).toBe(false);
}

/** Every runner request went to the connected org, and a token was minted for
 *  the intent's installation. */
function expectActedInConnectedOrg(): void {
  const runners = runnerCalls();
  expect(runners.length).toBeGreaterThan(0);
  for (const call of runners) {
    expect(new URL(call.url).pathname.startsWith(connectedRunners)).toBe(true);
  }
  expect(
    githubCalls.some((c) =>
      c.url.includes(`/installations/${CONNECTED_INSTALLATION}/access_tokens`),
    ),
  ).toBe(true);
  expectProvisioningNeverResolved();
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { withConnectedGroup?: boolean } = {}): Promise<Fixture> {
  const email = `fleet-connected-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Motir',
    identifier: `M${randomInt(100, 1000)}`,
  });
  // The provisioning-org group exists too, so a path that read the WRONG org's
  // group would find one rather than fail — the agreement is what is asserted.
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: PROVISIONING_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  if (options.withConnectedGroup !== false) {
    await adminDb.projectRunnerGroup.create({
      data: {
        projectId: project.id,
        workspaceId: workspace.id,
        org: CONNECTED_ORG.toLowerCase(),
        installationId: CONNECTED_INSTALLATION,
        runnerGroupId: CONNECTED_GROUP_ID,
        runnerGroupName: `motir-project-${project.id}`,
        syncedAt: new Date(),
        syncPending: false,
      },
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
  data: { status?: string; githubRunnerId?: number | null; updatedAt?: Date } = {},
) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: CONNECTED_INSTALLATION,
      runId: `co-${randomToken(6)}`,
      runAttempt: 1,
      jobId: String(46_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: CONNECTED_ORG,
      repoName: 'motir-core',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: QUEUED_AT,
      status: data.status ?? 'pending',
      githubRunnerId: data.githubRunnerId ?? null,
      ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  githubCalls = [];
  connectedToken = 'ok';
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
        return json(200, { id: Number(PROVISIONING_INSTALLATION) });
      }
      if (call.url.includes('/access_tokens')) {
        if (call.url.includes(`/installations/${CONNECTED_INSTALLATION}/`)) {
          if (connectedToken === 'unreachable') throw new TypeError('fetch failed');
          if (typeof connectedToken === 'number') {
            return json(connectedToken, { message: 'Resource not accessible by integration' });
          }
        }
        return json(200, {
          token: 'ghs_installation',
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
  await adminDb.$disconnect();
});

describe("a connected-org intent's runner is minted and removed in THAT org", () => {
  it("reads the group in the intent's org, mints into it, and de-registers there on settle", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const groupRead = vi.spyOn(projectRunnerGroupService, 'requireRunnerGroupIdFor');

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    // The group read is keyed on the SAME value the runner target is.
    expect(groupRead).toHaveBeenCalledWith(
      { projectId: fx.projectId, workspaceId: fx.workspaceId },
      CONNECTED_ORG,
    );
    expect(await groupRead.mock.results[0]!.value).toBe(CONNECTED_GROUP_ID);
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({
      runner_group_id: CONNECTED_GROUP_ID,
      labels: [MOTIR_RUNNER_LABEL],
    });
    // The settle de-register.
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/9001`,
    ]);
    expectActedInConnectedOrg();
  });

  it('the provision-failure de-register acts in the connected org', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.failNextProvision();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/9001`,
    ]);
    expectActedInConnectedOrg();
  });

  it('a timed-out mint is cleaned up by name in the connected org', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const mint = vi
      .spyOn(runnerJitConfigClient, 'mint')
      .mockRejectedValue(new RunnerJitTimeoutError('mint', RUNNER_JIT_REQUEST_TIMEOUT_MS));
    jitHandler = (call) =>
      call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(200, {
            total_count: 1,
            runners: [{ id: 7734, name: `motir-${intent.id}`.slice(0, 64) }],
          });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    // The mint itself was asked for the connected org.
    expect(mint.mock.calls[0]![1]).toEqual({
      org: CONNECTED_ORG,
      installationId: CONNECTED_INSTALLATION,
      role: 'provisioning',
    });
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/7734`,
    ]);
    expectActedInConnectedOrg();
  });

  it("the reaper de-registers in the intent's org", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { status: 'running' });
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
          githubRunnerId: 9_777,
          runnerName: `motir-${intent.id}`,
          bootedAt: new Date(),
        },
        tx,
      ),
    );

    expect(await ciRunnerBootService.reapContainer(handle)).toBe(true);
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/9777`,
    ]);
    expectActedInConnectedOrg();
  });

  it("the stale-claim sweep de-registers in the intent's org", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: intent.id },
      data: {
        status: 'provisioning',
        githubRunnerId: 9001,
        runnerName: 'motir-orphan',
        updatedAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    expect(await ciRunnerBootService.sweepStaleClaims()).toBe(1);
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/9001`,
    ]);
    expectActedInConnectedOrg();
  });

  it("an admin stop de-registers in the intent's org", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { status: 'provisioning', githubRunnerId: 9_555 });

    await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `${connectedRunners}/9555`,
    ]);
    expectActedInConnectedOrg();
  });
});

describe('the refusals', () => {
  it('a connected org with no group settles provision_failed, names the org, and mints nothing', async () => {
    const fx = await seedTenant({ withConnectedGroup: false });
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'no_runner_group' });
    expect(outcome).toMatchObject({ detail: expect.stringContaining(CONNECTED_ORG) });
    expect(mintCalls()).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('provision_failed');
  });

  it('GitHub UNREACHABLE minting the org token releases the claim as rate_limited', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    connectedToken = 'unreachable';

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
    expect(mintCalls()).toEqual([]);
    expectProvisioningNeverResolved();
  });

  it.each([403, 404])(
    'a REFUSED org token (HTTP %i) settles provision_failed naming the org, installation and status',
    async (status) => {
      const fx = await seedTenant();
      const intent = await seedIntent(fx);
      connectedToken = status;

      const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

      expect(outcome.outcome).toBe('provision_failed');
      const detail = (outcome as { detail: string }).detail;
      expect(detail).toContain(CONNECTED_ORG);
      expect(detail).toContain(CONNECTED_INSTALLATION);
      expect(detail).toContain(String(status));
      expect(detail).not.toContain('ghs_');
      expect(mintCalls()).toEqual([]);
      const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(settled.status).toBe('failed');
      expectProvisioningNeverResolved();
    },
  );
});

describe('replay compatibility', () => {
  it('a session memoised before runnerTarget existed de-registers through the default', async () => {
    // A provisioning-org job, booted, then its session stripped of the new field
    // — the shape a memoised pre-MOTIR-8711 session replays with.
    const fx = await seedTenant();
    jobSeq += 1;
    const intent = await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        projectId: fx.projectId,
        installationId: PROVISIONING_INSTALLATION,
        runId: `old-${randomToken(6)}`,
        runAttempt: 1,
        jobId: String(47_000 + jobSeq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: QUEUED_AT,
        status: 'pending',
      },
    });
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    expect(booted.session.runnerTarget).toBeNull();
    const { runnerTarget: _dropped, ...legacy } = JSON.parse(JSON.stringify(booted.session));
    fakeOrchestrator.completeJob(booted.session.handle.id);
    const verdict = await ciRunnerBootService.pollOnce(legacy, undefined, FAST);
    if (!verdict.done) throw new Error('unreachable');

    githubCalls = [];
    await ciRunnerBootService.settleSupervision(legacy, verdict, FAST);

    expect(deleteRunnerCalls().map((c) => new URL(c.url).pathname)).toEqual([
      `/orgs/${MOTIR_ORG}/actions/runners/9001`,
    ]);
  });
});
