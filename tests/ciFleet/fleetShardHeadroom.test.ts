import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import {
  GITHUB_SECONDARY_LIMITS,
  HEADROOM_ALERT_FRACTION,
  SUSTAINED_DEFERRAL_MIN_JOBS,
} from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { fleetShardHeadroomService, peakOverlap } from '@/lib/services/fleetShardHeadroomService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

// THE HEADROOM PASS (Story MOTIR-8953 · MOTIR-8969), against real Postgres with
// Sentry and `fetch` stubbed: compute from boot/settle intervals per account,
// GitHub limits per RUNNER org from the ledger, the installation's own REST
// budget, sustained deferral, moves, the one-issue fingerprint and pruning.

const NOW = new Date('2026-07-15T12:00:00.000Z');
const FALLBACK_ORG = 'motir-projects';
const TENANT_ORG = 'acme-host';
const MIN = 60_000;

let rateLimit: { limit: number; used: number } | 'fail';
let rateLimitTokens: string[];

interface Tenant {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Tenant> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `headroom-${suffix}-${randomToken(4)}@example.com`,
    password: 'hunter2hunter2',
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
    identifier: `H${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function intent(
  tenant: Tenant,
  data: Partial<{
    fleetShardId: string | null;
    bootedAt: Date | null;
    settledAt: Date | null;
    createdAt: Date;
    status: string;
    shardCapacityDeferredAt: Date | null;
    fleetShardMoveReason: 'capacity_refused' | 'provider_unavailable' | null;
  }>,
): Promise<void> {
  jobSeq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: TENANT_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: data.status ?? 'succeeded',
      fleetShardId: data.fleetShardId ?? null,
      bootedAt: data.bootedAt ?? null,
      settledAt: data.settledAt ?? null,
      createdAt: data.createdAt ?? new Date(NOW.getTime() - 10 * MIN),
      shardCapacityDeferredAt: data.shardCapacityDeferredAt ?? null,
      fleetShardMoveReason: data.fleetShardMoveReason ?? null,
    },
  });
}

async function account(
  overrides: Partial<{
    vcpuQuota: number | null;
    githubOrg: string;
    githubRegistrationsPer5Min: number | null;
    name: string;
  }> = {},
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: overrides.name ?? `acct-${slug}`,
      fleetKind: 'ci_runner',
      provider: 'fly',
      state: 'active',
      githubOrg: overrides.githubOrg ?? TENANT_ORG,
      githubInstallationId: '4321',
      flyOrg: 'motir',
      flyApp: `motir-ci-${slug}`,
      flyRegion: 'iad',
      machineLimit: 500,
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      vcpuQuota: overrides.vcpuQuota === undefined ? 100 : overrides.vcpuQuota,
      githubRegistrationsPer5Min:
        overrides.githubRegistrationsPer5Min === undefined
          ? 1500
          : overrides.githubRegistrationsPer5Min,
    },
  });
}

async function calls(
  org: string,
  kind: 'mint' | 'delete',
  count: number,
  at: (i: number) => Date,
  fleetShardId: string | null = null,
): Promise<void> {
  await adminDb.githubRunnerCallEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      githubOrg: org,
      kind,
      at: at(i),
      fleetShardId,
    })),
  });
}

function alerts(): Error[] {
  return captureException.mock.calls.map(([error]) => error as Error);
}

function alertsNamed(name: string): Array<Error & Record<string, unknown>> {
  return alerts().filter((e) => e.name === name) as Array<Error & Record<string, unknown>>;
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubRunnerCallEvent.deleteMany({});
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  captureException.mockReset();
  rateLimit = { limit: 15_000, used: 10 };
  rateLimitTokens = [];
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', FALLBACK_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const token = /\/app\/installations\/([^/]+)\/access_tokens$/.exec(u);
      if (token) {
        return json(200, {
          token: `ghs_${token[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (u.endsWith(`/orgs/${FALLBACK_ORG}/installation`)) return json(200, { id: 556677 });
      if (/\/orgs\/[^/]+\/installation$/.test(u)) return json(404, { message: 'Not Found' });
      if (u.endsWith('/rate_limit')) {
        const auth = (init?.headers as Record<string, string>)['authorization'] ?? '';
        rateLimitTokens.push(auth);
        if (rateLimit === 'fail') return json(502, { message: 'bad gateway' });
        return json(200, {
          resources: {
            core: { ...rateLimit, remaining: 0, reset: Math.floor(NOW.getTime() / 1000) + 600 },
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('peakOverlap', () => {
  it('counts touching intervals as overlapping and ignores inverted ones', () => {
    expect(peakOverlap([])).toBe(0);
    expect(
      peakOverlap([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(2);
    expect(
      peakOverlap([
        { start: 0, end: 5 },
        { start: 6, end: 9 },
      ]),
    ).toBe(1);
    expect(peakOverlap([{ start: 5, end: 1 }])).toBe(0);
  });
});

describe('compute, peak not sample, per account', () => {
  it('35 runners overlapping once in the window (only 20 in flight now) alert at 70 vCPU', async () => {
    const tenant = await seedTenant();
    const shard = await account({ vcpuQuota: 100 });
    const peakAt = NOW.getTime() - 3 * MIN;
    for (let i = 0; i < 35; i += 1) {
      await intent(tenant, {
        fleetShardId: shard.id,
        bootedAt: new Date(peakAt - 30_000),
        // 15 settled after the peak; 20 still running.
        settledAt: i < 15 ? new Date(peakAt + 30_000) : null,
        status: i < 15 ? 'succeeded' : 'running',
      });
    }

    const result = await fleetShardHeadroomService.run(NOW);

    const [error] = alertsNamed('ShardHeadroomExceededError');
    expect(alertsNamed('ShardHeadroomExceededError')).toHaveLength(1);
    expect(error).toMatchObject({ limit: 'vcpu', used: 70, capacity: 100 });
    expect(result.readings).toContainEqual(
      expect.objectContaining({ subject: { shardId: shard.id }, limit: 'vcpu', used: 70 }),
    );
  });

  it('34 overlapping (68 vCPU) raise nothing', async () => {
    const tenant = await seedTenant();
    const shard = await account({ vcpuQuota: 100 });
    for (let i = 0; i < 34; i += 1) {
      await intent(tenant, {
        fleetShardId: shard.id,
        bootedAt: new Date(NOW.getTime() - 2 * MIN),
        status: 'running',
      });
    }

    await fleetShardHeadroomService.run(NOW);

    expect(alertsNamed('ShardHeadroomExceededError')).toHaveLength(0);
  });

  it('two accounts at 72% and 30% alert once; readAccountHeadroom returns both', async () => {
    const tenant = await seedTenant();
    const hot = await account({ vcpuQuota: 50 });
    const cool = await account({ vcpuQuota: 20 });
    for (let i = 0; i < 18; i += 1) {
      await intent(tenant, {
        fleetShardId: hot.id,
        bootedAt: new Date(NOW.getTime() - MIN),
        status: 'running',
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await intent(tenant, {
        fleetShardId: cool.id,
        bootedAt: new Date(NOW.getTime() - MIN),
        status: 'running',
      });
    }

    await fleetShardHeadroomService.run(NOW);
    const readings = await fleetShardHeadroomService.readAccountHeadroom(NOW);

    expect(alertsNamed('ShardHeadroomExceededError').map((e) => e['shardName'])).toEqual([
      hot.name,
    ]);
    expect(readings).toEqual(
      expect.arrayContaining([
        { shardId: hot.id, fleetKind: 'ci_runner', usedVcpu: 36, vcpuQuota: 50, fraction: 0.72 },
        { shardId: cool.id, fleetKind: 'ci_runner', usedVcpu: 6, vcpuQuota: 20, fraction: 0.3 },
      ]),
    );
  });
});

describe('GitHub limits, keyed on the runner org', () => {
  it('70 mints across two accounts in 5 min alert once for the org, naming both', async () => {
    const a = await account({ githubRegistrationsPer5Min: 100, name: 'acct-a' });
    const b = await account({ githubRegistrationsPer5Min: 100, name: 'acct-b' });
    await calls(TENANT_ORG, 'mint', 40, (i) => new Date(NOW.getTime() - 4 * MIN + i * 1000), a.id);
    await calls(TENANT_ORG, 'mint', 30, (i) => new Date(NOW.getTime() - 4 * MIN + i * 1000), b.id);

    await fleetShardHeadroomService.run(NOW);

    const found = alertsNamed('GithubOrgHeadroomExceededError').filter(
      (e) => e['limit'] === 'registrations_per_5_min',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ org: TENANT_ORG, used: 70, capacity: 100 });
    expect(found[0]!['shardNames']).toEqual(['acct-a', 'acct-b'].sort());
  });

  it('the same 70 mints spread over 10 min raise nothing', async () => {
    await account({ githubRegistrationsPer5Min: 100 });
    await calls(TENANT_ORG, 'mint', 70, (i) => new Date(NOW.getTime() - 10 * MIN + i * 8_500));

    await fleetShardHeadroomService.run(NOW);

    expect(
      alertsNamed('GithubOrgHeadroomExceededError').filter(
        (e) => e['limit'] === 'registrations_per_5_min',
      ),
    ).toHaveLength(0);
  });

  it('reads the REST budget with the org installation token, and alerts at 70%', async () => {
    await account();
    rateLimit = { limit: 15_000, used: 10_500 };

    await fleetShardHeadroomService.run(NOW);

    expect(alertsNamed('GithubOrgHeadroomExceededError')).toEqual([
      expect.objectContaining({ org: TENANT_ORG, limit: 'api_per_hour', used: 10_500 }),
    ]);
    expect(rateLimitTokens).toContain('Bearer ghs_4321');
  });

  it('a failed REST-budget read is a failure, never a zero, and raises nothing', async () => {
    await account();
    rateLimit = 'fail';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fleetShardHeadroomService.run(NOW);

    expect(result.failures).toBe(1);
    expect(alertsNamed('GithubOrgHeadroomExceededError')).toHaveLength(0);
    expect(result.readings.some((r) => r.limit === 'api_per_hour')).toBe(false);
  });

  it.each(Object.values(GITHUB_SECONDARY_LIMITS))(
    'measures the secondary limit $name',
    async (limit) => {
      await account({ githubRegistrationsPer5Min: 1_000_000 });
      const needed = Math.ceil(HEADROOM_ALERT_FRACTION * limit.perPeriod);
      const kind = limit.countsCalls[limit.countsCalls.length - 1]!;
      await calls(TENANT_ORG, kind, needed, () => NOW);

      await fleetShardHeadroomService.run(NOW);

      expect(
        alertsNamed('GithubOrgHeadroomExceededError').filter((e) => e['limit'] === limit.name),
      ).toEqual([expect.objectContaining({ used: needed, capacity: limit.perPeriod })]);
    },
  );

  it('an org with no account row is measured against the documented defaults', async () => {
    await calls('someone-else', 'mint', 1_050, (i) => new Date(NOW.getTime() - 4 * MIN + i * 100));

    await fleetShardHeadroomService.run(NOW);

    const found = alertsNamed('GithubOrgHeadroomExceededError').find(
      (e) => e['org'] === 'someone-else' && e['limit'] === 'registrations_per_5_min',
    );
    expect(found).toMatchObject({ capacity: 1500, noAccountRow: true });
  });
});

describe('sustained deferral and moves, per kind, across tenants', () => {
  async function seedJobs(total: number, deferred: number): Promise<void> {
    const tenants = [await seedTenant(), await seedTenant()];
    for (let i = 0; i < total; i += 1) {
      await intent(tenants[i % 2]!, {
        createdAt: new Date(NOW.getTime() - 30 * MIN),
        shardCapacityDeferredAt: i < deferred ? new Date(NOW.getTime() - 29 * MIN) : null,
      });
    }
  }

  it('40 jobs with 10 deferred alert once, counting every tenant', async () => {
    await seedJobs(40, 10);

    const result = await fleetShardHeadroomService.run(NOW);

    expect(alertsNamed('SustainedDeferralError')).toEqual([
      expect.objectContaining({ fleetKind: 'ci_runner', deferred: 10, total: 40 }),
    ]);
    expect(result.readings).toContainEqual(
      expect.objectContaining({ subject: { fleetKind: 'ci_runner' }, used: 10, capacity: 40 }),
    );
  });

  it('40 jobs with 7 deferred, or 5 with 3, raise nothing', async () => {
    expect(SUSTAINED_DEFERRAL_MIN_JOBS).toBe(10);
    await seedJobs(40, 7);
    await fleetShardHeadroomService.run(NOW);
    expect(alertsNamed('SustainedDeferralError')).toHaveLength(0);

    await adminDb.ciRunnerProvisioningIntent.deleteMany({});
    await seedJobs(5, 3);
    await fleetShardHeadroomService.run(NOW);
    expect(alertsNamed('SustainedDeferralError')).toHaveLength(0);
  });

  it('moves are reported, not alerted', async () => {
    const tenant = await seedTenant();
    for (let i = 0; i < 15; i += 1) {
      await intent(tenant, { fleetShardMoveReason: 'capacity_refused' });
    }

    const result = await fleetShardHeadroomService.run(NOW);

    expect(result.moves['ci_runner']).toEqual({ capacity_refused: 15 });
    expect(alerts()).toHaveLength(0);
  });
});

describe('one issue per (subject, limit), and the pass survives its alert', () => {
  it('two passes produce two captures with one fingerprint; a throwing capture stops nothing', async () => {
    await account();
    rateLimit = { limit: 15_000, used: 14_000 };

    await fleetShardHeadroomService.run(NOW);
    await fleetShardHeadroomService.run(NOW);

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException.mock.calls[0]![1].fingerprint).toEqual([
      'fleet-shard-headroom',
      TENANT_ORG,
      'api_per_hour',
    ]);
    expect(captureException.mock.calls[1]![1].fingerprint).toEqual(
      captureException.mock.calls[0]![1].fingerprint,
    );

    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    const result = await fleetShardHeadroomService.run(NOW);
    expect(result.alerted).toBe(1);
  });
});

describe('pruning', () => {
  it('deletes ledger events older than 2 hours and keeps younger ones', async () => {
    await calls('old-org', 'mint', 2, () => new Date(NOW.getTime() - 121 * MIN));
    await calls('new-org', 'mint', 3, () => new Date(NOW.getTime() - 119 * MIN));

    await fleetShardHeadroomService.run(NOW);

    expect(await adminDb.githubRunnerCallEvent.count({ where: { githubOrg: 'old-org' } })).toBe(0);
    expect(await adminDb.githubRunnerCallEvent.count({ where: { githubOrg: 'new-org' } })).toBe(3);
  });
});
